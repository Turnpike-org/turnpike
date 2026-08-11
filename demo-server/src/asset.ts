import { Asset, Networks } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";

const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;

/**
 * Resolves the configured payment asset to a SEP-41 token contract address.
 *
 * `native` resolves to the Stellar Asset Contract for XLM, which is the default
 * because Friendbot funds it — the demo then reproduces end to end with no
 * manual faucet step. `usdc` and any explicit `C...` address work identically;
 * the `exact` scheme does not care which SEP-41 token it moves.
 *
 * @param value - Value of `PAYMENT_ASSET`: `native`, `usdc`, or a contract address
 * @returns The token contract address to put in the payment requirements
 * @throws {Error} When the value is neither a known alias nor a contract address
 */
export function resolveAsset(value: string): string {
  const asset = value.trim();

  if (asset.toLowerCase() === "native" || asset.toLowerCase() === "xlm") {
    return Asset.native().contractId(Networks.TESTNET);
  }
  if (asset.toLowerCase() === "usdc") {
    return USDC_TESTNET_ADDRESS;
  }
  if (CONTRACT_ADDRESS.test(asset)) {
    return asset;
  }
  throw new Error(
    `PAYMENT_ASSET must be 'native', 'usdc', or a Stellar contract address (C...); got '${value}'`,
  );
}

/**
 * Formats an atomic amount for display. Stellar assets carry 7 decimals.
 *
 * @param atomicAmount - Amount in the asset's smallest unit
 * @returns The decimal representation
 */
export function toDecimal(atomicAmount: string): string {
  const padded = atomicAmount.padStart(8, "0");
  const whole = padded.slice(0, -7);
  const fraction = padded.slice(-7).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
