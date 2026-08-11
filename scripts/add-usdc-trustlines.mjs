#!/usr/bin/env node
/**
 * Adds testnet USDC trustlines to the buyer and seller accounts in `.env`.
 *
 * Only needed when running with `PAYMENT_ASSET=usdc`. A Stellar account cannot
 * hold or receive a classic asset without a trustline to its issuer, so both
 * the payer and the recipient need one before any USDC can move — including
 * before the Circle faucet will send you any.
 *
 * Usage:
 *   node scripts/add-usdc-trustlines.mjs
 *   # then fund the buyer at https://faucet.circle.com/ (Stellar testnet)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const HORIZON = "https://horizon-testnet.stellar.org";

/** Circle's testnet USDC issuer. Its SAC is the address `@x402/stellar` uses. */
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

if (!existsSync(ENV_PATH)) {
  process.stderr.write("No .env found. Run `npm run setup` first.\n");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const server = new Horizon.Server(HORIZON);

/**
 * Adds a USDC trustline for one account, if it does not already have one.
 *
 * @param secret - The account's secret key
 * @param label - Role name, for output
 * @returns Nothing
 */
async function addTrustline(secret, label) {
  const keypair = Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());

  const existing = account.balances.find(
    (balance) => balance.asset_code === USDC.getCode() && balance.asset_issuer === USDC.getIssuer(),
  );
  if (existing) {
    process.stdout.write(` • ${label.padEnd(7)} ${keypair.publicKey()} already trusts USDC (balance ${existing.balance})\n`);
    return;
  }

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();

  transaction.sign(keypair);
  await server.submitTransaction(transaction);
  process.stdout.write(` • ${label.padEnd(7)} ${keypair.publicKey()} trustline added\n`);
}

process.stdout.write("Adding testnet USDC trustlines...\n");

await addTrustline(env.BUYER_SECRET_KEY, "buyer");

// The seller needs one too: a SAC transfer to an account that does not trust
// the asset fails, and the failure surfaces as an opaque simulation error.
if (env.SELLER_SECRET_KEY) {
  await addTrustline(env.SELLER_SECRET_KEY, "seller");
} else {
  process.stdout.write(
    ` ! seller  ${env.SELLER_ADDRESS} needs a USDC trustline too, but .env holds no\n` +
      `           SELLER_SECRET_KEY. Add one from whatever controls that account.\n`,
  );
}

process.stdout.write(
  `\nNow fund the buyer with testnet USDC:\n` +
    `  https://faucet.circle.com/  →  Stellar testnet  →  ${Keypair.fromSecret(env.BUYER_SECRET_KEY).publicKey()}\n` +
    `Then run:  PAYMENT_ASSET=usdc npm run conformance\n`,
);
