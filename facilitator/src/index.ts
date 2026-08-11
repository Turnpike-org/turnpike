import { config as loadDotenv } from "dotenv";

// Local development reads the repository-root .env; docker compose injects the
// same variables through env_file, where this simply finds nothing to load.
loadDotenv({ path: [".env", "../.env"], quiet: true });

import { assertSupportedIsTruthful, createApp, FEES_ARE_SPONSORED } from "./app.js";
import { horizonUrl, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

/**
 * Confirms the facilitator's own account exists and is funded.
 *
 * `/supported` advertises `areFeesSponsored: true`, which is only true if this
 * account can actually pay fees. Refusing to start otherwise keeps the
 * advertisement honest — and turns the most common setup mistake (forgot to run
 * `npm run setup`) into a clear message instead of a failed payment.
 *
 * @param address - The facilitator's Stellar address
 * @returns The account's XLM balance as a decimal string
 * @throws {Error} When the account does not exist or holds no XLM
 */
async function assertFacilitatorIsFunded(address: string): Promise<string> {
  const response = await fetch(`${horizonUrl()}/accounts/${address}`);

  if (response.status === 404) {
    throw new Error(
      `Facilitator account ${address} does not exist on testnet, so it cannot sponsor fees. ` +
        `Fund it: curl "https://friendbot.stellar.org/?addr=${address}"  (or run: npm run setup)`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not check the facilitator account on Horizon (HTTP ${response.status}). ` +
        `Retry, or point STELLAR_RPC_URL/Horizon at a reachable endpoint.`,
    );
  }

  const account = (await response.json()) as {
    balances?: { asset_type: string; balance: string }[];
  };
  const native = account.balances?.find((b) => b.asset_type === "native");
  if (!native || Number(native.balance) <= 0) {
    throw new Error(
      `Facilitator account ${address} holds no XLM, so it cannot pay settlement fees. ` +
        `Fund it: curl "https://friendbot.stellar.org/?addr=${address}"`,
    );
  }
  return native.balance;
}

/**
 * Boots the facilitator.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const { app, facilitator } = createApp(config, logger);

  // Fail fast, and fail explaining itself.
  assertSupportedIsTruthful(facilitator.getSupported(), config.network);
  const balance = await assertFacilitatorIsFunded(config.facilitatorAddress);

  app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        network: config.network,
        rpcUrl: config.rpcUrl,
        facilitator: config.facilitatorAddress,
        facilitatorXlmBalance: balance,
        areFeesSponsored: FEES_ARE_SPONSORED,
        maxTransactionFeeStroops: config.maxTransactionFeeStroops,
      },
      "facilitator listening",
    );
  });
}

main().catch((error: unknown) => {
  // Configuration and preflight failures happen before the logger exists in the
  // worst case, so write plainly to stderr and exit non-zero.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
