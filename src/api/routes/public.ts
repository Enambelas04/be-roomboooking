/**
 * PUBLIC + GUEST routes (PRD §11, §17).
 *
 *   PUBLIC — no authentication
 *   GUEST  — no authentication, but bound to a booking / tracking token
 */

import { Router } from "express";
import { validate } from "../middleware/validate";
import { bookingRateLimiter, paymentRateLimiter } from "../middleware/rateLimit";
import { rawBodyCapture } from "../middleware/rawBody";
import {
  createBookingSchema,
  createPaymentSchema,
  idParamSchema,
  mockCheckoutQuerySchema,
  trackingTokenParamSchema,
  webhookQuerySchema,
} from "../schemas";
import {
  createBooking,
  getBookingByToken,
} from "../controllers/bookingController";
import {
  createPayment,
  handleWebhook,
  mockCheckout,
} from "../controllers/paymentController";
import { getPublicRoom, listPublicRooms } from "../controllers/roomController";

export const publicRouter = Router();

// PUBLIC — browse inventory without an account
publicRouter.get("/rooms", listPublicRooms);
publicRouter.get("/rooms/:id", validate(idParamSchema, "params"), getPublicRoom);

// GUEST — create a booking (rate limited against spam)
publicRouter.post(
  "/bookings",
  bookingRateLimiter(),
  validate(createBookingSchema),
  createBooking,
);

// GUEST — read a booking via its secure tracking token
publicRouter.get(
  "/bookings/:token",
  validate(trackingTokenParamSchema, "params"),
  getBookingByToken,
);

// GUEST — create a payment for a validated booking (rate limited)
publicRouter.post(
  "/payments/create",
  paymentRateLimiter(),
  validate(createPaymentSchema),
  createPayment,
);

// PUBLIC (development only) — the mock provider's hosted checkout page.
// Gated by the booking's tracking token and refused entirely in production
// (audit fix F2).
publicRouter.get(
  "/mock-payment/:transaction",
  validate(mockCheckoutQuerySchema, "query"),
  mockCheckout,
);

/**
 * WEBHOOK (PRD §6).
 * No rate limit — providers legitimately retry from changing IPs, and dropping
 * a retry would strand a payment. Idempotency is the correct protection.
 * The raw body is captured so the provider signature can be verified over the
 * exact bytes received.
 */
export const webhookRouter = Router();
webhookRouter.post(
  "/payments/webhook",
  validate(webhookQuerySchema, "query"),
  rawBodyCapture(),
  handleWebhook,
);
