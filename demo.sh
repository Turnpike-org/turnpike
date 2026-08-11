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
npm run conformance
