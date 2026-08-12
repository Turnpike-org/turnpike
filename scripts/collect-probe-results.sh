#!/usr/bin/env bash
#
# Aggregates every completed `flakiness probe` workflow run into raw per-payment
# counts.
#
#   ./scripts/collect-probe-results.sh
#
# Needs the GitHub CLI, authenticated with read access to the repository
# (`gh auth login`). Nothing else — no local state, no prior run, no context
# from whoever set the probe up. Downloads are cached under
# .probe-results/<run-id>/ so re-running is cheap; delete that directory to
# force a re-fetch.
#
# Why this exists
# ---------------
# The Stellar `exact` scheme's client and facilitator each read the current
# ledger from Soroban RPC and independently compute how far ahead an
# authorization may expire, tolerating a 2-ledger disagreement. The public
# testnet RPC endpoint is load-balanced across nodes that are not always within
# 2 ledgers of each other, so a valid payment is sometimes rejected as
# `invalid_exact_stellar_signature_expiration_too_far` (NOTES.md §4.1).
#
# The facilitator retries that specific rejection. The number to watch below is
# `skewRetries`: it is non-zero only when the pool actually diverged. Every
# measured window so far has reported zero, which means the retry path is
# implemented but has never been exercised under measurement — see the
# Reliability section of README.md before quoting any of these numbers.
set -uo pipefail

cd "$(dirname "$0")/.."

REPO=${PROBE_REPO:-Turnpike-org/turnpike}
WORK=${PROBE_CACHE:-.probe-results}

command -v gh >/dev/null 2>&1 || { echo "gh (GitHub CLI) is required: https://cli.github.com" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated. Run: gh auth login" >&2; exit 2; }

mkdir -p "$WORK"

runs=$(gh run list --repo "$REPO" --workflow flakiness-probe.yml --limit 100 \
        --json databaseId,status,conclusion,createdAt,event \
        --jq '.[] | select(.status == "completed") | "\(.databaseId) \(.createdAt) \(.event) \(.conclusion)"')

if [ -z "$runs" ]; then
  echo "No completed probe runs found in $REPO."
  echo "Dispatch one with:  gh workflow run flakiness-probe.yml --repo $REPO"
  exit 0
fi

while read -r id created event conclusion; do
  dir="$WORK/$id"
  [ -d "$dir" ] && continue
  mkdir -p "$dir"
  echo "fetching probe $id ($created)..." >&2
  gh run download "$id" --repo "$REPO" -D "$dir" >/dev/null 2>&1 \
    || echo "  no artifacts for run $id (expired or failed before upload)" >&2
  printf '%s %s %s\n' "$created" "$event" "$conclusion" > "$dir/.meta"
done <<< "$runs"

node -e '
const fs = require("fs");
const path = require("path");
const work = process.argv[1];

const rows = [];
for (const runId of fs.readdirSync(work)) {
  const runDir = path.join(work, runId);
  if (!fs.statSync(runDir).isDirectory()) continue;

  const metaPath = path.join(runDir, ".meta");
  const meta = fs.existsSync(metaPath)
    ? fs.readFileSync(metaPath, "utf8").trim().split(" ")
    : ["?", "?", "?"];

  for (const shardDir of fs.readdirSync(runDir)) {
    const file = path.join(runDir, shardDir, "shard-results.json");
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const row of parsed) rows.push({ runId, when: meta[0], event: meta[1], ...row });
  }
}

if (rows.length === 0) {
  console.log("No shard results found. Artifacts expire after 90 days by default.");
  process.exit(0);
}

rows.sort((a, b) =>
  (a.when + String(a.shard) + String(a.run)).localeCompare(b.when + String(b.shard) + String(b.run)),
);

console.log("when                 probe        shard run exit checks   skewRetries");
for (const r of rows) {
  console.log(
    [
      r.when.replace("T", " ").replace("Z", ""),
      String(r.runId).padEnd(12),
      String(r.shard).padEnd(5),
      String(r.run).padEnd(3),
      String(r.exit).padEnd(4),
      `${r.passed}/${r.passed + r.failed}`.padEnd(8),
      r.skewRetries,
    ].join(" "),
  );
}

const failed = rows.filter((r) => r.exit !== 0 || r.failed > 0);
const withSkew = rows.filter((r) => r.skewRetries > 0);

console.log();
console.log(`probe runs collected  : ${new Set(rows.map((r) => r.runId)).size}`);
console.log(`payments              : ${rows.length}`);
console.log(`failed payments       : ${failed.length}`);
console.log(`payments w/ skew retry: ${withSkew.length}`);
console.log(`total skew retries    : ${rows.reduce((a, r) => a + r.skewRetries, 0)}`);

if (withSkew.length) {
  console.log("\nskew events (the RPC pool diverged; retry path exercised):");
  for (const r of withSkew) {
    console.log(`  ${r.when} probe ${r.runId} shard ${r.shard} run ${r.run}: ${r.skewRetries} retries, exit ${r.exit}`);
  }
  console.log("\nFacilitator logs for those runs are in the same cache directory:");
  console.log("  grep -l \"ledger-height skew\" " + work + "/*/probe-shard-*/facilitator-shard-*.log");
}

if (failed.length) {
  console.log("\nfailed payments:");
  for (const r of failed) {
    console.log(`  ${r.when} probe ${r.runId} shard ${r.shard} run ${r.run}: exit ${r.exit}, ${r.passed} passed / ${r.failed} failed`);
  }
}
' "$WORK"
