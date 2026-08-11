#!/usr/bin/env node
/**
 * Creates and funds the three Stellar testnet accounts this demo needs
 * (facilitator, seller, buyer) and writes a ready-to-run `.env`.
 *
 * Everything here uses Friendbot, so a clean clone reaches a working payment
 * without a faucet visit, a wallet, or a shared secret. Testnet resets wipe
 * accounts periodically; re-running this script is the fix.
 *
 * Usage:
 *   node scripts/bootstrap-testnet.mjs           # no-op if .env already exists
 *   node scripts/bootstrap-testnet.mjs --force   # regenerate all three accounts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@stellar/stellar-sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";

const force = process.argv.includes("--force");

/**
 * Waits.
 *
 * @param ms - Milliseconds to sleep
 * @returns A promise that resolves after the delay
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Funds an account through Friendbot, retrying transient failures.
 *
 * Friendbot rate-limits and occasionally times out; a demo that fails at the
 * funding step reads as a broken demo, so retry properly.
 *
 * @param address - Stellar address to fund
 * @param attempts - Maximum attempts
 * @returns Nothing
 * @throws {Error} When every attempt fails
 */
async function fundAccount(address, attempts = 5) {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${FRIENDBOT}/?addr=${address}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return;

      const body = await response.text();
      // Friendbot returns 400 when the account already exists — that is success
      // for our purposes.
      if (response.status === 400 && /already funded|op_already_exists/i.test(body)) return;
      lastError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) {
      const backoff = 2_000 * attempt;
      process.stdout.write(`   retry ${attempt}/${attempts - 1} in ${backoff / 1000}s (${lastError})\n`);
      await sleep(backoff);
    }
  }

  throw new Error(`Friendbot could not fund ${address}: ${lastError}`);
}

/**
 * Reads an account's native balance.
 *
 * @param address - Stellar address
 * @returns The XLM balance, or null when the account does not exist
 */
async function nativeBalance(address) {
  const response = await fetch(`${HORIZON}/accounts/${address}`);
  if (!response.ok) return null;
  const account = await response.json();
  return account.balances?.find((b) => b.asset_type === "native")?.balance ?? null;
}

if (existsSync(ENV_PATH) && !force) {
  process.stdout.write(
    ".env already exists — leaving it alone.\n" +
      "Re-run with --force to generate fresh testnet accounts.\n",
  );
  process.exit(0);
}

process.stdout.write("Creating Stellar testnet accounts via Friendbot...\n");

const roles = ["facilitator", "seller", "buyer"];
const accounts = {};

for (const role of roles) {
  const keypair = Keypair.random();
  process.stdout.write(` • ${role.padEnd(11)} ${keypair.publicKey()}\n`);
  await fundAccount(keypair.publicKey());
  accounts[role] = { public: keypair.publicKey(), secret: keypair.secret() };
}

process.stdout.write("Confirming balances...\n");
for (const role of roles) {
  const balance = await nativeBalance(accounts[role].public);
  if (balance === null) {
    throw new Error(
      `${role} account ${accounts[role].public} is not visible on Horizon yet. Re-run this script.`,
    );
  }
  process.stdout.write(` • ${role.padEnd(11)} ${balance} XLM\n`);
}

const template = readFileSync(join(ROOT, ".env.example"), "utf8");
const env = template
  .replace(/^FACILITATOR_SECRET_KEY=.*$/m, `FACILITATOR_SECRET_KEY=${accounts.facilitator.secret}`)
  .replace(/^SELLER_ADDRESS=.*$/m, `SELLER_ADDRESS=${accounts.seller.public}`)
  .replace(/^BUYER_SECRET_KEY=.*$/m, `BUYER_SECRET_KEY=${accounts.buyer.secret}`);

writeFileSync(ENV_PATH, env, { mode: 0o600 });

process.stdout.write(
  `\nWrote ${ENV_PATH}\n` +
    `  facilitator (pays fees, settles) ${accounts.facilitator.public}\n` +
    `  seller      (receives payment)   ${accounts.seller.public}\n` +
    `  buyer       (pays)               ${accounts.buyer.public}\n` +
    `\nThese are testnet-only keys, and .env is gitignored. Next: docker compose up\n`,
);
