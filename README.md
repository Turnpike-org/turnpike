# x402 facilitator for Stellar — testnet slice

An x402 **facilitator** for Stellar: the service that verifies and settles
per-request payments on a seller's behalf, so a seller can charge for an API
without running chain infrastructure. It implements `POST /verify`,
`POST /settle` and `GET /supported` for the `exact` scheme on
`stellar:testnet`, sponsors the network fee out of its own account, and ships
with a conformance harness that proves a **stock, unmodified x402 client from
public npm** can complete a real payment against it.

**What this is not, yet.** It is testnet only — there is no mainnet support and
none is advertised. There is no Bazaar discovery layer, no `upto` scheme, no
batch settlement, and no channel-account pool, so it settles one payment at a
time. It is a demonstration that the hard part works end to end, not a
production payment service. The [scope table](#scope-built-vs-designed) below
is exact about the line between the two.

---

## The claim, and the evidence

> A stock x402 client completes a real payment against this facilitator on
> Stellar testnet, and here is the settled transaction.

**Default demo — 0.01 XLM through the native Stellar Asset Contract:**

```
transaction   f6c6fbcc19d2661d5b9a0d977f562a371411b5974c621e2b79688906bce31fd6
ledger        4094092                    successful: true
payer         GAQDKCQI3CIXVDIGXW47W5ISHGZDDFCCTJ7O6SDBUINQAZFNWYGNSJRK
fee paid by   GCGPGN6NT3WGRPJ3B4SLZWXO7JHLDOHBIOO5PZZJFIMGOW2VPAC7NOGN  (the facilitator)
fee charged   20554 stroops
```

<https://stellar.expert/explorer/testnet/tx/f6c6fbcc19d2661d5b9a0d977f562a371411b5974c621e2b79688906bce31fd6>

**Same code, same command, paying 0.01 testnet USDC** (`PAYMENT_ASSET=usdc`):

```
transaction   538e1d8355e772cac97a8e3720e0f94ea1201941cf4d06f16f369eb885bc8cd3
ledger        4094044                    successful: true
asset         CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA  (testnet USDC SAC)
payer         GD64RY5SHL7NYHU67Q2FCVFNUA3EXPS6IJOBS6G6332T6OKWPT7HWMXX   20.00 → 19.99 USDC
recipient     GC33UN4U3KIJRVOYDGZFACA563L76E76WEAN5CUIQMYDR6KI5PXSINBA    0.00 →  0.01 USDC
fee paid by   GB4SYRSHYUR6VSSFAR55FPNUCFUNOW4EU24OXJXGVJSIAHJGW3O2BNAD  (the facilitator)
fee charged   22973 stroops
```

<https://stellar.expert/explorer/testnet/tx/538e1d8355e772cac97a8e3720e0f94ea1201941cf4d06f16f369eb885bc8cd3>

In both runs the payer and the fee payer are different accounts: that is
`areFeesSponsored: true` from `/supported` being true on-chain, not just in
JSON. The conformance harness asserts it by re-reading the transaction from
Horizon on every run — all 17 checks passed in both.

The terminal session that produced the first transaction — a fresh `git clone`,
one command, accounts created from nothing, ending in that hash — is recorded
verbatim in [`docs/demo-session.txt`](docs/demo-session.txt), with the machine
readable results of both runs in [`docs/`](docs/).

**Stock client used for conformance:** `@x402/fetch@2.21.0`, with
`@x402/core@2.21.0`, `@x402/stellar@2.21.0` and `@stellar/stellar-sdk@16.1.0`,
installed from the public npm registry with exact pins and a committed
lockfile. No patches, no forks, no vendored copies. The harness imports nothing
from this repository.

---

## Quickstart

Requirements: Node.js 22.12+, Docker with Compose, and an internet connection
(the demo talks to real Stellar testnet).

```bash
git clone <this repo> && cd x402-stellar-facilitator
./demo.sh
```

That single command creates and funds three Stellar testnet accounts through
Friendbot, writes `.env`, brings the facilitator and demo resource server up
with `docker compose`, and then runs the conformance harness — which pays for a
resource on testnet for real and prints the settled transaction hash.

There is no faucet visit, no wallet, and no shared secret: the payment asset
defaults to the native XLM Stellar Asset Contract precisely so that a stranger
can reproduce this in one command. Expect it to take two to four minutes, most
of it Docker build time.

### Step by step, if you prefer

```bash
npm run install:all     # install facilitator, demo-server and conformance
npm run setup           # create + fund testnet accounts, write .env
docker compose up       # facilitator :4022, demo resource server :4021
npm run conformance     # stock client pays; prints the settled tx hash
```

Without Docker:

```bash
npm run dev:facilitator   # one shell
npm run dev:demo-server   # another
npm run conformance       # a third
```

### Look around

```bash
curl -s localhost:4022/supported | jq        # what the facilitator advertises
curl -s -i localhost:4021/paid-resource      # 402 + payment terms in the PAYMENT-REQUIRED header
npm --prefix facilitator test                # 59 unit tests
```

---

## What the conformance harness checks

`conformance/` is the deliverable that matters: it is what turns "we built a
facilitator" into something a reviewer can verify in one command. It runs 17
checks in three groups, and exits non-zero if any fails.

**`GET /supported`** — advertises `exact` on `stellar:testnet` at x402 v2; the
Stellar `extra` block carries a boolean `areFeesSponsored`; the facilitator's
signing addresses are published and well-formed; no network is advertised that
this MVP does not actually support.

**A stock client completes a payment** — an unpaid request returns 402 with
well-formed terms in the `PAYMENT-REQUIRED` header; `wrapFetchWithPayment` from
`@x402/fetch` pays and receives the resource; the settled transaction is
re-read from Horizon and confirmed successful; the fee was paid by the
facilitator and not the payer.

**Every rejection explains itself** — malformed payload, malformed request,
insufficient amount, wrong asset, wrong recipient, unsupported network, and a
replay of the payment that was actually settled (at both `/settle` and
`/verify`). Each must return a reason code that is non-null, non-empty and not
generic, *and* a human-readable message longer than a placeholder.

That last group exists because `@x402/stellar` returns machine codes such as
`invalid_exact_stellar_payload_wrong_asset` with no message attached. This
service maps every code it can emit to a sentence
([`facilitator/src/reasons.ts`](facilitator/src/reasons.ts)); a unit test reads
the reason codes out of the installed package build and fails if any of them
lacks one.

CI runs the whole thing on every push, against real testnet, using accounts it
creates at run time — so there is no funded secret to guard and a fork gets the
same green run.

---

## Reliability: what the measurements do and do not support

Payments here cross a public network, so "it works" is a claim with a failure
rate attached. This section states what has actually been measured, and is
deliberate about the gaps.

**Observed, and reproducible:**

| Measurement | Result |
|---|---|
| 30 consecutive conformance runs, one real payment each (local docker stack) | 30 passed, 0 failed, all 17 checks |
| CI on every push — fresh runner, accounts created at run time | green, settlement re-verified on Horizon |
| Probe on GitHub runners: 5 shards × 3 payments | 15 passed, 0 failed |
| Median run time, payment included | ~20s |

**The known fault, and its status.** The client and the facilitator each read
the current ledger from Soroban RPC and independently compute how far ahead an
authorization may expire, tolerating a 2-ledger disagreement. The public
testnet endpoint is load-balanced across nodes that are not always that close
together, so a valid payment can be rejected as
`invalid_exact_stellar_signature_expiration_too_far` (NOTES.md §4.1). The
facilitator retries that one rejection twice, 750ms apart, which re-samples the
ledger height.

**The retry is not sufficient, and we have the run that proves it.** On
2026-08-12 a scheduled probe hit a degraded window on a GitHub runner. The
retry fired, was exhausted, and the payment still failed:

```
14:57:35.974  /verify  retry attempt 1   invalid_exact_stellar_signature_expiration_too_far
14:57:37.047  /verify  retry attempt 2   invalid_exact_stellar_signature_expiration_too_far
14:57:38.123  /verify  rejected          invalid_exact_stellar_signature_expiration_too_far
```

All three attempts fell inside ~2.9 seconds — shorter than one ~5s ledger
close. Re-sampling only helps if it reaches a *different* node or the lagging
node advances, and within 2.9s neither happened. That conformance run reported
13/17 with the payment and its three dependent checks failing.

Measured to date, every payment counted:

| Where | Payments | Failed | Runs where the skew retry fired |
|---|---|---|---|
| Local docker stack, healthy window | 30 | 0 | 0 |
| CI on push (one payment per push) | 3 | 0 | 0 |
| Scheduled probes on GitHub runners | 30 | **1** | **1** (exhausted, payment lost) |
| **Total** | **63** | **1** | **1** |

Direct sampling of the failure predicate during a healthy window — read the
ledger, wait 1.2s, read again — gave 0 hits in 299 trials
(`{0: 182, -1: 117}`).

What that supports, stated carefully:

- The fault is **real, rare, and confirmed on neutral infrastructure**: 1
  failure in 63 measured payments overall, 1 in 15 within the single degraded
  probe.
- The retry is **implemented and now known to be insufficient** in at least one
  window. It is not a fix; a retry window shorter than a ledger close cannot
  outlast a lagging node. Treat the mitigation as partial until either the
  backoff spans a ledger or the upstream bound is negotiated rather than
  guessed twice.
- An earlier note in this repository put the failure rate at "roughly 1 in 4".
  That was an impression formed while debugging, not a measurement, and it is
  **retracted** in favour of the table above.

A probe workflow runs five times a day at spread hours specifically to catch a
degraded window; `scripts/collect-probe-results.sh` aggregates every run into
raw per-payment counts, including whether the retry ever fired. Anyone can run
it against this repository.

**Two further limits, both documented rather than fixed:**

- **One settlement in flight at a time.** Single-signer mode serialises on the
  facilitator account's sequence number, and settlement takes 9-15s. Concurrent
  payments can collide. Channel accounts are the fix and are out of scope here
  (NOTES.md §4.2).
- **`/verify` can briefly accept an already-settled payment.** Verification
  simulates against whatever ledger the RPC node it reached has applied, so for
  a few seconds after settlement a lagging node still simulates the spent
  authorization. Re-settlement still fails on-chain, so this is staleness, not
  a double-spend: settlement is the authority, verification is advice
  (NOTES.md §4.3).

## How it fits together

```
stock x402 client  ──1── GET /paid-resource ──────▶  demo resource server
   (@x402/fetch)   ◀─2── 402 + payment terms ─────
                   ──3── retry w/ signed payload ─▶
                                                     ──4── POST /verify ──▶  facilitator
                                                     ◀─5── valid + reason ──
                                                     ──6── POST /settle ──▶  │
                                                                             ▼
                                                                    @x402/stellar
                                                                             │ submit
                                                                             ▼
                                                              Stellar testnet (Soroban RPC + SAC)
                   ◀─10── 200 + resource ──────────  ◀─9── tx hash ──────────
```

The facilitator is a **wrapper, not a reimplementation**. Every cryptographic
operation — authorization-entry validation, transaction assembly, submission —
belongs to the Apache-2.0 `@x402/stellar` package. This repository contributes
the HTTP surface, request validation, error mapping, configuration, fee-payer
plumbing and structured logging. There are no smart contracts: the `exact`
scheme settles through the Stellar Asset Contract that already exists on-chain.

| Path | What it is |
|---|---|
| `facilitator/` | The service: `/verify`, `/settle`, `/supported`, `/health` |
| `demo-server/` | One paid endpoint, using the stock `@x402/express` middleware |
| `conformance/` | The harness. Depends on public npm packages only |
| `scripts/bootstrap-testnet.mjs` | Friendbot account creation |
| `NOTES.md` | Findings from the SDF reference stack and from real testnet runs |

---

## Configuration

Everything is environment variables; see [`.env.example`](.env.example).
`npm run setup` writes a working `.env` for you. Secrets never enter the repo —
`.env` is gitignored, and these are testnet-only keys regardless.

| Variable | Default | Notes |
|---|---|---|
| `FACILITATOR_SECRET_KEY` | *required* | Signs and submits settlements, and pays their fees |
| `STELLAR_NETWORK` | `stellar:testnet` | Testnet only; the service refuses to start on anything else |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC |
| `MAX_TRANSACTION_FEE_STROOPS` | `1000000` | Ceiling on the fee the facilitator will sponsor |
| `PAYMENT_ASSET` | `native` | `native`, `usdc`, or any SEP-41 `C…` contract address |
| `PAYMENT_AMOUNT` | `100000` | Atomic units; Stellar assets have 7 decimals |
| `SELLER_ADDRESS` | *required* | Receives the payment |
| `BUYER_SECRET_KEY` | *required* | Used by the conformance harness to pay |

`PAYMENT_ASSET=usdc` runs the same demo in testnet USDC — that is how the second
transaction above was settled:

```bash
node scripts/add-usdc-trustlines.mjs        # buyer and seller must trust USDC first
# fund the buyer at https://faucet.circle.com/ (Stellar testnet)
PAYMENT_ASSET=usdc docker compose up -d
PAYMENT_ASSET=usdc npm run conformance
```

That faucet visit is manual and cannot be scripted, which is the only reason
USDC is not the default.

The facilitator refuses to start if its own account is unfunded, because an
unfunded account cannot pay fees and `/supported` would then be advertising
something untrue.

---

## Scope: built vs designed

| | Status |
|---|---|
| `/verify`, `/settle`, `/supported` for `exact` on `stellar:testnet` | **Built, and proven by the harness** |
| Facilitator-sponsored fees, truthfully advertised | **Built, asserted on-chain every run** |
| Human-readable reason on every rejection path | **Built, enforced by tests** |
| Conformance harness with a stock npm client, in CI | **Built** |
| Demo resource server on the stock Express middleware | **Built** |
| Mainnet (`stellar:pubnet`) | Designed only. Not implemented, not advertised |
| Bazaar discovery (`/resources`, search, cataloguing) | Designed only. Not started |
| `upto` scheme + its Soroban contract | Designed only. Needs a Stellar spec first |
| Channel-account pool for concurrent settlement | Designed only. See `NOTES.md` §4.2 |
| Batch settlement, auth-capture, on-chain registry, MCP tooling | Not started |

Known limitations, in full, are in [`NOTES.md`](NOTES.md) §4 — including an
upstream RPC ledger-skew problem that intermittently rejects valid payments, and
what this service does about it.

---

## Licensing

Apache-2.0 ([`LICENSE`](LICENSE)).

Built on the Apache-2.0 [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar)
package. No code was taken from the AGPL-licensed "Built on Stellar" facilitator
or the OpenZeppelin Relayer x402 facilitator plugin. Every transitive dependency
across all three packages is MIT, Apache-2.0, ISC, BSD or Unlicense — there is no
GPL, AGPL, SSPL or BUSL anywhere in the tree (`NOTES.md` §5).
