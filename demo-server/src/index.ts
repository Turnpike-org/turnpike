import { config as loadDotenv } from "dotenv";

// Local development reads the repository-root .env; docker compose injects the
// same variables through env_file, where this simply finds nothing to load.
loadDotenv({ path: [".env", "../.env"], quiet: true });

import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import express from "express";

import { resolveAsset, toDecimal } from "./asset.js";

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name
 * @returns Its value
 * @throws {Error} When unset or empty
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required. Copy .env.example to .env, or run: npm run setup`);
  }
  return value.trim();
}

const NETWORK = "stellar:testnet";

const port = Number(process.env.DEMO_SERVER_PORT ?? 4021);
const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const payTo = required("SELLER_ADDRESS");
const asset = resolveAsset(process.env.PAYMENT_ASSET ?? "native");
const amount = process.env.PAYMENT_AMOUNT ?? "100000";

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// The resource server speaks x402 through the stock Express adapter and
// delegates every verify/settle decision to our facilitator over HTTP.
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactStellarScheme(),
);

/**
 * Waits for the facilitator to answer `/supported`.
 *
 * The x402 middleware syncs with the facilitator as soon as it is constructed.
 * If the facilitator is not up yet — which is exactly what happens when both
 * start at once — that sync fails and the first request to a protected route
 * answers 500 instead of 402. Blocking here turns a startup race into a
 * startup wait.
 *
 * @param url - Facilitator base URL
 * @param timeoutMs - How long to keep trying
 * @returns Nothing
 * @throws {Error} When the facilitator never becomes reachable
 */
async function waitForFacilitator(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Facilitator at ${url} did not answer /supported within ${timeoutMs / 1000}s (${lastError}). ` +
      `Start it first, or check FACILITATOR_URL.`,
  );
}

await waitForFacilitator(facilitatorUrl);

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /paid-resource": {
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            // An explicit AssetAmount, so the price is denominated in the token
            // contract we chose rather than the library's default stablecoin.
            price: { asset, amount },
            payTo,
            maxTimeoutSeconds: 120,
          },
        ],
        description: "A single boring JSON object, sold for a fixed price on Stellar testnet.",
        mimeType: "application/json",
      },
    },
    resourceServer,
    undefined,
    undefined,
    // Sync with the facilitator's /supported on boot: if the facilitator does
    // not actually support this scheme/network, fail here rather than at
    // payment time.
    true,
  ),
);

app.get("/paid-resource", (_req, res) => {
  res.json({
    resource: "paid-resource",
    message: "Payment settled on Stellar testnet. This JSON is the thing you bought.",
    servedAt: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", facilitatorUrl, network: NETWORK });
});

app.get("/", (_req, res) => {
  res.json({
    service: "x402 demo resource server",
    network: NETWORK,
    facilitator: facilitatorUrl,
    paidEndpoint: "GET /paid-resource",
    price: { asset, amount, decimal: toDecimal(amount) },
    payTo,
  });
});

app.listen(port, () => {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      service: "demo-resource-server",
      msg: "listening",
      port,
      network: NETWORK,
      facilitatorUrl,
      paidEndpoint: "GET /paid-resource",
      asset,
      amount,
      priceDecimal: toDecimal(amount),
      payTo,
    })}\n`,
  );
});
