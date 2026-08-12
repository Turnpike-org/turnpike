import { x402Facilitator } from "@x402/core/facilitator";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import type { Logger } from "pino";

import type { Config } from "./config.js";
import type { RequestOutcome } from "./logger.js";
import { LOCAL_REASONS, classifyError, describeReason, errorDetail } from "./reasons.js";
import { validateSettleRequest, validateVerifyRequest } from "./validation.js";

/**
 * Whether this deployment sponsors network fees, advertised in `/supported`.
 *
 * This is `true` because of how settlement actually works here, not as a
 * marketing claim: the facilitator's own account is the source account of every
 * settlement transaction, so it pays the Soroban resource fee and the payer
 * needs no XLM. `startupSelfCheck()` refuses to boot if that account is not
 * funded, so the claim cannot quietly become false in a running deployment.
 */
export const FEES_ARE_SPONSORED = true;

export type FacilitatorApp = {
  app: Express;
  facilitator: x402Facilitator;
  facilitatorAddress: string;
};

/**
 * Builds the x402 facilitator with the Stellar `exact` scheme registered.
 *
 * All cryptography — authorization-entry validation, transaction assembly,
 * submission — belongs to `@x402/stellar`. This service is the HTTP surface
 * around it and nothing more.
 *
 * @param config - Validated configuration
 * @param logger - Logger for scheme-level lifecycle events
 * @returns The configured facilitator
 */
export function createFacilitator(config: Config, logger: Logger): x402Facilitator {
  const signer = createEd25519Signer(config.facilitatorSecretKey, config.network);

  const scheme = new ExactStellarScheme([signer], {
    rpcConfig: { url: config.rpcUrl },
    areFeesSponsored: FEES_ARE_SPONSORED,
    maxTransactionFeeStroops: config.maxTransactionFeeStroops,
  });

  return new x402Facilitator()
    .onVerifyFailure(async (context) => {
      logger.debug({ err: context.error }, "scheme reported verify failure");
    })
    .onSettleFailure(async (context) => {
      logger.debug({ err: context.error }, "scheme reported settle failure");
    })
    .register(config.network, scheme);
}

/**
 * The one rejection worth retrying.
 *
 * The client and the facilitator each read the current ledger from Soroban RPC
 * and independently compute how far ahead an authorization may expire. The
 * public testnet endpoint is load-balanced across nodes whose heights differ by
 * up to 3 ledgers (measured), while `@x402/stellar` tolerates a 2-ledger
 * disagreement. When the client's read lands on a node ahead of the
 * facilitator's, a perfectly good payment is rejected as expiring "too far" in
 * the future.
 *
 * Retrying re-samples the ledger height, which is exactly what a client's own
 * retry would do. It relaxes nothing: the check still runs in full, in the
 * package, on every attempt.
 *
 * **The backoff must outlast a ledger.** An earlier version retried twice,
 * 750ms apart, and a probe caught it losing a payment anyway: all three
 * attempts landed inside 2.9 seconds, so the lagging node never advanced and
 * every attempt saw the same divergence. Re-sampling only helps if it reaches a
 * different node *or* the laggard catches up, and only the second is
 * guaranteed — after a ledger closes, roughly every 5 seconds. The default
 * delay is therefore 6s, comfortably past one close.
 *
 * This costs latency on genuine rejections. That is the intended trade: a slow
 * "no" beats losing a valid payment.
 */
const LEDGER_SKEW_REASON = "invalid_exact_stellar_signature_expiration_too_far";

/**
 * Runs an operation, retrying only the ledger-skew rejection above.
 *
 * @param operation - The verify or settle call
 * @param rejectionReason - Extracts the rejection code from a result, or undefined when it succeeded
 * @param logger - Logger for retry visibility
 * @param label - Endpoint name for the log line
 * @param retries - How many extra attempts to make
 * @param delayMs - How long to wait between attempts
 * @returns The last result produced
 */
export async function withLedgerSkewRetry<T>(
  operation: () => Promise<T>,
  rejectionReason: (result: T) => string | undefined,
  logger: Logger,
  label: string,
  retries: number,
  delayMs: number,
): Promise<T> {
  let result = await operation();

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (rejectionReason(result) !== LEDGER_SKEW_REASON) return result;
    logger.warn(
      { endpoint: label, attempt, delayMs, reason: LEDGER_SKEW_REASON },
      "retrying after RPC ledger-height skew",
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await operation();
  }

  return result;
}

/**
 * Guarantees a verify rejection carries both a code and a sentence.
 *
 * @param response - Response from the scheme
 * @returns The response, with `invalidReason` and `invalidMessage` populated when invalid
 */
function withVerifyReason(response: VerifyResponse): VerifyResponse {
  if (response.isValid) return response;
  const invalidReason = response.invalidReason?.trim() || LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR;
  return {
    ...response,
    invalidReason,
    invalidMessage: response.invalidMessage?.trim() || describeReason(invalidReason),
  };
}

/**
 * Guarantees a settle failure carries both a code and a sentence.
 *
 * @param response - Response from the scheme
 * @returns The response, with `errorReason` and `errorMessage` populated when failed
 */
function withSettleReason(response: SettleResponse): SettleResponse {
  if (response.success) return response;
  const errorReason = response.errorReason?.trim() || LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR;
  return {
    ...response,
    errorReason,
    errorMessage: response.errorMessage?.trim() || describeReason(errorReason),
  };
}

/**
 * Asserts that `/supported` advertises the Stellar `exact` entry with a
 * well-formed, truthful `extra` block.
 *
 * Called at startup so a misconfiguration fails loudly at boot rather than
 * silently advertising something untrue to clients.
 *
 * @param supported - The `/supported` response to check
 * @param network - The network that must be present
 * @throws {Error} When the Stellar entry is missing or its `extra` block is wrong
 */
export function assertSupportedIsTruthful(
  supported: {
    kinds: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }[];
  },
  network: string,
): void {
  const kind = supported.kinds.find((k) => k.network === network && k.scheme === "exact");
  if (!kind) {
    throw new Error(`/supported does not advertise the 'exact' scheme on ${network}`);
  }
  const sponsored = kind.extra?.areFeesSponsored;
  if (typeof sponsored !== "boolean") {
    throw new Error(
      `/supported entry for ${network} must include a boolean 'extra.areFeesSponsored'; got ${JSON.stringify(sponsored)}`,
    );
  }
  if (sponsored !== FEES_ARE_SPONSORED) {
    throw new Error(
      `/supported advertises areFeesSponsored=${sponsored} but this deployment sponsors fees=${FEES_ARE_SPONSORED}`,
    );
  }
}

/**
 * Creates the facilitator HTTP application.
 *
 * @param config - Validated configuration
 * @param logger - Request logger
 * @returns The Express app plus the facilitator it wraps
 */
export function createApp(config: Config, logger: Logger): FacilitatorApp {
  const facilitator = createFacilitator(config, logger);
  const app: Express = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins === "*" ? "*" : config.corsOrigins.split(",") }));
  app.use(express.json({ limit: "256kb" }));

  // The facilitator pays real network fees out of its own account, so cap how
  // fast anyone can make it do that.
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "rate_limited",
      message: "Too many requests to this facilitator; retry in a minute.",
    },
  });

  /**
   * Emits the one structured line per request that the demo is debugged from.
   *
   * @param outcome - What happened
   */
  function logOutcome(outcome: RequestOutcome): void {
    logger.info(outcome, `${outcome.endpoint} ${outcome.outcome}`);
  }

  app.post("/verify", limiter, async (req: Request, res: Response): Promise<void> => {
    const startedAt = performance.now();
    const invalidRequest = validateVerifyRequest(req.body);

    if (invalidRequest) {
      const body: VerifyResponse = {
        isValid: false,
        invalidReason: LOCAL_REASONS.INVALID_REQUEST_BODY,
        invalidMessage: invalidRequest,
      };
      logOutcome({
        endpoint: "/verify",
        outcome: "invalid",
        reason: body.invalidReason,
        latencyMs: Math.round(performance.now() - startedAt),
        status: 400,
      });
      res.status(400).json(body);
      return;
    }

    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    try {
      const response = withVerifyReason(
        await withLedgerSkewRetry(
          () => facilitator.verify(paymentPayload, paymentRequirements),
          (result) => (result.isValid ? undefined : result.invalidReason),
          logger,
          "/verify",
          config.ledgerSkewRetries,
          config.ledgerSkewRetryDelayMs,
        ),
      );
      logOutcome({
        endpoint: "/verify",
        outcome: response.isValid ? "valid" : "invalid",
        reason: response.invalidReason,
        payer: response.payer,
        latencyMs: Math.round(performance.now() - startedAt),
        status: 200,
      });
      res.status(200).json(response);
    } catch (error) {
      // The core facilitator throws for unregistered scheme/network pairs and
      // for RPC failures. A rejection must still explain itself.
      const reason = classifyError(error);
      const isClientFault = reason === LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK;
      const body: VerifyResponse = {
        isValid: false,
        invalidReason: reason,
        invalidMessage: `${describeReason(reason)} (detail: ${errorDetail(error)})`,
      };
      logger.warn({ err: error, reason }, "verify raised");
      logOutcome({
        endpoint: "/verify",
        outcome: isClientFault ? "invalid" : "error",
        reason,
        latencyMs: Math.round(performance.now() - startedAt),
        status: isClientFault ? 200 : 502,
      });
      res.status(isClientFault ? 200 : 502).json(body);
    }
  });

  app.post("/settle", limiter, async (req: Request, res: Response): Promise<void> => {
    const startedAt = performance.now();
    const invalidRequest = validateSettleRequest(req.body);

    if (invalidRequest) {
      const body: SettleResponse = {
        success: false,
        transaction: "",
        network: (req.body?.paymentRequirements?.network as Network) ?? config.network,
        errorReason: LOCAL_REASONS.INVALID_REQUEST_BODY,
        errorMessage: invalidRequest,
      };
      logOutcome({
        endpoint: "/settle",
        outcome: "failed",
        reason: body.errorReason,
        latencyMs: Math.round(performance.now() - startedAt),
        status: 400,
      });
      res.status(400).json(body);
      return;
    }

    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    try {
      const response = withSettleReason(
        await withLedgerSkewRetry(
          () => facilitator.settle(paymentPayload, paymentRequirements),
          // Only retry when settlement failed *before* submitting anything —
          // a failure carrying a transaction hash must never be retried.
          (result) => (!result.success && !result.transaction ? result.errorReason : undefined),
          logger,
          "/settle",
          config.ledgerSkewRetries,
          config.ledgerSkewRetryDelayMs,
        ),
      );
      logOutcome({
        endpoint: "/settle",
        outcome: response.success ? "settled" : "failed",
        reason: response.errorReason,
        transaction: response.transaction || undefined,
        payer: response.payer,
        latencyMs: Math.round(performance.now() - startedAt),
        status: 200,
      });
      res.status(200).json(response);
    } catch (error) {
      const reason = classifyError(error);
      const body: SettleResponse = {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        errorReason: reason,
        errorMessage: `${describeReason(reason)} (detail: ${errorDetail(error)})`,
      };
      logger.warn({ err: error, reason }, "settle raised");
      logOutcome({
        endpoint: "/settle",
        outcome: "failed",
        reason,
        latencyMs: Math.round(performance.now() - startedAt),
        status: 502,
      });
      res.status(502).json(body);
    }
  });

  app.get("/supported", limiter, (_req: Request, res: Response): void => {
    const startedAt = performance.now();
    const supported = facilitator.getSupported();
    logOutcome({
      endpoint: "/supported",
      outcome: "ok",
      latencyMs: Math.round(performance.now() - startedAt),
      status: 200,
    });
    res.status(200).json(supported);
  });

  app.get("/health", (_req: Request, res: Response): void => {
    res.status(200).json({
      status: "ok",
      network: config.network,
      facilitator: config.facilitatorAddress,
      areFeesSponsored: FEES_ARE_SPONSORED,
    });
  });

  app.use((_req: Request, res: Response): void => {
    res.status(404).json({
      error: "not_found",
      message:
        "Unknown endpoint. This facilitator serves POST /verify, POST /settle, GET /supported and GET /health.",
    });
  });

  // Express needs all four parameters to recognise error middleware.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    const reason = classifyError(err);
    logger.error({ err, reason }, "unhandled error");
    if (!res.headersSent) {
      res.status(500).json({
        error: reason,
        message: `${describeReason(reason)} (detail: ${errorDetail(err)})`,
      });
    }
  });

  return { app, facilitator, facilitatorAddress: config.facilitatorAddress };
}
