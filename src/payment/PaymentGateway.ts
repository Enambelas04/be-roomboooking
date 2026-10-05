/**
 * PaymentGateway interface (PRD §2, §3).
 *
 * The core booking system must stay payment-provider agnostic. Everything
 * provider-specific lives behind this interface so Midtrans/Xendit can be
 * added later without touching PaymentService.
 */

export interface CreateTransactionInput {
  /** Our payment id — used as the gateway-side order/transaction reference. */
  paymentId: string;
  bookingId: string;
  /** Amount in minor units (IDR rupiah). */
  amount: number;
  customerName: string;
  customerEmail: string;
  description: string;
  /** Where the provider should send the user to pay. */
  returnUrl?: string;
}

export interface CreateTransactionResult {
  /** Provider-side transaction id. */
  providerRef: string;
  /** URL the customer is sent to in order to complete payment. */
  checkoutUrl: string;
  /** Raw provider response, stored for audit. */
  raw?: unknown;
}

export interface WebhookParseInput {
  /** Raw request body bytes as a string — signature must be computed over this. */
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  /** Query string parameters (mock provider passes ?provider=mock). */
  query: Record<string, unknown>;
}

export interface NormalizedWebhookEvent {
  /** Provider-side unique event id — the dedupe key. */
  eventId: string;
  /** Provider transaction reference. */
  providerRef: string;
  /** Our payment id, when the provider echoes it back. */
  paymentId?: string;
  /** Normalized outcome. */
  status: "PAID" | "FAILED" | "EXPIRED";
  /** Amount reported by the provider, in minor units. */
  amount: number;
  raw: unknown;
}

export interface RefundInput {
  providerRef: string;
  /** Amount to refund, minor units. */
  amount: number;
  reason?: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: "SUCCEEDED" | "FAILED" | "PENDING";
  raw?: unknown;
}

export interface PaymentGateway {
  readonly name: string;

  createTransaction(input: CreateTransactionInput): Promise<CreateTransactionResult>;

  /**
   * Verify the provider signature and normalize the payload.
   * MUST throw when the signature is invalid (PRD §6) — a forged webhook
   * must never reach the state-change logic.
   */
  parseWebhook(input: WebhookParseInput): Promise<NormalizedWebhookEvent>;

  refund(input: RefundInput): Promise<RefundResult>;
}
