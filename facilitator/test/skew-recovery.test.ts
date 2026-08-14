import { Keypair } from "@stellar/stellar-sdk";
import type { x402Facilitator } from "@x402/core/facilitator";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

/**
 * Does the ledger-skew retry actually recover a payment?
 *
 * The fault is real and was observed losing a payment on a GitHub-hosted runner
 * on 2026-08-12 (NOTES.md §4.1). The fix — a backoff that spans a full ledger
 * close — has never been seen recovering a *live* degraded window, because no
 * such window has occurred since, and one cannot be manufactured on demand.
 *
 * So this simulates the fault instead, deterministically, at the HTTP boundary.
 * It models the measured mechanism rather than mocking the outcome:
 *
 *   - the public RPC endpoint load-balances across nodes at different heights;
 *   - the client signs an expiry derived from the node *it* reached;
 *   - the facilitator checks against the node *it* reached, tolerating 2 ledgers;
 *   - so the rejection fires exactly when clientLedger - facilitatorLedger > 2;
 *   - a lagging node catches up when a ledger closes, roughly every 5 seconds.
 *
 * What this proves: given a 3-ledger divergence that resolves as ledgers close,
 * `/verify` and `/settle` recover and return success. What it does not prove:
 * that a real degraded window behaves the way this model says. That distinction
 * is stated on the reliability page rather than blurred.
 *
 * Timescale is compressed — the delay is milliseconds here, not 6 seconds, so
 * the suite stays fast. That the real backoff outlasts a ledger close is
 * asserted separately in retry.test.ts, with fake timers.
 */

const SKEW_REASON = "invalid_exact_stellar_signature_expiration_too_far";
const silentLogger = pino({ level: "silent" });

const config = loadConfig({
  FACILITATOR_SECRET_KEY: Keypair.random().secret(),
  LEDGER_SKEW_RETRIES: "2",
  LEDGER_SKEW_RETRY_DELAY_MS: "5",
} as NodeJS.ProcessEnv);

/** How far the facilitator's node trails the client's, in ledgers. */
type SkewOptions = {
  /** Initial divergence. 3 is the maximum measured on soroban-testnet. */
  initialSkew: number;
  /** Ledgers the trailing node gains per retry, i.e. per ledger close. */
  catchUpPerAttempt: number;
};

/**
 * Builds a facilitator that reproduces the ledger-skew rejection.
 *
 * The tolerance and the predicate are the package's, restated here because the
 * point is to drive our HTTP layer through the exact rejection the package
 * emits when the two reads disagree.
 *
 * @param options - Divergence and catch-up behaviour
 * @returns A facilitator stand-in plus a record of how many attempts it saw
 */
function facilitatorWithSkew(options: SkewOptions): {
  facilitator: x402Facilitator;
  attempts: () => number;
} {
  const TOLERANCE = 2;
  let attempt = 0;

  /** @returns Whether this attempt still sees a divergence beyond tolerance */
  const stillSkewed = (): boolean => {
    const divergence = options.initialSkew - attempt * options.catchUpPerAttempt;
    attempt += 1;
    return divergence > TOLERANCE;
  };

  const facilitator = {
    async verify(): Promise<VerifyResponse> {
      return stillSkewed()
        ? { isValid: false, invalidReason: SKEW_REASON }
        : { isValid: true, payer: "GTESTPAYER" };
    },
    async settle(): Promise<SettleResponse> {
      return stillSkewed()
        ? { success: false, transaction: "", network: "stellar:testnet", errorReason: SKEW_REASON }
        : {
            success: true,
            transaction: "a".repeat(64),
            network: "stellar:testnet",
            payer: "GTESTPAYER",
          };
    },
    getSupported() {
      return { kinds: [], extensions: [], signers: {} };
    },
  } as unknown as x402Facilitator;

  return { facilitator, attempts: () => attempt };
}

/**
 * A structurally valid request body; the payload never reaches a real chain.
 *
 * @returns A verify/settle request body
 */
function body(): Record<string, unknown> {
  const requirements = {
    scheme: "exact",
    network: "stellar:testnet",
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: "100000",
    payTo: Keypair.random().publicKey(),
    maxTimeoutSeconds: 120,
    extra: {},
  };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
    paymentRequirements: requirements,
  };
}

describe("ledger-skew recovery, simulated", () => {
  it("recovers a payment when a 3-ledger divergence closes on the first retry", async () => {
    // Divergence 3 > tolerance 2 → rejected. One ledger closes, the trailing
    // node gains 3, divergence 0 → accepted.
    const { facilitator, attempts } = facilitatorWithSkew({
      initialSkew: 3,
      catchUpPerAttempt: 3,
    });
    const { app } = createApp(config, silentLogger, facilitator);

    const response = await request(app).post("/verify").send(body());

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(true);
    expect(attempts(), "should have taken one retry to recover").toBe(2);
  });

  it("recovers when the divergence needs both retries to clear", async () => {
    const { facilitator, attempts } = facilitatorWithSkew({
      initialSkew: 4,
      catchUpPerAttempt: 1,
    });
    const { app } = createApp(config, silentLogger, facilitator);

    const response = await request(app).post("/verify").send(body());

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(true);
    expect(attempts()).toBe(3);
  });

  it("gives up honestly when the divergence never clears, as happened on 2026-08-12", async () => {
    // The trailing node never advances — the failure actually observed, where
    // all attempts fell inside one ledger close.
    const { facilitator, attempts } = facilitatorWithSkew({
      initialSkew: 3,
      catchUpPerAttempt: 0,
    });
    const { app } = createApp(config, silentLogger, facilitator);

    const response = await request(app).post("/verify").send(body());

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(false);
    expect(response.body.invalidReason).toBe(SKEW_REASON);
    // Still explains itself rather than returning a bare code.
    expect(String(response.body.invalidMessage).length).toBeGreaterThan(20);
    expect(attempts(), "one initial attempt plus two retries").toBe(3);
  });

  it("recovers a settlement the same way, and returns the transaction", async () => {
    const { facilitator, attempts } = facilitatorWithSkew({
      initialSkew: 3,
      catchUpPerAttempt: 3,
    });
    const { app } = createApp(config, silentLogger, facilitator);

    const response = await request(app).post("/settle").send(body());

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(attempts()).toBe(2);
  });

  it("does not retry a divergence within tolerance — there is nothing to recover", async () => {
    // 2 ledgers apart is inside the package's tolerance, so the payment is
    // accepted on the first attempt and no retry should fire.
    const { facilitator, attempts } = facilitatorWithSkew({
      initialSkew: 2,
      catchUpPerAttempt: 0,
    });
    const { app } = createApp(config, silentLogger, facilitator);

    const response = await request(app).post("/verify").send(body());

    expect(response.body.isValid).toBe(true);
    expect(attempts()).toBe(1);
  });
});
