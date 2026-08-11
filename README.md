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

```
transaction   957dd2348558fbeb27854fc4153828e97621425f63501c83cdedad748f88ebcc
ledger        4091703                    successful: true
amount        0.01 XLM (100000 atomic units, native Stellar Asset Contract)
payer         GBCWTQIVFXVSB467NNSASTKSXA4PXGC5ZBCXEXYXKYF2D2IB4C6MQLPG
fee paid by   GDALA7RS7B2XE253WL4RYN7DXZLZZMPDS2CWWXFJLLAQTKPE62VWUPTW  (the facilitator)
fee charged   20554 stroops
```

<https://stellar.expert/explorer/testnet/tx/957dd2348558fbeb27854fc4153828e97621425f63501c83cdedad748f88ebcc>

The payer and the fee payer are different accounts: that is
`areFeesSponsored: true` from `/supported` being true on-chain, not just in
JSON. The conformance harness asserts it by re-reading the transaction from
Horizon on every run.

The terminal session that produced that transaction — from creating accounts to
the final green run — is recorded verbatim in
[`docs/demo-session.txt`](docs/demo-session.txt).

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

`PAYMENT_ASSET=usdc` runs the same demo in testnet USDC; the payer then needs
testnet USDC from <https://faucet.circle.com/>, which is why it is not the
default.

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
