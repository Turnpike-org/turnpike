# Security policy

Turnpike moves money. It is currently a testnet-only implementation, but the
same code paths are intended for mainnet, so I treat reports against testnet as
seriously as I will treat reports against production.

## Reporting a vulnerability

**Do not open a public issue for a security report.**

**Preferred:** GitHub private vulnerability reporting — the *Report a
vulnerability* button on the
[repository's Security tab](https://github.com/Turnpike-org/turnpike/security/advisories/new).
It is private, it threads the discussion with the fix, and it lands in
notifications rather than an inbox where it can be missed.

**Alternative:** email **jagadeesh.b@grainlify.com**.

A useful report includes:

- what you were able to do, and the impact you believe it has;
- the steps or a script to reproduce it, ideally against a clean clone
  (`./demo.sh` gives you a working stack with funded testnet accounts);
- the commit or released version you tested;
- whether you have disclosed it anywhere else.

You do not need a working exploit. A precise description of a flaw in the
verification or settlement path is more valuable than a partial proof of
concept.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | 3 working days |
| Initial assessment, with a severity and a plan | 10 working days |
| Fix or documented mitigation for critical and high findings | 30 days from assessment |

If I disagree that a report is a vulnerability I will say so, and why, rather
than letting it go quiet.

I will credit reporters who want credit, and respect a request to stay
anonymous. I do not currently run a paid bounty programme.

## Disclosure

I prefer coordinated disclosure. Once a fix ships, I will publish what the
issue was, what it allowed, and what changed — the same standard the rest of
this repository is written to. If a report affects an upstream dependency such
as `@x402/stellar` or the x402 specification, I will report it upstream and say
so in my own disclosure.

## Supported versions

Turnpike has not yet cut a tagged release. Until it does, **`main` is the only
supported version** and fixes land there.

| Version | Supported |
|---|---|
| `main` | Yes |
| Any earlier commit | No — update to `main` |

After the first tagged release this table will list supported release lines.

## Scope

**In scope**

- The facilitator service: `/verify`, `/settle`, `/supported`, `/health`, and
  their error handling.
- The demo resource server and the conformance harness, where a flaw would
  mislead someone assessing whether Turnpike works.
- The setup and deployment path: anything that could cause a key to leak, an
  account to be drained, or a payment to be misdirected.
- Dependency and supply-chain issues affecting the above.

**Out of scope**

- The Stellar network, Soroban RPC providers, and Friendbot.
- `@x402/stellar` and `@x402/core` themselves — report those to the
  [x402 Foundation](https://github.com/x402-foundation/x402), though I am glad
  to help route a report.
- Findings that require a compromised operator machine or a leaked key that I
  did not leak.
- The known limitations already documented in
  [`NOTES.md`](NOTES.md) §4 — the RPC ledger-skew defect, `/verify` staleness
  after settlement, and single-in-flight settlement. If you can show one of
  these is worse than documented, that *is* in scope.

## What Turnpike does not hold

Stated so reporters know where the value is not:

- Turnpike never holds payer or seller funds. Payments move directly between the
  payer and the recipient named in the payer's signed authorization entry.
- Turnpike never receives a payer's signing key. Authorization entries are
  signed client-side.
- Turnpike's own account holds XLM for sponsoring network fees. Draining it is a
  denial-of-service against fee sponsorship, not a theft of user funds — still
  worth reporting.

The recipient and amount are bound inside the payer's signature, so a
compromised facilitator cannot redirect a payment or inflate a charge. If you
find a way to do either, that is a critical finding and I want to hear about it
immediately.
