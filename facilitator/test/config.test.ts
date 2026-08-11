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
