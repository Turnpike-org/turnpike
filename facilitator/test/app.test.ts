import { Keypair } from "@stellar/stellar-sdk";
import type { Express } from "express";
import pino from "pino";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { assertSupportedIsTruthful, createApp, FEES_ARE_SPONSORED } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const facilitatorSecret = Keypair.random().secret();
const facilitatorAddress = Keypair.fromSecret(facilitatorSecret).publicKey();

const config = loadConfig({ FACILITATOR_SECRET_KEY: facilitatorSecret } as NodeJS.ProcessEnv);
const silentLogger = pino({ level: "silent" });

let app: Express;

/**
 * A structurally valid request body. The signed transaction is nonsense on
 * purpose — these tests cover the HTTP surface, not the chain.
 *
 * @param overrides - Fields to replace on the requirements
 * @returns A verify/settle request body
 */
function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const paymentRequirements = {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: "100000",
    payTo: Keypair.random().publicKey(),
    maxTimeoutSeconds: 120,
    extra: {},
    ...overrides,
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: paymentRequirements,
      payload: { transaction: "AAAAAgAAnot-a-real-transaction" },
    },
    paymentRequirements,
  };
}

beforeAll(() => {
  app = createApp(config, silentLogger).app;
});

describe("GET /supported", () => {
  it("advertises the exact scheme on stellar:testnet with a truthful extra block", async () => {
    const response = await request(app).get("/supported");

    expect(response.status).toBe(200);
    const kind = response.body.kinds.find(
      (k: { scheme: string; network: string }) =>
        k.scheme === "exact" && k.network === "stellar:testnet",
    );
    expect(kind).toBeDefined();
    expect(kind.x402Version).toBe(2);
    expect(kind.extra).toHaveProperty("areFeesSponsored");
    expect(typeof kind.extra.areFeesSponsored).toBe("boolean");
    expect(kind.extra.areFeesSponsored).toBe(FEES_ARE_SPONSORED);
  });

  it("publishes the facilitator's signing address", async () => {
    const response = await request(app).get("/supported");
    expect(Object.values(response.body.signers).flat()).toContain(facilitatorAddress);
  });

  it("does not advertise mainnet", async () => {
    const response = await request(app).get("/supported");
    const networks = response.body.kinds.map((k: { network: string }) => k.network);
    expect(networks).not.toContain("stellar:pubnet");
  });
});

describe("assertSupportedIsTruthful", () => {
  it("passes for the real /supported payload", () => {
    const { facilitator } = createApp(config, silentLogger);
    expect(() =>
      assertSupportedIsTruthful(facilitator.getSupported(), "stellar:testnet"),
    ).not.toThrow();
  });

  it("rejects a missing stellar entry", () => {
    expect(() =>
      assertSupportedIsTruthful({ kinds: [], extensions: [], signers: {} }, "stellar:testnet"),
    ).toThrow(/does not advertise/);
  });

  it("rejects a non-boolean areFeesSponsored", () => {
    expect(() =>
      assertSupportedIsTruthful(
        {
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "stellar:testnet",
              extra: { areFeesSponsored: "yes" },
            },
          ],
          extensions: [],
          signers: {},
        },
        "stellar:testnet",
      ),
    ).toThrow(/boolean/);
  });

  it("rejects an advertisement that contradicts the deployment", () => {
    expect(() =>
      assertSupportedIsTruthful(
        {
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: "stellar:testnet",
              extra: { areFeesSponsored: !FEES_ARE_SPONSORED },
            },
          ],
          extensions: [],
          signers: {},
        },
        "stellar:testnet",
      ),
    ).toThrow(/but this deployment sponsors fees/);
  });
});

describe("GET /health", () => {
  it("reports the network and fee-sponsorship posture", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      network: "stellar:testnet",
      facilitator: facilitatorAddress,
      areFeesSponsored: FEES_ARE_SPONSORED,
    });
  });
});

describe("rejection paths always carry a reason", () => {
  const malformedBodies: [string, unknown][] = [
    ["empty object", {}],
    ["null body", null],
    ["array body", []],
    ["missing paymentRequirements", { paymentPayload: requestBody().paymentPayload }],
    ["missing paymentPayload", { paymentRequirements: requestBody().paymentRequirements }],
    [
      "payload without transaction",
      {
        paymentPayload: { x402Version: 2, accepted: {}, payload: {} },
        paymentRequirements: requestBody().paymentRequirements,
      },
    ],
    ["requirements with a non-contract asset", requestBody({ asset: "USDC" })],
    ["requirements with a decimal amount", requestBody({ amount: "0.01" })],
    ["requirements with a bad payTo", requestBody({ payTo: "alice@example.com" })],
    ["requirements missing maxTimeoutSeconds", requestBody({ maxTimeoutSeconds: undefined })],
  ];

  for (const [label, body] of malformedBodies) {
    it(`POST /verify rejects ${label} with a populated reason`, async () => {
      const response = await request(app).post("/verify").send(body as object);

      expect(response.status).toBe(400);
      expect(response.body.isValid).toBe(false);
      expect(response.body.invalidReason).toBeTruthy();
      expect(String(response.body.invalidReason).length).toBeGreaterThan(0);
      expect(String(response.body.invalidMessage).trim().length).toBeGreaterThan(10);
    });

    it(`POST /settle rejects ${label} with a populated reason`, async () => {
      const response = await request(app).post("/settle").send(body as object);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.errorReason).toBeTruthy();
      expect(String(response.body.errorMessage).trim().length).toBeGreaterThan(10);
      expect(response.body.transaction).toBe("");
    });
  }

  it("POST /verify explains an unsupported network instead of returning a bare 500", async () => {
    const response = await request(app)
      .post("/verify")
      .send(requestBody({ network: "solana:mainnet" }));

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(false);
    expect(response.body.invalidReason).toBe("unsupported_scheme_or_network");
    expect(response.body.invalidMessage).toContain("exact");
  });

  it("POST /verify explains an unsupported scheme", async () => {
    const response = await request(app).post("/verify").send(requestBody({ scheme: "upto" }));

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(false);
    expect(response.body.invalidReason).toBe("unsupported_scheme_or_network");
  });

  it("POST /settle explains an unsupported network with a populated errorReason", async () => {
    const response = await request(app)
      .post("/settle")
      .send(requestBody({ network: "solana:mainnet" }));

    expect(response.body.success).toBe(false);
    expect(response.body.errorReason).toBe("unsupported_scheme_or_network");
    expect(String(response.body.errorMessage).length).toBeGreaterThan(10);
  });

  it("returns an explanatory 404 for unknown endpoints", async () => {
    const response = await request(app).get("/resources");
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("not_found");
    expect(response.body.message).toContain("/verify");
  });
});
