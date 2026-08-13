# Engineering notes

Findings from studying the SDF reference implementation and from running real
payments on Stellar testnet. Written for whoever picks this codebase up next,
including me.

---

## 1. The reference stack: `github.com/stellar/x402-stellar`

Read at commit fetched 2026-08-11 (`@x402/*` packages at 2.21.0). Apache-2.0.

A pnpm + turbo monorepo:

| Path | What it is |
|---|---|
| `examples/facilitator/` | Express service: `POST /verify`, `POST /settle`, `GET /supported`, `GET /health` |
| `examples/simple-paywall/server/` | Paid weather API + browser paywall, using `@x402/express` |
| `examples/simple-paywall/client/` | React SPA that pays through a browser wallet |
| `examples/client-cli/` | Node CLI that pays the paywall server |
| `packages/paywall`, `packages/shared` | Paywall UI and shared HTTP helpers |

### What the reference facilitator already does well

- Wraps `x402Facilitator` (from `@x402/core/facilitator`) with `ExactStellarScheme`
  (from `@x402/stellar/exact/facilitator`) — no protocol logic of its own. I
  copied that posture exactly; it is the right one.
- Optional bearer-token auth with a constant-time comparison, `helmet`, CORS,
  and a 120 req/min rate limit on the paying endpoints.
- **Channel accounts**: with `FACILITATOR_STELLAR_FEE_BUMP_SECRET` plus
  `FACILITATOR_STELLAR_CHANNEL_SECRETS`, settlement rotates across N accounts
  and wraps each inner transaction in a fee bump. This is the real answer to
  Stellar's one-transaction-per-sequence-number limit, and it ships with a
  script that creates 19 sponsored-reserve channel accounts in one transaction.
- Utility scripts for re-funding accounts after a testnet reset.

### Gaps relative to my acceptance criteria

Not criticisms of the reference — it is an example, not a product — but these
are the things I had to add:

1. **Rejections do not explain themselves.** `@x402/stellar` returns machine
   codes (`invalid_exact_stellar_payload_wrong_asset`, …) with
   `invalidMessage` left `undefined` on essentially every path. The reference
   passes those straight through, so an integrator gets a code and no sentence.
   I map all 30-odd codes to human-readable messages (`facilitator/src/reasons.ts`)
   and the HTTP layer refuses to emit a rejection without both.
2. **Unsupported scheme/network becomes a bare 500.** `x402Facilitator.verify()`
   *throws* — rather than returning a rejection — when no scheme is registered
   for the requested pair. The reference catches it and answers
   `500 {"error": "Internal Server Error"}`. I classify the throw and answer
   `200 {isValid: false, invalidReason: "unsupported_scheme_or_network", …}`.
3. **Malformed-request responses are a different shape.** The reference returns
   `400 {"error": "..."}`, which is neither a `VerifyResponse` nor a
   `SettleResponse`. I return the protocol shape with the reason fields
   populated, so a client only has to understand one schema.
4. **No conformance harness.** The reference's tests mock `@x402/core` and
   `@x402/stellar` entirely (`vi.mock`), so they prove the Express wiring and
   nothing about whether a real client can pay. That is the gap my
   `conformance/` harness exists to fill.
5. **The demo cannot be reproduced without a manual faucet visit.** The paywall
   server passes `price` as a `Money` string, which `ExactStellarScheme.parsePrice`
   resolves to USDC. Testnet USDC comes from the Circle web faucet, so a clean
   clone cannot reach a working payment unattended. I pass `price` as an
   explicit `AssetAmount` and default it to the native XLM SAC, which Friendbot
   funds — see §3.
6. **Root `pnpm build` fails from a clean clone.** `@x402-stellar/paywall`'s
   `codegen` step runs before `@x402-stellar/shared` has been built and dies on
   `Could not resolve "@x402-stellar/shared"`. Building `packages/shared` first
   fixes it. Looks like a missing turbo dependency edge.

### Checkpoint 1 (reference stack settles a real payment)

Cleared. A payment built by the stock client scheme and settled through the
**unmodified reference facilitator**:

```
tx      09de557e5452f0992ecab42992fa37b3dbec79f5b4b5a435d1050c3a7e8b146e
ledger  4091144   successful: true   fee_charged: 20554 stroops
source  GB5HPDJNCJUMRDGMEACLSCO3EL37FPCGSILK6Z6T52HT374W7VRE6VPI  (the facilitator, not the payer)
```

I ran it with the native XLM SAC rather than USDC, for the funding reason
above. The full paywall-server + browser-client path was not exercised, because
it is USDC-only.

---

## 2. Protocol shapes, confirmed against the packages

Read off `@x402/core@2.21.0` types rather than documentation:

```ts
PaymentRequirements = { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }
PaymentPayload      = { x402Version, accepted: PaymentRequirements, payload, resource?, extensions? }
VerifyResponse      = { isValid, invalidReason?, invalidMessage?, payer?, extra? }
SettleResponse      = { success, transaction, network, errorReason?, errorMessage?, payer?, amount? }
SupportedResponse   = { kinds: [{ x402Version, scheme, network, extra? }], extensions, signers }
```

Worth knowing:

- The rejection field is `invalidReason` on verify and `errorReason` on settle —
  there is no field literally called `reason`.
- `amount` is a string of **atomic units**. Stellar assets carry 7 decimals, so
  `"100000"` is 0.01.
- In x402 v2 the 402 response body is empty (`{}`); the payment terms travel in
  the `PAYMENT-REQUIRED` header as base64 JSON. Anything parsing the body for
  an `accepts` array is reading v1.
- The Stellar `exact` payload is `{ transaction: <base64 envelope> }` and must
  be passed through byte-for-byte.
- `ExactStellarScheme` (facilitator) takes `areFeesSponsored` (default `true`)
  and surfaces it through `getExtra()` into `/supported`, and the resource
  server copies it into the 402's `accepts[].extra`.

---

## 3. Choosing the payment asset

`ExactStellarScheme.parsePrice` accepts either `Money` (`"0.01"`, which
resolves to that network's USDC) or an explicit `AssetAmount`
(`{ asset: "C…", amount: "100000" }`). The scheme is asset-agnostic — it moves
whatever SEP-41 token contract the requirements name.

I default to the **native XLM Stellar Asset Contract**
(`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` on testnet) because
Friendbot funds XLM. That is what makes `./demo.sh` work from a clean clone with
no faucet visit, no wallet, and no shared secret — and what lets CI create fresh
accounts on every run instead of guarding a long-lived funded key.

`PAYMENT_ASSET=usdc` switches to testnet USDC
(`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`). Two extra steps
apply to any classic asset, and both are easy to lose an hour to:

1. **Both** the payer and the recipient need a trustline to the issuer. A SAC
   transfer to an account that does not trust the asset fails in simulation with
   an opaque contract error, not "missing trustline".
   `scripts/add-usdc-trustlines.mjs` adds them.
2. Testnet USDC comes from <https://faucet.circle.com/>, which is a web form
   with no scriptable API — hence the native XLM default.

Verified: the same code settled 0.01 USDC in
`538e1d8355e772cac97a8e3720e0f94ea1201941cf4d06f16f369eb885bc8cd3` (buyer
20.00 → 19.99, seller 0.00 → 0.01, fee paid by the facilitator). Any other `C…`
SEP-41 address works too.

---

## 4. Things that bit me on real testnet

### 4.1 RPC ledger-height skew breaks otherwise valid payments

The client and the facilitator each read the current ledger from Soroban RPC and
independently compute how far ahead an authorization entry may expire:

```
client:      expiration = latestLedger_client + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)
facilitator: rejects if expiration > latestLedger_facilitator + ceil(same) + 2
```

`https://soroban-testnet.stellar.org` is load-balanced across nodes at different
heights. Ten rapid `getLatestLedger()` calls returned a **3-ledger spread**:

```
4091566 4091564 4091567 4091567 4091564 4091567 4091564 4091564 4091564 4091564
```

The package's tolerance is 2 (`SIGNATURE_EXPIRATION_LEDGER_TOLERANCE`). Since
both sides derive the same offset, the check reduces to
`clientLedger - facilitatorLedger > 2`: purely a function of which node each
request reached. When the client's read lands on a node ≥3 ahead of the
facilitator's, a perfectly good payment is rejected as
`invalid_exact_stellar_signature_expiration_too_far`.

**How often, measured.** The honest answer is that it depends entirely on the
state of the RPC pool, and I have seen both extremes:

| Window | Where | Payments | Failed | Skew events |
|---|---|---|---|---|
| 2026-08-11 ~19:50-20:10 UTC | local, interactive | ~8-10 (reconstructed from logs) | 1 | 2 (one absorbed by the retry) |
| 2026-08-12 ~05:00-06:00 UTC | local, controlled | 30 | 0 | 0 |
| 2026-08-12 14:17 UTC | GitHub runners (probe) | 15 | 0 | 0 |
| 2026-08-12 14:56 UTC | GitHub runners (probe) | 15 | **1** | **1, retry exhausted** |

In the healthy window I also sampled the failure predicate directly — read the
ledger, wait 1.2s, read again, 299 times — and never once saw the client read
land more than 0 ledgers ahead (`{0: 182, -1: 117}`). So in that window the
un-retried failure rate was also indistinguishable from zero, and the 30/30
success rate does **not** demonstrate the retry working: the retry never fired.
What the retry demonstrably did is rescue the one `/settle` occurrence in the
degraded window.

**My mitigation, and its measured limit.** The facilitator retries that one
rejection up to twice, 750ms apart (`facilitator/src/app.ts`). It re-samples the
ledger height and relaxes nothing: the package's check runs in full on every
attempt, and settle only retries when nothing was submitted.

The 14:56 UTC probe caught it failing. All three attempts landed inside ~2.9s:

```
14:57:35.974  /verify  retry attempt 1   ...signature_expiration_too_far
14:57:37.047  /verify  retry attempt 2   ...signature_expiration_too_far
14:57:38.123  /verify  rejected          ...signature_expiration_too_far
```

A ledger closes every ~5s, so the whole retry window fitted inside one ledger.
Re-sampling can only help by reaching a different node, or by the lagging node
advancing; within 2.9s neither is guaranteed and neither happened.

**Fixed as of 2026-08-12:** the backoff now spans a full ledger close. The retry
is 2 attempts, 6s apart, both configurable (`LEDGER_SKEW_RETRIES`,
`LEDGER_SKEW_RETRY_DELAY_MS`), and `loadConfig` refuses a combination exceeding
a 24s budget because a resource server stops waiting at 30s. Worst case this
adds ~12s of backoff plus verification time to a genuine rejection — a
deliberate trade: a slow "no" beats a lost payment.

**This fix is unvalidated in the wild.** The reasoning is sound and
`test/retry.test.ts` asserts the attempt count and the spacing with fake
timers, but no degraded window has occurred since the change. I have fixed the
mechanism; I have not yet watched it save a payment. The probe keeps running,
and `scripts/collect-probe-results.sh` will show a non-zero `skewRetries`
column against a passing run the first time it does.

**The real fix** belongs upstream: either the client should ask the facilitator
what expiration it will accept, or both sides should pin the same RPC node, or
the tolerance should exceed the observed node spread. Written up as a bug report
for `x402-foundation/x402`; not my call to file it under this repo's name.

### 4.2 One in-flight settlement at a time

Single-signer mode means every settlement consumes the facilitator account's
sequence number. Observed settle latency on testnet is **9-15 seconds**
(simulate, assemble, submit, poll for inclusion), so a second payment arriving
inside that window can collide. Once, an overlapping settlement produced a
transaction hash that never reached a ledger (`404` on Horizon) and surfaced as
`settle_exact_stellar_transaction_failed`.

This is exactly what the reference's channel-account mode solves and it is
**deliberately out of scope for this MVP**. The facilitator is a demo, not a
throughput system. The conformance harness makes exactly one on-chain
settlement per run for this reason.

### 4.3 A settled payment does not stop verifying instantly

`/verify` simulates against whatever ledger the RPC node it reaches has applied.
Immediately after settlement, a lagging node still simulates the spent
authorization successfully, so `/verify` can answer "valid" for a payment that is
already spent — for a few seconds. Re-settlement still fails, because the
authorization nonce is consumed on-chain, so this is a staleness window rather
than a double-spend: settlement is the authority, verification is advice. The
conformance harness polls for up to 45s rather than asserting instantaneity.

### 4.4 The resource server races its own facilitator at startup

`paymentMiddleware(..., syncFacilitatorOnStart = true)` fetches `/supported` when
the middleware is *constructed*. Start both processes together and that fetch
fails, leaving the first request to a protected route answering 500 instead of
402. The demo server now waits for the facilitator's `/supported` before
constructing the middleware.

---

## 5. Licensing

Every transitive dependency across all three packages, by license:

```
393 MIT · 22 Apache-2.0 · 13 ISC · 12 BSD-3-Clause · 4 BSD-2-Clause · 1 Unlicense
```

No GPL, AGPL, SSPL, BUSL or non-commercial licenses anywhere in the tree. I
took no code from the AGPL "Built on Stellar" facilitator or the OpenZeppelin
Relayer x402 plugin; the implementation comes from the Apache-2.0
`@x402/stellar` package and this repository ships under Apache-2.0.
