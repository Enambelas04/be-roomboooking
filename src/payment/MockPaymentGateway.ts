/**
 * MockPaymentGateway (PRD §7).
 *
 * Simulates a real external provider. It must NOT bypass the webhook
 * pipeline — choosing SUCCESS/FAILED/EXPIRED on the mock checkout page emits
 * a *signed* webhook back to:
 *
 *   ${APP_PUBLIC_URL}/api/payments/webhook?provider=mock
 *
 * Signature scheme (HMAC-SHA256 over the raw body, hex):
 *   header  x-mock-signature: sha256=<hex>
 *
 * This mirrors how real providers sign, so the verification path exercised
 * in tests is the same code path production will use.
 */

import crypto from "node:crypto";
import { config } from "../config";
import { webhookError } from "../domain/errors";
import type {
  CreateTransactionInput,
  CreateTransactionResult,
  NormalizedWebhookEvent,
  PaymentGateway,
  RefundInput,
  RefundResult,
  WebhookParseInput,
} from "./PaymentGateway";

const MOCK_SIGNATURE_HEADER = "x-mock-signature";

function sign(rawBody: string, secret: string): string {
  return (
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  );
}

/** Constant-time compare so signature checks cannot be timed. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class MockPaymentGateway implements PaymentGateway {
  readonly name = "mock";

  private readonly secret: string;
  private readonly publicUrl: string;

  constructor(secret = config.payment.webhookSecret, publicUrl = config.appPublicUrl) {
    this.secret = secret;
    this.publicUrl = publicUrl;
  }

  async createTransaction(
    input: CreateTransactionInput,
  ): Promise<CreateTransactionResult> {
    const providerRef = `mock_${input.paymentId}`;
    // The customer-facing mock checkout page. It renders SUCCESS / FAILED /
    // EXPIRED buttons and posts the signed webhook when one is chosen.
    const checkoutUrl = `${this.publicUrl}/mock-payment/${encodeURIComponent(providerRef)}`;
    return { providerRef, checkoutUrl, raw: { simulated: true } };
  }

  async parseWebhook(input: WebhookParseInput): Promise<NormalizedWebhookEvent> {
    const header = input.headers[MOCK_SIGNATURE_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided) {
      throw webhookError("Missing webhook signature");
    }

    const expected = sign(input.rawBody, this.secret);
    if (!safeEqual(provided, expected)) {
      // Never echo the expected signature — that would leak the secret.
      throw webhookError("Invalid webhook signature");
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      throw webhookError("Malformed webhook payload");
    }

    const eventId = payload.eventId;
    const providerRef = payload.providerRef;
    const status = payload.status;
    const amount = payload.amount;

    if (typeof eventId !== "string" || !eventId) {
      throw webhookError("Webhook payload missing eventId");
    }
    if (typeof providerRef !== "string" || !providerRef) {
      throw webhookError("Webhook payload missing providerRef");
    }
    if (status !== "PAID" && status !== "FAILED" && status !== "EXPIRED") {
      throw webhookError("Webhook payload has an unsupported status");
    }
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
      throw webhookError("Webhook payload has an invalid amount");
    }

    return {
      eventId,
      providerRef,
      paymentId: typeof payload.paymentId === "string" ? payload.paymentId : undefined,
      status,
      amount,
      raw: payload,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return {
      providerRefundId: `mockrefund_${input.providerRef}_${Date.now()}`,
      status: "SUCCEEDED",
      raw: { simulated: true },
    };
  }

  /**
   * Test/dev helper: build a correctly signed webhook request body.
   * Used by the mock checkout page and by the test suite.
   */
  buildSignedWebhook(body: {
    eventId: string;
    providerRef: string;
    paymentId?: string;
    status: "PAID" | "FAILED" | "EXPIRED";
    amount: number;
  }): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(body);
    return {
      rawBody,
      headers: { [MOCK_SIGNATURE_HEADER]: sign(rawBody, this.secret) },
    };
  }

  /** Exposed for the mock checkout page to sign arbitrary payloads. */
  static sign(rawBody: string, secret: string): string {
    return sign(rawBody, secret);
  }
}

export { MOCK_SIGNATURE_HEADER };
