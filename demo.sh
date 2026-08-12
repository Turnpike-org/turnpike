#!/usr/bin/env bash
#
# One command, clean clone to settled testnet payment.
#
#   ./demo.sh
#
# Creates and funds testnet accounts if needed, brings the stack up with
# docker compose, then runs the conformance harness: a stock x402 client from
# public npm paying for real on Stellar testnet.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1mCannot start:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. preflight ─────────────────────────────────────────────────────────────
# Every check here is a failure someone actually hit while building this. Each
# one costs a second and turns a cryptic error into an instruction.

command -v node >/dev/null 2>&1 || die "Node.js is not installed. This demo needs Node 22.12 or newer."

node_major=$(node -p 'process.versions.node.split(".")[0]')
node_minor=$(node -p 'process.versions.node.split(".")[1]')
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
  die "Node $(node -v) is too old. The @x402 packages require >=22.12, and they fail at runtime rather than at install."
fi

if ! docker info >/dev/null 2>&1; then
  die "The Docker daemon is not reachable. Start Docker Desktop (or 'colima start'), or run the services
  directly instead:
    npm run install:all && npm run dev:facilitator   (in one shell)
                           npm run dev:demo-server   (in another)
                           npm run conformance       (in a third)"
fi

# A port in use is only a problem when something *other than this stack* holds
# it. Re-running ./demo.sh against an already-running stack is fine — but a
# stack left running by a different clone of this repo is not, because it will
# be paying to a different seller and the harness will fail confusingly.
for port in 4021 4022; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || continue

  health=$(curl -fsS --max-time 3 "http://localhost:$port/health" 2>/dev/null || true)
  case "$health" in
    *'"network":"stellar:testnet"'*)
      echo "     port $port already served by an x402 stack — 'docker compose up' will reuse or replace it"
      ;;
    *)
      holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -F c 2>/dev/null | sed -n 's/^c//p' | head -1)
      die "Port $port is held by something that is not this stack${holder:+ (process: $holder)}.
  Stop it and re-run, or change FACILITATOR_PORT / DEMO_SERVER_PORT in .env."
      ;;
  esac
done

# ── 1. accounts ──────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "1/4  Creating funded Stellar testnet accounts (Friendbot)"
  [ -d node_modules ] || npm install --no-audit --no-fund
  npm run setup
else
  say "1/4  Using existing .env"
fi

# ── 2. stack ─────────────────────────────────────────────────────────────────
say "2/4  Starting facilitator + demo resource server"
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Neither 'docker compose' nor 'docker-compose' is available." >&2
  echo "Install Docker, or run the services directly:" >&2
  echo "  npm run install:all && npm run dev:facilitator   (in one shell)" >&2
  echo "                        npm run dev:demo-server    (in another)" >&2
  exit 1
fi

$COMPOSE up --build -d

# ── 3. wait ──────────────────────────────────────────────────────────────────
say "3/4  Waiting for both services to report healthy"
for i in $(seq 1 60); do
  facilitator_ok=$(curl -fsS http://localhost:4022/health >/dev/null 2>&1 && echo yes || echo no)
  demo_ok=$(curl -fsS http://localhost:4021/health >/dev/null 2>&1 && echo yes || echo no)
  if [ "$facilitator_ok" = yes ] && [ "$demo_ok" = yes ]; then
    echo "     facilitator http://localhost:4022  ready"
    echo "     demo server http://localhost:4021  ready"
    break
  fi
  if [ "$i" = 60 ]; then
    echo "Services did not become healthy in 60s. Logs:" >&2
    $COMPOSE logs --tail 40 >&2
    exit 1
  fi
  sleep 1
done

# ── 4. pay ───────────────────────────────────────────────────────────────────
say "4/4  Running the conformance harness (stock x402 client, real testnet payment)"
[ -d conformance/node_modules ] || npm --prefix conformance ci --no-audit --no-fund

if ! npm run conformance; then
  cat >&2 <<'HINT'

The harness failed. Two causes are far more likely than a bug in this code:

  1. Stellar testnet was reset, wiping the accounts in .env.
     Fix:  npm run setup -- --force  &&  docker compose up -d  &&  npm run conformance

  2. Soroban RPC was lagging or unreachable. Payments simulate against it, and
     the public endpoint is load-balanced across nodes at different ledger
     heights (see NOTES.md section 4.1). Re-running usually succeeds.

Facilitator logs:  docker compose logs facilitator
HINT
  exit 1
fi
