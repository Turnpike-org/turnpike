import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { loadConfig, SUPPORTED_NETWORK } from "../src/config.js";

const validSecret = Keypair.random().secret();

describe("loadConfig", () => {
  it("accepts a minimal testnet configuration and derives the facilitator address", () => {
    const config = loadConfig({ FACILITATOR_SECRET_KEY: validSecret } as NodeJS.ProcessEnv);

    expect(config.network).toBe(SUPPORTED_NETWORK);
    expect(config.port).toBe(4022);
    expect(config.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.facilitatorAddress).toBe(Keypair.fromSecret(validSecret).publicKey());
  });

  it("rejects a missing or malformed secret key with an actionable message", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/FACILITATOR_SECRET_KEY/);
    expect(() =>
      loadConfig({ FACILITATOR_SECRET_KEY: "not-a-key" } as NodeJS.ProcessEnv),
    ).toThrow(/valid Stellar secret key/);
  });

  it("refuses mainnet — this MVP is testnet-only and must not pretend otherwise", () => {
    expect(() =>
      loadConfig({
        FACILITATOR_SECRET_KEY: validSecret,
        STELLAR_NETWORK: "stellar:pubnet",
      } as NodeJS.ProcessEnv),
    ).toThrow(/testnet-only/);
  });

  it("rejects a non-numeric fee ceiling", () => {
    expect(() =>
      loadConfig({
        FACILITATOR_SECRET_KEY: validSecret,
        MAX_TRANSACTION_FEE_STROOPS: "lots",
      } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid facilitator configuration/);
  });

  it("defaults the ledger-skew retry to a backoff longer than one ledger close", () => {
    const config = loadConfig({ FACILITATOR_SECRET_KEY: validSecret } as NodeJS.ProcessEnv);

    expect(config.ledgerSkewRetries).toBe(2);
    // A ledger closes about every 5s; a shorter delay cannot outlast a lagging
    // RPC node, which is the failure this retry exists to survive.
    expect(config.ledgerSkewRetryDelayMs).toBeGreaterThanOrEqual(5_000);
  });

  it("rejects a retry budget that would outlast a resource server's patience", () => {
    expect(() =>
      loadConfig({
        FACILITATOR_SECRET_KEY: validSecret,
        LEDGER_SKEW_RETRIES: "5",
        LEDGER_SKEW_RETRY_DELAY_MS: "20000",
      } as NodeJS.ProcessEnv),
    ).toThrow(/retry budget/);
  });

  it("allows the retry to be tuned or turned off", () => {
    const config = loadConfig({
      FACILITATOR_SECRET_KEY: validSecret,
      LEDGER_SKEW_RETRIES: "0",
      LEDGER_SKEW_RETRY_DELAY_MS: "8000",
    } as NodeJS.ProcessEnv);

    expect(config.ledgerSkewRetries).toBe(0);
    expect(config.ledgerSkewRetryDelayMs).toBe(8_000);
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      FACILITATOR_SECRET_KEY: validSecret,
      FACILITATOR_PORT: "5000",
      STELLAR_RPC_URL: "https://rpc.example.org",
      MAX_TRANSACTION_FEE_STROOPS: "250000",
      LOG_LEVEL: "debug",
    } as NodeJS.ProcessEnv);

    expect(config.port).toBe(5000);
    expect(config.rpcUrl).toBe("https://rpc.example.org");
    expect(config.maxTransactionFeeStroops).toBe(250_000);
    expect(config.logLevel).toBe("debug");
  });
});
