/**
 * Money helpers.
 *
 * All amounts are INTEGER minor units (PRD §20). Floating point is never used
 * for financial arithmetic; fee splits are computed with integer math and the
 * remainder is assigned deterministically so the ledger invariant holds
 * exactly:
 *
 *   HOST_REVENUE + PLATFORM_REVENUE + GATEWAY_FEE === FULL_PAYMENT
 */

import { config } from "../config";

export interface FeeSplit {
  fullPayment: number;
  platformRevenue: number;
  gatewayFee: number;
  hostRevenue: number;
}

export function assertMinorUnits(amount: number, label = "amount"): void {
  if (!Number.isInteger(amount)) {
    throw new Error(`${label} must be an integer number of minor units, got ${amount}`);
  }
  if (amount < 0) {
    throw new Error(`${label} must not be negative, got ${amount}`);
  }
}

/**
 * Split a payment into platform / gateway / host shares.
 *
 * Uses floor() for the platform and gateway cuts (never over-charging the
 * host), then assigns the rounding remainder to the host so the invariant is
 * exact to the rupiah.
 */
export function splitFees(
  amount: number,
  platformBps: number = config.fees.platformBps,
  gatewayBps: number = config.fees.gatewayBps,
): FeeSplit {
  assertMinorUnits(amount, "amount");
  assertMinorUnits(platformBps, "platformBps");
  assertMinorUnits(gatewayBps, "gatewayBps");

  const platformRevenue = Math.floor((amount * platformBps) / 10_000);
  const gatewayFee = Math.floor((amount * gatewayBps) / 10_000);
  const hostRevenue = amount - platformRevenue - gatewayFee;

  if (hostRevenue < 0) {
    throw new Error("Fee configuration exceeds the payment amount");
  }

  return { fullPayment: amount, platformRevenue, gatewayFee, hostRevenue };
}

/** True when the ledger split satisfies the PRD §21 invariant. */
export function ledgerInvariantHolds(split: FeeSplit): boolean {
  return (
    split.hostRevenue + split.platformRevenue + split.gatewayFee === split.fullPayment
  );
}

/** Format minor units as an IDR string, for logs and notifications only. */
export function formatIdr(amount: number): string {
  return "Rp" + amount.toLocaleString("id-ID");
}

/** Whole nights between two dates, using UTC day boundaries. */
export function nightsBetween(checkIn: Date, checkOut: Date): number {
  const a = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
  const b = Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}
