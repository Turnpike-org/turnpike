import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  LOCAL_REASONS,
  REASON_MESSAGES,
  classifyError,
  describeReason,
} from "../src/reasons.js";

const require = createRequire(import.meta.url);

/**
 * Extracts every reason-code literal the installed packages can emit.
 *
 * Reading the pinned build rather than a hand-written list means this test
 * fails when a dependency upgrade introduces a rejection we have no sentence
 * for — which is exactly when the reason table would silently rot.
 *
 * @param packageEntry - Module id to resolve
 * @returns The reason codes found in that build
 */
function reasonCodesEmittedBy(packageEntry: string): string[] {
  const file = require.resolve(packageEntry);
  const source = readFileSync(file, "utf8");
  const matches = source.matchAll(
    /(?:invalidVerifyResponse\(|invalidReason:\s*|errorReason:\s*)"([a-z0-9_]+)"/g,
  );
  return [...new Set([...matches].map((match) => match[1] as string))];
}

describe("reason table", () => {
  it("covers every reason code the pinned @x402/stellar build can emit", () => {
    const emitted = reasonCodesEmittedBy("@x402/stellar/exact/facilitator");
    expect(emitted.length).toBeGreaterThan(10);

    const missing = emitted.filter((code) => !(code in REASON_MESSAGES));
    expect(missing, `reason codes with no human message: ${missing.join(", ")}`).toEqual([]);
  });

  it("has a non-empty, non-generic message for every code", () => {
    for (const [code, message] of Object.entries(REASON_MESSAGES)) {
      expect(message.trim().length, `${code} has an empty message`).toBeGreaterThan(20);
      expect(message.toLowerCase()).not.toBe("error");
    }
  });

  it("never returns an empty description, even for unknown or missing codes", () => {
    for (const input of [undefined, null, "", "a_code_from_the_future"]) {
      const described = describeReason(input);
      expect(described.trim().length).toBeGreaterThan(20);
    }
    expect(describeReason("a_code_from_the_future")).toContain("a_code_from_the_future");
  });

  it("maps thrown errors to specific local reasons", () => {
    expect(
      classifyError(new Error("No facilitator registered for scheme: exact and network: eip155:1")),
    ).toBe(LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK);
    expect(classifyError(new Error("Settlement aborted: something"))).toBe(
      LOCAL_REASONS.SETTLEMENT_ABORTED,
    );
    expect(classifyError(new Error("fetch failed"))).toBe(LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE);
    expect(classifyError("weirdness")).toBe(LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR);
  });

  it("has a message for every local reason it can produce", () => {
    for (const code of Object.values(LOCAL_REASONS)) {
      expect(REASON_MESSAGES[code]).toBeTruthy();
    }
  });
});
