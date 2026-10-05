/**
 * Application error types.
 *
 * Every thrown AppError is rendered by the central error handler into a
 * consistent response shape (PRD §24 "consistent error responses"):
 *
 *   { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": ... } }
 *
 * Unknown errors become a generic 500 and are NEVER echoed to the client,
 * so internal details cannot leak.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYMENT_ERROR"
  | "BOOKING_ERROR"
  | "WEBHOOK_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** Marks errors that are safe to show verbatim to clients. */
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; expose?: boolean } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? true;
    // V8-only; guarded so the class works on any runtime/lib target.
    (
      Error as unknown as { captureStackTrace?: (t: object, c: unknown) => void }
    ).captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "VALIDATION_ERROR", message, { details });

export const unauthorized = (message = "Authentication required") =>
  new AppError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "Insufficient permissions") =>
  new AppError(403, "FORBIDDEN", message);

export const notFound = (message = "Resource not found") =>
  new AppError(404, "NOT_FOUND", message);

export const conflict = (message: string) => new AppError(409, "CONFLICT", message);

export const paymentError = (message: string, details?: unknown) =>
  new AppError(422, "PAYMENT_ERROR", message, { details });

export const bookingError = (message: string) =>
  new AppError(422, "BOOKING_ERROR", message);

export const webhookError = (message: string) =>
  new AppError(400, "WEBHOOK_ERROR", message);

export const internal = (message = "Internal server error") =>
  new AppError(500, "INTERNAL_ERROR", message, { expose: false });
