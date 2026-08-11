/**
 * Rejection-reason mapping.
 *
 * `@x402/stellar` returns machine-readable reason codes (`invalidReason` /
 * `errorReason`) and, on most paths, no human-readable message at all. The x402
 * spec lets that stand, but a facilitator that answers "invalid" without saying
 * why is unusable for whoever is integrating against it at 2am.
 *
 * So: every code the packages can emit is mapped to a sentence here, and the
 * HTTP layer refuses to return a rejection without both a code and a sentence.
 * `test/reasons.test.ts` asserts the table stays exhaustive and non-empty.
 */

/** Reasons produced by this service itself, rather than by the x402 packages. */
export const LOCAL_REASONS = {
  INVALID_REQUEST_BODY: "invalid_request_body",
  UNSUPPORTED_SCHEME_OR_NETWORK: "unsupported_scheme_or_network",
  SETTLEMENT_ABORTED: "settlement_aborted",
  UPSTREAM_RPC_UNAVAILABLE: "upstream_rpc_unavailable",
  FACILITATOR_INTERNAL_ERROR: "facilitator_internal_error",
} as const;

/**
 * Human-readable explanation for every reason code this facilitator can return.
 *
 * Sourced from `@x402/core` (protocol-level checks) and `@x402/stellar`
 * (`exact` scheme checks) at the pinned versions, plus this service's own codes.
 */
export const REASON_MESSAGES: Readonly<Record<string, string>> = {
  // ── This service ───────────────────────────────────────────────────────────
  [LOCAL_REASONS.INVALID_REQUEST_BODY]:
    "The request body is not a well-formed x402 verify/settle request: it must be JSON containing 'paymentPayload' and 'paymentRequirements' objects.",
  [LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK]:
    "This facilitator does not handle the requested scheme/network pair. It supports the 'exact' scheme on 'stellar:testnet' only — see GET /supported.",
  [LOCAL_REASONS.SETTLEMENT_ABORTED]:
    "Settlement was aborted before the transaction was submitted to the network; no funds moved.",
  [LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE]:
    "The Soroban RPC endpoint could not be reached, so the payment could not be simulated or submitted. This is a facilitator-side outage, not a problem with your payment.",
  [LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR]:
    "The facilitator hit an unexpected internal error while processing this request. The payment was not settled.",

  // ── Protocol-level (@x402/core) ────────────────────────────────────────────
  invalid_x402_version:
    "The payment payload declares an x402 protocol version this facilitator does not implement. This facilitator speaks x402 v2.",
  unsupported_scheme:
    "The payment scheme in the requirements is not supported. This facilitator implements the 'exact' scheme only.",
  network_mismatch:
    "The network in the payment payload does not match the network in the payment requirements.",
  invalid_network:
    "The requested network is not a Stellar network this facilitator serves. Supported: 'stellar:testnet'.",
  verification_failed:
    "The payment failed verification and cannot be settled. Re-run /verify to see the specific check that failed.",
  unexpected_verify_error:
    "Verification failed for an unexpected reason inside the Stellar scheme implementation.",
  unexpected_settle_error:
    "Settlement failed for an unexpected reason inside the Stellar scheme implementation.",

  // ── Payload structure (@x402/stellar, exact) ───────────────────────────────
  invalid_exact_stellar_payload_malformed:
    "The 'transaction' field is not a decodable base64 Stellar transaction envelope for this network. Send the transaction exactly as the client produced it — do not re-encode it.",
  invalid_exact_stellar_payload_wrong_operation:
    "The transaction must contain exactly one InvokeHostFunction operation; it contained something else.",
  invalid_exact_stellar_payload_wrong_function_name:
    "The invoked contract function is not 'transfer'. The 'exact' scheme settles through a SEP-41 'transfer' call.",
  invalid_exact_stellar_payload_unsafe_tx_or_op_source:
    "The transaction or operation source account is not the payer. The facilitator will not sign a transaction whose source it does not expect.",
  invalid_exact_stellar_payload_has_subinvocations:
    "The authorization entry contains sub-invocations. The 'exact' scheme allows a single, unnested token transfer so that the authorization cannot be used to trigger anything else.",

  // ── Payment terms mismatch ─────────────────────────────────────────────────
  invalid_exact_stellar_payload_wrong_asset:
    "The token contract in the signed transaction is not the asset named in the payment requirements.",
  invalid_exact_stellar_payload_wrong_amount:
    "The amount in the signed transaction does not equal the amount in the payment requirements. The 'exact' scheme requires an exact match.",
  invalid_exact_stellar_payload_wrong_recipient:
    "The recipient in the signed transaction is not the 'payTo' address in the payment requirements.",

  // ── Authorization entries ──────────────────────────────────────────────────
  invalid_exact_stellar_payload_no_auth_entries:
    "The transaction carries no Soroban authorization entries, so nobody authorized the transfer.",
  invalid_exact_stellar_payload_missing_payer_signature:
    "The payer has not signed the authorization entry for this transfer.",
  invalid_exact_stellar_payload_unexpected_pending_signatures:
    "The transaction still needs signatures from accounts other than the payer. The facilitator settles single-signer payments only.",
  invalid_exact_stellar_payload_unsupported_credential_type:
    "The authorization entry uses a credential type the 'exact' scheme does not support.",
  invalid_exact_stellar_signature_expiration_too_far:
    "The authorization entry's signature expiration ledger is too far in the future. Re-sign with an expiration inside the allowed window.",

  // ── Facilitator-safety checks ──────────────────────────────────────────────
  invalid_exact_stellar_payload_facilitator_in_auth:
    "A facilitator-controlled account appears in the transaction's authorization entries. The facilitator refuses to authorize movements of its own funds on a payer's behalf.",
  invalid_exact_stellar_payload_facilitator_is_payer:
    "The payer is a facilitator-controlled account. The facilitator will not pay itself.",
  invalid_exact_stellar_payload_fee_exceeds_maximum:
    "The simulated network fee for this payment exceeds the facilitator's configured ceiling (MAX_TRANSACTION_FEE_STROOPS), so the facilitator declined to sponsor it.",

  // ── Simulation results ─────────────────────────────────────────────────────
  invalid_exact_stellar_payload_simulation_failed:
    "Simulating the transfer against Soroban RPC failed. The usual cause is an insufficient balance of the payment asset in the payer's account, or a missing trustline.",
  invalid_exact_stellar_payload_no_transfer_events:
    "Simulation produced no token transfer event, so the transaction would not actually move the payment.",
  invalid_exact_stellar_payload_multiple_transfers:
    "Simulation produced more than one token transfer event. The 'exact' scheme permits exactly one.",
  invalid_exact_stellar_payload_event_not_transfer:
    "The contract event emitted by the simulation is not a 'transfer' event.",
  invalid_exact_stellar_payload_event_missing_contract_id:
    "The simulated transfer event carries no contract id, so the asset being moved cannot be confirmed.",
  invalid_exact_stellar_payload_event_wrong_asset:
    "The simulated transfer moves a different token contract than the payment requirements specify.",
  invalid_exact_stellar_payload_event_wrong_amount:
    "The simulated transfer moves a different amount than the payment requirements specify.",
  invalid_exact_stellar_payload_event_wrong_from:
    "The simulated transfer debits an account other than the payer that signed the authorization.",
  invalid_exact_stellar_payload_event_wrong_to:
    "The simulated transfer credits an account other than the 'payTo' address in the payment requirements.",

  // ── Settlement (@x402/stellar, exact) ──────────────────────────────────────
  settle_exact_stellar_signer_selection_failed:
    "The facilitator could not select a signing account for this settlement.",
  settle_exact_stellar_transaction_signing_failed:
    "The facilitator failed to sign the settlement transaction.",
  settle_exact_stellar_fee_bump_signing_failed:
    "The facilitator failed to sign the fee-bump wrapper that sponsors this payment's network fee.",
  settle_exact_stellar_transaction_submission_failed:
    "The network rejected the settlement transaction at submission. A payment that was already settled will fail here on a second attempt — Soroban authorization entries are single-use, which is what makes replays impossible.",
  settle_exact_stellar_transaction_failed:
    "The settlement transaction was submitted but did not succeed on-chain. No payment was collected.",
};

/** Fallback when a package emits a code newer than this table. */
export const UNKNOWN_REASON_MESSAGE =
  "The payment was rejected by the Stellar 'exact' scheme implementation. See the reason code for the specific check that failed.";

/**
 * Looks up the human-readable message for a reason code.
 *
 * Never returns an empty string: unknown codes fall back to a generic sentence
 * that still names the code, so a rejection is always explicable.
 *
 * @param reason - Machine-readable reason code
 * @returns A non-empty, human-meaningful explanation
 */
export function describeReason(reason: string | undefined | null): string {
  if (!reason) return UNKNOWN_REASON_MESSAGE;
  const known = REASON_MESSAGES[reason];
  if (known) return known;
  return `${UNKNOWN_REASON_MESSAGE} (code: ${reason})`;
}

/**
 * Maps a thrown error into a reason code.
 *
 * `x402Facilitator.verify()` and `.settle()` throw — rather than returning a
 * rejection — when no scheme is registered for the requested scheme/network,
 * and RPC failures surface as raw errors. Both must still reach the caller as a
 * populated reason instead of a bare 500.
 *
 * @param error - The thrown value
 * @returns A reason code from `LOCAL_REASONS`
 */
export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (/No facilitator registered for (scheme|x402 version)/i.test(message)) {
    return LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK;
  }
  if (/Settlement aborted/i.test(message)) {
    return LOCAL_REASONS.SETTLEMENT_ABORTED;
  }
  if (/(fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|timeout)/i.test(message)) {
    return LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE;
  }
  return LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR;
}

/**
 * Detail line appended to a mapped error's message, so operators keep the
 * underlying text without the client having to parse it.
 *
 * @param error - The thrown value
 * @returns The error's message, or a placeholder when there is none
 */
export function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? "");
  return text.length > 0 ? text : "(no error message)";
}
