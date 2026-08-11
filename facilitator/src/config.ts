import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";

/**
 * The only network this MVP supports. `stellar:pubnet` is deliberately out of
 * scope: nothing here has been reviewed for mainnet money, and advertising
 * support we do not have would be a lie in `/supported`.
 */
export const SUPPORTED_NETWORK = "stellar:testnet" as const;

/** Config field → the environment variable it comes from, for error messages. */
const ENV_NAMES: Record<string, string> = {
  facilitatorSecretKey: "FACILITATOR_SECRET_KEY",
  port: "FACILITATOR_PORT",
  network: "STELLAR_NETWORK",
  rpcUrl: "STELLAR_RPC_URL",
  maxTransactionFeeStroops: "MAX_TRANSACTION_FEE_STROOPS",
  logLevel: "LOG_LEVEL",
  corsOrigins: "CORS_ORIGINS",
};

const secretKeySchema = z
  .string()
  .min(1, "FACILITATOR_SECRET_KEY is required")
  .refine((value) => {
    try {
      Keypair.fromSecret(value);
      return true;
    } catch {
      return false;
    }
  }, "FACILITATOR_SECRET_KEY must be a valid Stellar secret key (starts with 'S', 56 characters)");

const configSchema = z.object({
  facilitatorSecretKey: secretKeySchema,
  port: z.coerce.number().int().positive().max(65535).default(4022),
  network: z.literal(
    SUPPORTED_NETWORK,
    `STELLAR_NETWORK must be "${SUPPORTED_NETWORK}" — this MVP is testnet-only`,
  ),
  rpcUrl: z.url("STELLAR_RPC_URL must be a valid URL").default("https://soroban-testnet.stellar.org"),
  maxTransactionFeeStroops: z.coerce.number().int().positive().default(1_000_000),
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  corsOrigins: z.string().default("*"),
});

export type Config = z.infer<typeof configSchema> & { facilitatorAddress: string };

/**
 * Reads and validates configuration from an environment-like record.
 *
 * Kept pure (takes the environment as an argument) so tests can exercise it
 * without mutating `process.env`.
 *
 * @param env - Environment variables to read from
 * @returns Validated configuration, including the derived facilitator address
 * @throws {Error} With every validation problem listed, when the environment is invalid
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    facilitatorSecretKey: env.FACILITATOR_SECRET_KEY,
    port: env.FACILITATOR_PORT,
    network: env.STELLAR_NETWORK ?? SUPPORTED_NETWORK,
    rpcUrl: env.STELLAR_RPC_URL,
    maxTransactionFeeStroops: env.MAX_TRANSACTION_FEE_STROOPS,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => {
        const field = String(issue.path[0] ?? "");
        return `  - ${ENV_NAMES[field] ?? (field || "(root)")}: ${issue.message}`;
      })
      .join("\n");
    throw new Error(
      `Invalid facilitator configuration:\n${problems}\n` +
        `See .env.example, or run 'npm run setup' to generate funded testnet accounts.`,
    );
  }

  return {
    ...parsed.data,
    facilitatorAddress: Keypair.fromSecret(parsed.data.facilitatorSecretKey).publicKey(),
  };
}

/**
 * Horizon endpoint matching the configured network. Used only for the startup
 * funding preflight, not for settlement.
 *
 * @returns Horizon base URL for testnet
 */
export function horizonUrl(): string {
  return "https://horizon-testnet.stellar.org";
}
