/**
 * Domain statuses and state machines (PRD §18, §19).
 *
 * These are the single source of truth for allowed values. SQLite has no
 * native enums, so Prisma stores plain strings; every write path validates
 * against the values here.
 */

// ---------------------------------------------------------------------------
// Roles — only HOST and ADMIN exist. Guests are unauthenticated (PRD §15).
// Do NOT add USER / CUSTOMER / GUEST.
// ---------------------------------------------------------------------------
export const Role = {
  HOST: "HOST",
  ADMIN: "ADMIN",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

// ---------------------------------------------------------------------------
// Booking states (PRD §18)
// ---------------------------------------------------------------------------
export const BookingStatus = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PAID: "PAID",
  CONFIRMED: "CONFIRMED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
  CANCELLED: "CANCELLED",
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

const BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PENDING_PAYMENT: [
    BookingStatus.PAID,
    BookingStatus.PAYMENT_FAILED,
    BookingStatus.EXPIRED,
    BookingStatus.CANCELLED,
  ],
  // PAID -> CONFIRMED happens in the same transaction as the payment webhook.
  PAID: [BookingStatus.CONFIRMED, BookingStatus.REFUNDED],
  PAYMENT_FAILED: [BookingStatus.PENDING_PAYMENT, BookingStatus.CANCELLED],
  CONFIRMED: [BookingStatus.REFUNDED],
  EXPIRED: [],
  REFUNDED: [],
  CANCELLED: [],
};

export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return false;
  return BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransitionBooking(from, to)) {
    throw new Error(`Illegal booking transition: ${from} -> ${to}`);
  }
}

// ---------------------------------------------------------------------------
// Payment states (PRD §19)
// ---------------------------------------------------------------------------
export const PaymentStatus = {
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: [
    PaymentStatus.PAID,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED,
  ],
  FAILED: [PaymentStatus.PENDING],
  PAID: [PaymentStatus.REFUNDED],
  EXPIRED: [PaymentStatus.PENDING],
  CANCELLED: [PaymentStatus.PENDING],
  REFUNDED: [],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return false;
  return PAYMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) {
    throw new Error(`Illegal payment transition: ${from} -> ${to}`);
  }
}

// ---------------------------------------------------------------------------
// Ledger entry types (PRD §21)
// ---------------------------------------------------------------------------
export const LedgerType = {
  FULL_PAYMENT: "FULL_PAYMENT",
  HOST_REVENUE: "HOST_REVENUE",
  PLATFORM_REVENUE: "PLATFORM_REVENUE",
  GATEWAY_FEE: "GATEWAY_FEE",
  REFUND: "REFUND",
} as const;
export type LedgerType = (typeof LedgerType)[keyof typeof LedgerType];

// ---------------------------------------------------------------------------
// Refund states
// ---------------------------------------------------------------------------
export const RefundStatus = {
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

// ---------------------------------------------------------------------------
// Route access classes (PRD §17)
// ---------------------------------------------------------------------------
export const Access = {
  PUBLIC: "PUBLIC",
  GUEST: "GUEST",
  HOST: "HOST",
  ADMIN: "ADMIN",
  WEBHOOK: "WEBHOOK",
} as const;
export type Access = (typeof Access)[keyof typeof Access];
