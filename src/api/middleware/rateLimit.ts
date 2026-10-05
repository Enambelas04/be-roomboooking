/**
 * Rate limiters (PRD §24, §25).
 *
 * Three distinct buckets because the abuse profiles differ:
 *   - auth    : credential stuffing / brute force
 *   - booking : unauthenticated guest spam
 *   - payment : payment-creation throttling
 *
 * Keyed by client IP. The tracking token never appears in the key so a limiter
 * cannot be used to probe for valid tokens.
 */

import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { config } from "../../config";

function build(max: number, message: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Consistent error shape with the rest of the API.
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: "RATE_LIMITED", message },
      });
    },
  });
}

export const authRateLimiter = () =>
  build(
    config.rateLimit.authMax,
    "Too many authentication attempts. Please try again later.",
  );

export const bookingRateLimiter = () =>
  build(config.rateLimit.bookingMax, "Too many booking requests. Please try again later.");

export const paymentRateLimiter = () =>
  build(
    config.rateLimit.paymentMax,
    "Too many payment requests. Please try again later.",
  );

/**
 * Webhooks are NOT rate limited by IP: providers retry from changing
 * infrastructure, and dropping a legitimate retry would leave a payment
 * stuck. Idempotency (WebhookEvent unique constraint) is the correct
 * protection there instead.
 */
