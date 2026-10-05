/**
 * Gateway registry (PRD §3).
 *
 * Maps PAYMENT_PROVIDER to a concrete gateway. Midtrans and Xendit are
 * declared as future providers — they are intentionally NOT implemented here,
 * so selecting them fails loudly instead of silently falling back to mock.
 *
 * Audit fix F8: failures surface as AppError, not a bare Error. A bare Error
 * fell through the central handler as a generic 500, so a caller asking for an
 * unimplemented or unknown provider got "Internal server error" instead of an
 * actionable 4xx.
 */

import { config } from "../config";
import { badRequest, notFound } from "../domain/errors";
import { MockPaymentGateway } from "./MockPaymentGateway";
import type { PaymentGateway } from "./PaymentGateway";

export const SUPPORTED_PROVIDERS = ["mock", "midtrans", "xendit"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(p: string): p is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(p);
}

export function getGateway(provider: string = config.payment.provider): PaymentGateway {
  switch (provider) {
    case "mock":
      return new MockPaymentGateway();
    case "midtrans":
    case "xendit":
      // Known provider, adapter not written yet — a configuration gap, not a
      // client mistake.
      throw badRequest(
        `Payment provider "${provider}" is not implemented yet. Only "mock" is available.`,
      );
    default:
      // Unknown provider name supplied by the caller.
      throw notFound(`Unknown payment provider: ${provider}`);
  }
}
