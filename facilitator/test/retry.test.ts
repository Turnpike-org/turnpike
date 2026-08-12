import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withLedgerSkewRetry } from "../src/app.js";

const SKEW = "invalid_exact_stellar_signature_expiration_too_far";
const silentLogger = pino({ level: "silent" });

/**
 * Extracts a rejection code, matching how the endpoints call the wrapper.
 *
 * @param result - A fake verify-like result
 * @returns The reason when rejected, undefined when accepted
 */
const reasonOf = (result: { ok: boolean; reason?: string }): string | undefined =>
  result.ok ? undefined : result.reason;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Runs the wrapper with fake timers, advancing through every scheduled delay.
 *
 * @param operation - The operation under test
 * @param retries - Retry count
 * @param delayMs - Delay between attempts
 * @returns The wrapper's result
 */
async function runWithTimers<T>(
  operation: () => Promise<T>,
  retries: number,
  delayMs: number,
): Promise<T> {
  const promise = withLedgerSkewRetry(
    operation,
    reasonOf as (result: T) => string | undefined,
    silentLogger,
    "/verify",
    retries,
    delayMs,
  );
  await vi.runAllTimersAsync();
  return promise;
}

describe("withLedgerSkewRetry", () => {
  it("does not retry a successful result", async () => {
    const operation = vi.fn().mockResolvedValue({ ok: true });
    const result = await runWithTimers(operation, 2, 6_000);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it("does not retry a rejection for any other reason", async () => {
    const operation = vi.fn().mockResolvedValue({ ok: false, reason: "wrong_amount" });
    await runWithTimers(operation, 2, 6_000);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries the ledger-skew rejection and returns the first success", async () => {
    const operation = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: SKEW })
      .mockResolvedValueOnce({ ok: true });

    const result = await runWithTimers(operation, 2, 6_000);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
  });

  it("gives up after the configured number of retries", async () => {
    const operation = vi.fn().mockResolvedValue({ ok: false, reason: SKEW });
    const result = await runWithTimers(operation, 2, 6_000);

    // One initial attempt plus two retries.
    expect(operation).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, reason: SKEW });
  });

  it("waits long enough between attempts to outlast a ledger close", async () => {
    // The bug this replaced retried three times inside 2.9s — shorter than the
    // ~5s it takes a lagging node to close another ledger, so every attempt saw
    // the same stale view. Assert the spacing, not just the attempt count.
    const attemptTimes: number[] = [];
    const operation = vi.fn().mockImplementation(async () => {
      attemptTimes.push(Date.now());
      return { ok: false, reason: SKEW };
    });

    const start = Date.now();
    await runWithTimers(operation, 2, 6_000);

    expect(attemptTimes).toHaveLength(3);
    expect(attemptTimes[1]! - attemptTimes[0]!).toBeGreaterThanOrEqual(5_000);
    expect(attemptTimes[2]! - attemptTimes[1]!).toBeGreaterThanOrEqual(5_000);
    expect(attemptTimes[2]! - start).toBeGreaterThanOrEqual(10_000);
  });

  it("makes exactly one attempt when retries are disabled", async () => {
    const operation = vi.fn().mockResolvedValue({ ok: false, reason: SKEW });
    await runWithTimers(operation, 0, 6_000);

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
