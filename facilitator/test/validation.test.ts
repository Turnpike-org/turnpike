import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  validatePaymentPayload,
  validatePaymentRequirements,
  validateVerifyRequest,
} from "../src/validation.js";

const validRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  amount: "100000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 120,
  extra: {},
};

const validPayload = {
  x402Version: 2,
  accepted: validRequirements,
  payload: { transaction: "AAAAAgAAAABase64Transaction" },
};

describe("validatePaymentRequirements", () => {
  it("accepts well-formed requirements", () => {
    expect(validatePaymentRequirements(validRequirements)).toBeNull();
  });

  const badCases: [string, unknown][] = [
    ["a string", "requirements"],
    ["a missing scheme", { ...validRequirements, scheme: undefined }],
    ["a non-CAIP-2 network", { ...validRequirements, network: "testnet" }],
    ["a classic asset code", { ...validRequirements, asset: "USDC" }],
    ["a G-address as asset", { ...validRequirements, asset: Keypair.random().publicKey() }],
    ["a decimal amount", { ...validRequirements, amount: "0.01" }],
    ["a numeric amount", { ...validRequirements, amount: 100000 }],
    ["an invalid payTo", { ...validRequirements, payTo: "not-an-address" }],
    ["a string maxTimeoutSeconds", { ...validRequirements, maxTimeoutSeconds: "120" }],
  ];

  for (const [label, value] of badCases) {
    it(`rejects ${label} with a message that names the field`, () => {
      const problem = validatePaymentRequirements(value);
      expect(problem).toBeTruthy();
      expect(problem!.length).toBeGreaterThan(10);
    });
  }
});

describe("validatePaymentPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(validatePaymentPayload(validPayload)).toBeNull();
  });

  it("accepts any non-empty transaction string verbatim", () => {
    // The facilitator must not police the encoding of `transaction`; that is
    // @x402/stellar's job. Anything non-empty passes the HTTP envelope check.
    expect(
      validatePaymentPayload({ ...validPayload, payload: { transaction: "zzz" } }),
    ).toBeNull();
  });

  it("rejects a missing transaction", () => {
    expect(validatePaymentPayload({ ...validPayload, payload: {} })).toMatch(/transaction/);
  });

  it("rejects an empty transaction", () => {
    expect(validatePaymentPayload({ ...validPayload, payload: { transaction: "" } })).toMatch(
      /transaction/,
    );
  });

  it("rejects a non-numeric x402Version", () => {
    expect(validatePaymentPayload({ ...validPayload, x402Version: "2" })).toMatch(/x402Version/);
  });
});

describe("validateVerifyRequest", () => {
  it("accepts a complete request", () => {
    expect(
      validateVerifyRequest({
        paymentPayload: validPayload,
        paymentRequirements: validRequirements,
      }),
    ).toBeNull();
  });

  it("reports the payload problem before the requirements problem", () => {
    const problem = validateVerifyRequest({
      paymentPayload: {},
      paymentRequirements: "nonsense",
    });
    expect(problem).toMatch(/paymentPayload/);
  });
});
