#!/usr/bin/env node
/**
 * x402 conformance harness.
 *
 * The claim this repository makes is: *a stock, unmodified x402 client can
 * complete a real payment against our facilitator on Stellar testnet*. This
 * script is how that claim is checked, and it is deliberately built to be hard
 * to fake:
 *
 *  - It imports nothing from this repository. Its only dependencies are the
 *    public npm packages `@x402/fetch`, `@x402/core` and `@x402/stellar`, at
 *    exact pinned versions, installed from the public registry.
 *  - The payment goes through `wrapFetchWithPayment` — the library's own
 *    drop-in fetch wrapper. No custom protocol code, no patches, no forks.
 *  - The settled transaction is re-read from Horizon afterwards, so a
 *    facilitator that returned a plausible-looking hash without settling
 *    anything would fail here.
 *
 * Exit code 0 means every check passed. Anything else means the claim is not
 * currently true. Results are also written to conformance-report.json.
 */
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: [".env", "../.env"], quiet: true });

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const NETWORK = "stellar:testnet";
const HORIZON = "https://horizon-testnet.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet/tx";

const DEMO_SERVER_URL = (process.env.DEMO_SERVER_URL ?? "http://localhost:4021").replace(/\/+$/, "");
const FACILITATOR_URL = (process.env.FACILITATOR_URL ?? "http://localhost:4022").replace(/\/+$/, "");
const BUYER_SECRET_KEY = process.env.BUYER_SECRET_KEY;
const SELLER_ADDRESS = process.env.SELLER_ADDRESS;
const PAYMENT_AMOUNT = process.env.PAYMENT_AMOUNT ?? "100000";
const PAYMENT_ASSET = (process.env.PAYMENT_ASSET ?? "native").toLowerCase();

const ASSET =
  PAYMENT_ASSET === "native" || PAYMENT_ASSET === "xlm"
    ? Asset.native().contractId(Networks.TESTNET)
    : PAYMENT_ASSET === "usdc"
      ? USDC_TESTNET_ADDRESS
      : process.env.PAYMENT_ASSET;

if (!BUYER_SECRET_KEY || !SELLER_ADDRESS) {
  process.stderr.write(
    "BUYER_SECRET_KEY and SELLER_ADDRESS are required.\n" +
      "Run `npm run setup` at the repository root to create funded testnet accounts.\n",
  );
  process.exit(2);
}

// ─── tiny test harness ───────────────────────────────────────────────────────

const results = [];
let currentGroup = "";

/**
 * Starts a named group of checks.
 *
 * @param name - Group heading
 */
function group(name) {
  currentGroup = name;
  process.stdout.write(`\n${name}\n${"─".repeat(name.length)}\n`);
}

/**
 * Records and prints the outcome of one check.
 *
 * @param name - What was checked
 * @param fn - Throws on failure; may return details to record
 * @returns Whatever the check returned, or undefined when it failed
 */
async function check(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ group: currentGroup, name, passed: true, detail, ms: Date.now() - startedAt });
    process.stdout.write(`  PASS  ${name}\n`);
    return detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      group: currentGroup,
      name,
      passed: false,
      error: message,
      ms: Date.now() - startedAt,
    });
    process.stdout.write(`  FAIL  ${name}\n        ${message}\n`);
    return undefined;
  }
}

/**
 * Asserts a condition.
 *
 * @param condition - Must be truthy
 * @param message - Failure description
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Asserts that a rejection carries a usable reason: present, non-empty, and
 * not a generic placeholder. This is the acceptance criterion that every
 * rejection path must explain itself.
 *
 * @param reason - The machine-readable reason code
 * @param message - The human-readable message
 * @param label - Context for the failure text
 */
function assertUsableReason(reason, message, label) {
  assert(reason !== null && reason !== undefined, `${label}: reason is null/undefined`);
  assert(typeof reason === "string" && reason.trim().length > 0, `${label}: reason is empty`);
  assert(
    !["error", "unknown", "failed", "invalid"].includes(reason.trim().toLowerCase()),
    `${label}: reason '${reason}' is generic and tells an integrator nothing`,
  );
  assert(
    typeof message === "string" && message.trim().length > 10,
    `${label}: reason '${reason}' has no human-readable message`,
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Reads the installed version of a dependency, so the report records what
 * actually ran rather than what was requested.
 *
 * @param name - Package name
 * @returns The installed version string
 */
function installedVersion(name) {
  // Read the manifest off disk: several of these packages do not export
  // ./package.json, so require() cannot reach it.
  const manifest = join(HERE, "..", "node_modules", ...name.split("/"), "package.json");
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

/**
 * POSTs to the facilitator.
 *
 * @param path - Endpoint path
 * @param body - JSON body
 * @returns Status and parsed body
 */
async function postFacilitator(path, body) {
  const response = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return { status: response.status, body: parsed };
}

/**
 * Builds payment requirements.
 *
 * @param overrides - Fields to override
 * @returns Payment requirements
 */
function requirements(overrides = {}) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: PAYMENT_AMOUNT,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

const buyerSigner = createEd25519Signer(BUYER_SECRET_KEY, NETWORK);
const buyerAddress = Keypair.fromSecret(BUYER_SECRET_KEY).publicKey();
const clientScheme = new ExactStellarScheme(buyerSigner);

/**
 * Signs a payment payload with the stock client scheme.
 *
 * @param signedFor - Requirements the client signs against
 * @returns A complete PaymentPayload
 */
async function signPayload(signedFor) {
  const partial = await clientScheme.createPaymentPayload(2, signedFor);
  return { ...partial, accepted: signedFor };
}

/**
 * Fetches a transaction from Horizon, waiting for it to appear.
 *
 * @param hash - Transaction hash
 * @param attempts - Polling attempts
 * @returns The Horizon transaction record
 */
async function horizonTransaction(hash, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`${HORIZON}/transactions/${hash}`);
    if (response.ok) return response.json();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`transaction ${hash} never appeared on Horizon after ${attempts} attempts`);
}

// ─── run ─────────────────────────────────────────────────────────────────────

const pinned = {
  "@x402/core": installedVersion("@x402/core"),
  "@x402/fetch": installedVersion("@x402/fetch"),
  "@x402/stellar": installedVersion("@x402/stellar"),
  "@stellar/stellar-sdk": installedVersion("@stellar/stellar-sdk"),
};

process.stdout.write("x402 Stellar facilitator — conformance harness\n");
process.stdout.write(`  facilitator     ${FACILITATOR_URL}\n`);
process.stdout.write(`  resource server ${DEMO_SERVER_URL}\n`);
process.stdout.write(`  network         ${NETWORK}\n`);
process.stdout.write(`  asset           ${ASSET}\n`);
process.stdout.write(`  amount          ${PAYMENT_AMOUNT} (atomic units)\n`);
process.stdout.write(`  buyer           ${buyerAddress}\n`);
process.stdout.write("  stock client packages, installed from public npm:\n");
for (const [name, version] of Object.entries(pinned)) {
  process.stdout.write(`    ${name}@${version}\n`);
}

// ── 1. /supported ────────────────────────────────────────────────────────────

group("1. GET /supported");

let facilitatorSigners = [];

await check("responds 200 with a kinds array", async () => {
  const response = await fetch(`${FACILITATOR_URL}/supported`);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  const body = await response.json();
  assert(Array.isArray(body.kinds), "'kinds' must be an array");
  globalThis.__supported = body;
  return { kinds: body.kinds.length };
});

await check("advertises the exact scheme on stellar:testnet at x402 v2", () => {
  const kind = globalThis.__supported.kinds.find(
    (k) => k.scheme === "exact" && k.network === NETWORK,
  );
  assert(kind, `no entry for scheme 'exact' on ${NETWORK}`);
  assert(kind.x402Version === 2, `expected x402Version 2, got ${kind.x402Version}`);
  return kind;
});

await check("the Stellar extra block carries a boolean areFeesSponsored", () => {
  const kind = globalThis.__supported.kinds.find(
    (k) => k.scheme === "exact" && k.network === NETWORK,
  );
  assert(kind.extra, "entry has no 'extra' block");
  assert(
    "areFeesSponsored" in kind.extra,
    "'extra' block does not include 'areFeesSponsored'",
  );
  assert(
    typeof kind.extra.areFeesSponsored === "boolean",
    `'areFeesSponsored' must be a boolean, got ${typeof kind.extra.areFeesSponsored}`,
  );
  return { areFeesSponsored: kind.extra.areFeesSponsored };
});

await check("publishes at least one valid facilitator signing address", () => {
  const signers = Object.values(globalThis.__supported.signers ?? {}).flat();
  assert(signers.length > 0, "'signers' is empty");
  for (const address of signers) {
    assert(/^G[A-Z2-7]{55}$/.test(address), `'${address}' is not a Stellar account address`);
  }
  facilitatorSigners = signers;
  return { signers };
});

await check("does not advertise networks this MVP does not support", () => {
  const networks = globalThis.__supported.kinds.map((k) => k.network);
  assert(
    !networks.includes("stellar:pubnet"),
    "advertises stellar:pubnet, which this MVP does not support",
  );
  return { networks };
});

// ── 2. stock client payment ──────────────────────────────────────────────────

group("2. Stock x402 client completes a payment");

let settledTransaction = null;
let sentPaymentHeader = null;

const unpaid = await check("unpaid request returns 402 with well-formed payment terms", async () => {
  const response = await fetch(`${DEMO_SERVER_URL}/paid-resource`, {
    headers: { accept: "application/json" },
  });
  assert(response.status === 402, `expected 402, got ${response.status}`);

  // x402 v2 carries the payment terms in the PAYMENT-REQUIRED header, decoded
  // here with the library's own decoder rather than by hand.
  const header = response.headers.get("payment-required");
  assert(header, "402 response carries no payment-required header");
  const paymentRequired = decodePaymentRequiredHeader(header);

  assert(paymentRequired.x402Version === 2, `expected x402Version 2, got ${paymentRequired.x402Version}`);
  assert(
    Array.isArray(paymentRequired.accepts) && paymentRequired.accepts.length > 0,
    "payment-required header has no 'accepts' array",
  );
  const terms = paymentRequired.accepts[0];
  assert(terms.scheme === "exact", `expected scheme 'exact', got '${terms.scheme}'`);
  assert(terms.network === NETWORK, `expected network '${NETWORK}', got '${terms.network}'`);
  assert(terms.asset === ASSET, `expected asset '${ASSET}', got '${terms.asset}'`);
  assert(terms.amount === PAYMENT_AMOUNT, `expected amount '${PAYMENT_AMOUNT}', got '${terms.amount}'`);
  assert(terms.payTo === SELLER_ADDRESS, `expected payTo '${SELLER_ADDRESS}', got '${terms.payTo}'`);
  // The facilitator's fee-sponsorship posture must reach the client in the 402,
  // not just in /supported.
  assert(
    typeof terms.extra?.areFeesSponsored === "boolean",
    "payment terms do not carry the Stellar 'areFeesSponsored' flag",
  );
  return terms;
});

await check("stock wrapFetchWithPayment pays and receives the resource", async () => {
  // This is the whole claim, in five lines of unmodified library usage.
  const client = new x402HTTPClient(
    new x402Client().register(NETWORK, new ExactStellarScheme(buyerSigner)),
  );
  // The wrapper is given a fetch that records the payment header the client
  // sends. Recording it costs nothing and lets the replay check below re-submit
  // the payment that was really settled, rather than a stand-in.
  const recordingFetch = (input, init) => {
    if (input instanceof Request) {
      const header =
        input.headers.get("payment-signature") ?? input.headers.get("x-payment");
      if (header) sentPaymentHeader = header;
    }
    return fetch(input, init);
  };
  const fetchWithPayment = wrapFetchWithPayment(recordingFetch, client);

  const response = await fetchWithPayment(`${DEMO_SERVER_URL}/paid-resource`, {
    headers: { accept: "application/json" },
  });

  assert(response.status === 200, `expected 200 after payment, got ${response.status}`);
  const body = await response.json();
  assert(body.resource === "paid-resource", `unexpected resource body: ${JSON.stringify(body)}`);

  const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  assert(header, "response carries no payment-response header");

  const settlement = decodePaymentResponseHeader(header);
  assert(settlement.success === true, `settlement not successful: ${JSON.stringify(settlement)}`);
  assert(
    typeof settlement.transaction === "string" && /^[0-9a-f]{64}$/.test(settlement.transaction),
    `settlement transaction '${settlement.transaction}' is not a Stellar transaction hash`,
  );

  settledTransaction = settlement.transaction;
  return { transaction: settlement.transaction, payer: settlement.payer, body };
});

await check("the settled transaction succeeded on-chain", async () => {
  assert(settledTransaction, "no transaction hash from the payment step");
  const transaction = await horizonTransaction(settledTransaction);
  assert(transaction.successful === true, "Horizon reports the transaction as unsuccessful");
  return {
    hash: transaction.hash,
    ledger: transaction.ledger,
    feeCharged: transaction.fee_charged,
    feeAccount: transaction.fee_account ?? transaction.source_account,
    explorer: `${EXPLORER}/${transaction.hash}`,
  };
});

await check("the facilitator — not the payer — paid the network fee", async () => {
  // This is what makes `areFeesSponsored: true` in /supported an honest claim
  // rather than a string in a JSON blob.
  const transaction = await horizonTransaction(settledTransaction);
  const feePayer = transaction.fee_account ?? transaction.source_account;
  assert(
    feePayer !== buyerAddress,
    `the buyer ${buyerAddress} paid the fee, so fees are not sponsored`,
  );
  assert(
    facilitatorSigners.includes(feePayer),
    `fee was paid by ${feePayer}, which is not one of the facilitator's published signers`,
  );
  return { feePayer, feeCharged: transaction.fee_charged };
});

// ── 3. rejection paths ───────────────────────────────────────────────────────

group("3. Every rejection path returns a usable reason");

await check("malformed payload — non-decodable transaction", async () => {
  const paymentRequirements = requirements();
  const { body } = await postFacilitator("/verify", {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: paymentRequirements,
      payload: { transaction: "this-is-not-a-transaction-envelope" },
    },
    paymentRequirements,
  });
  assert(body.isValid === false, "a garbage transaction was accepted as valid");
  assertUsableReason(body.invalidReason, body.invalidMessage, "malformed payload");
  return { invalidReason: body.invalidReason, invalidMessage: body.invalidMessage };
});

await check("malformed request — body is not an x402 request at all", async () => {
  const { status, body } = await postFacilitator("/verify", {});
  assert(status === 400, `expected 400, got ${status}`);
  assert(body.isValid === false, "empty body was not rejected");
  assertUsableReason(body.invalidReason, body.invalidMessage, "malformed request");
  return { status, invalidReason: body.invalidReason };
});

await check("insufficient amount — client signed less than the terms require", async () => {
  const signedFor = requirements({ amount: PAYMENT_AMOUNT });
  const paymentPayload = await signPayload(signedFor);
  // Ask the facilitator to verify the same signed transaction against terms
  // demanding ten times more.
  const paymentRequirements = requirements({ amount: String(Number(PAYMENT_AMOUNT) * 10) });

  const { body } = await postFacilitator("/verify", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  assert(body.isValid === false, "an underpayment was accepted as valid");
  assertUsableReason(body.invalidReason, body.invalidMessage, "insufficient amount");
  return { invalidReason: body.invalidReason, invalidMessage: body.invalidMessage };
});

await check("wrong asset — client signed a different token contract", async () => {
  const otherAsset =
    ASSET === USDC_TESTNET_ADDRESS ? Asset.native().contractId(Networks.TESTNET) : USDC_TESTNET_ADDRESS;
  const paymentPayload = await signPayload(requirements());
  const paymentRequirements = requirements({ asset: otherAsset });

  const { body } = await postFacilitator("/verify", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  assert(body.isValid === false, "a payment in the wrong asset was accepted as valid");
  assertUsableReason(body.invalidReason, body.invalidMessage, "wrong asset");
  return { invalidReason: body.invalidReason, invalidMessage: body.invalidMessage };
});

await check("wrong recipient — payment goes to someone other than payTo", async () => {
  const paymentPayload = await signPayload(requirements());
  const paymentRequirements = requirements({ payTo: Keypair.random().publicKey() });

  const { body } = await postFacilitator("/verify", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  assert(body.isValid === false, "a payment to the wrong recipient was accepted as valid");
  assertUsableReason(body.invalidReason, body.invalidMessage, "wrong recipient");
  return { invalidReason: body.invalidReason, invalidMessage: body.invalidMessage };
});

await check("unsupported network — reason, not a bare 500", async () => {
  const paymentRequirements = requirements({ network: "stellar:pubnet" });
  const { status, body } = await postFacilitator("/verify", {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: paymentRequirements,
      payload: { transaction: "AAAAAgAAAAA" },
    },
    paymentRequirements,
  });
  assert(status < 500, `facilitator answered ${status} instead of explaining itself`);
  assert(body.isValid === false, "an unsupported network was accepted");
  assertUsableReason(body.invalidReason, body.invalidMessage, "unsupported network");
  return { status, invalidReason: body.invalidReason };
});

await check("replayed payload — the settled payment cannot be settled again", async () => {
  // Replays the exact payload the stock client already paid with, captured
  // above. Soroban authorization entries are single-use, so a second
  // settlement must fail — and must say why.
  assert(sentPaymentHeader, "no payment header was captured from the stock client");
  const paymentPayload = decodePaymentSignatureHeader(sentPaymentHeader);
  const paymentRequirements = paymentPayload.accepted;

  const replay = await postFacilitator("/settle", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });

  assert(replay.body.success === false, "the facilitator settled the same payment twice");
  assertUsableReason(replay.body.errorReason, replay.body.errorMessage, "replayed payload");
  return {
    originalTransaction: settledTransaction,
    replayReason: replay.body.errorReason,
    replayMessage: replay.body.errorMessage,
  };
});

await check("replayed payload is also refused by /verify", async () => {
  assert(sentPaymentHeader, "no payment header was captured from the stock client");
  const paymentPayload = decodePaymentSignatureHeader(sentPaymentHeader);

  // /verify simulates against whatever ledger the RPC node it reaches has
  // applied. Immediately after settlement, a node lagging a few ledgers still
  // simulates the spent authorization successfully. The property being asserted
  // is that a settled payment stops verifying — not that it does so on the same
  // millisecond — so poll until the settlement is visible.
  const deadline = Date.now() + 45_000;
  let body;

  while (Date.now() < deadline) {
    ({ body } = await postFacilitator("/verify", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    }));
    if (body.isValid === false) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  assert(
    body.isValid === false,
    "an already-settled payment still verified as valid 45s after settlement",
  );
  assertUsableReason(body.invalidReason, body.invalidMessage, "replay at verify");
  return { invalidReason: body.invalidReason, invalidMessage: body.invalidMessage };
});

// ─── report ──────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed);

const report = {
  runAt: new Date().toISOString(),
  network: NETWORK,
  facilitatorUrl: FACILITATOR_URL,
  demoServerUrl: DEMO_SERVER_URL,
  asset: ASSET,
  amount: PAYMENT_AMOUNT,
  buyer: buyerAddress,
  seller: SELLER_ADDRESS,
  facilitatorSigners,
  stockClientPackages: pinned,
  settledTransaction,
  explorerUrl: settledTransaction ? `${EXPLORER}/${settledTransaction}` : null,
  checks: results,
  passed,
  failed: failed.length,
};

writeFileSync(join(ROOT, "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`\n${"═".repeat(64)}\n`);
process.stdout.write(`${passed} passed, ${failed.length} failed\n`);
if (settledTransaction) {
  process.stdout.write(`\nSettled transaction: ${settledTransaction}\n`);
  process.stdout.write(`Explorer:            ${EXPLORER}/${settledTransaction}\n`);
}
process.stdout.write(`Report:              ${join(ROOT, "conformance-report.json")}\n`);

if (failed.length > 0) {
  process.stdout.write("\nFailures:\n");
  for (const failure of failed) {
    process.stdout.write(`  - [${failure.group}] ${failure.name}: ${failure.error}\n`);
  }
  process.exit(1);
}

// Keep the README's headline number honest: print what a reviewer should paste
// into an explorer.
const readme = join(ROOT, "README.md");
try {
  const contents = readFileSync(readme, "utf8");
  if (settledTransaction && !contents.includes(settledTransaction)) {
    process.stdout.write(
      `\nNote: README.md does not mention this run's transaction hash.\n` +
        `      The published hash is a previous run; both are valid on testnet.\n`,
    );
  }
} catch {
  // README is not required for the harness to be meaningful.
}
