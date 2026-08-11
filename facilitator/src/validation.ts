/**
 * Request-envelope validation.
 *
 * Deliberately shallow. This checks that a request is structurally an x402
 * verify/settle request; it does not inspect, normalise, or re-encode the
 * signed `transaction`. That field is passed to `@x402/stellar` byte-for-byte
 * as the client produced it — a facilitator that "helpfully" reshapes it breaks
 * every stock client, which is the one thing this service must not do.
 */

const G_ADDRESS = /^[GMC][A-Z2-7]{55}$/;
const C_ADDRESS = /^C[A-Z2-7]{55}$/;

/**
 * Checks a value is a plain object.
 *
 * @param value - Candidate
 * @returns Whether the value is a non-null, non-array object
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the `paymentRequirements` half of a request.
 *
 * @param requirements - Candidate requirements
 * @returns A human-readable problem description, or `null` when valid
 */
export function validatePaymentRequirements(requirements: unknown): string | null {
  if (!isObject(requirements)) {
    return "'paymentRequirements' must be an object.";
  }
  const { scheme, network, asset, amount, payTo, maxTimeoutSeconds } = requirements;

  if (typeof scheme !== "string" || scheme.length === 0) {
    return "'paymentRequirements.scheme' must be a non-empty string (this facilitator implements 'exact').";
  }
  if (typeof network !== "string" || !network.includes(":")) {
    return "'paymentRequirements.network' must be a CAIP-2 identifier such as 'stellar:testnet'.";
  }
  if (typeof asset !== "string" || !C_ADDRESS.test(asset)) {
    return "'paymentRequirements.asset' must be a Stellar contract address (C...) for the SEP-41 token being paid.";
  }
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    return "'paymentRequirements.amount' must be a string of digits: the amount in the asset's atomic units.";
  }
  if (typeof payTo !== "string" || !G_ADDRESS.test(payTo)) {
    return "'paymentRequirements.payTo' must be a Stellar address (G..., M... or C...) to receive the payment.";
  }
  if (typeof maxTimeoutSeconds !== "number" || !Number.isFinite(maxTimeoutSeconds)) {
    return "'paymentRequirements.maxTimeoutSeconds' must be a number.";
  }
  return null;
}

/**
 * Validates the `paymentPayload` half of a request.
 *
 * @param payload - Candidate payload
 * @returns A human-readable problem description, or `null` when valid
 */
export function validatePaymentPayload(payload: unknown): string | null {
  if (!isObject(payload)) {
    return "'paymentPayload' must be an object.";
  }
  if (typeof payload.x402Version !== "number") {
    return "'paymentPayload.x402Version' must be a number (this facilitator speaks x402 v2).";
  }
  if (!isObject(payload.accepted)) {
    return "'paymentPayload.accepted' must be the payment requirements object the client accepted.";
  }
  if (!isObject(payload.payload)) {
    return "'paymentPayload.payload' must be an object containing the signed 'transaction'.";
  }
  const transaction = (payload.payload as Record<string, unknown>).transaction;
  if (typeof transaction !== "string" || transaction.length === 0) {
    return "'paymentPayload.payload.transaction' must be the base64-encoded signed Stellar transaction, exactly as produced by the client.";
  }
  return null;
}

/**
 * Validates a `POST /verify` request body.
 *
 * @param body - Parsed request body
 * @returns A human-readable problem description, or `null` when valid
 */
export function validateVerifyRequest(body: unknown): string | null {
  if (!isObject(body)) {
    return "Request body must be a JSON object containing 'paymentPayload' and 'paymentRequirements'.";
  }
  return (
    validatePaymentPayload(body.paymentPayload) ??
    validatePaymentRequirements(body.paymentRequirements)
  );
}

/**
 * Validates a `POST /settle` request body.
 *
 * @param body - Parsed request body
 * @returns A human-readable problem description, or `null` when valid
 */
export function validateSettleRequest(body: unknown): string | null {
  return validateVerifyRequest(body);
}
