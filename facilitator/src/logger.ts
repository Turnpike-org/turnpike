import pino, { type Logger } from "pino";

/**
 * Creates the process logger.
 *
 * @param level - Pino log level
 * @returns Configured logger
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "x402-stellar-facilitator" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // A secret key should never reach a log line, but if some future change
      // logs a config object wholesale, redact rather than leak.
      paths: ["facilitatorSecretKey", "*.facilitatorSecretKey", "FACILITATOR_SECRET_KEY"],
      censor: "[redacted]",
    },
  });
}

/** One structured line per facilitator request — the demo's debugging surface. */
export type RequestOutcome = {
  endpoint: string;
  outcome: "valid" | "invalid" | "settled" | "failed" | "ok" | "error";
  reason?: string;
  transaction?: string;
  payer?: string;
  latencyMs: number;
  status: number;
};
