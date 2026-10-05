/**
 * Central error handler (PRD §24 "consistent error responses").
 *
 * Every error leaves the API in exactly one shape:
 *
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 *
 * Non-AppError exceptions become a generic 500 — internal messages and stack
 * traces are never sent to the client, and sensitive values are never logged.
 */

import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../../domain/errors";
import { logger } from "../../lib/logger";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.path}`,
    },
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Validation failures raised outside the validate() middleware.
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.issues.map((i) => ({
          path: i.path.join(".") || "(root)",
          message: i.message,
        })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    // 5xx are logged with the real message; 4xx are expected client errors.
    if (err.statusCode >= 500) {
      logger.error("request failed", { code: err.code, message: err.message });
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.expose ? err.message : "Internal server error",
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Body-parser size limit surfaces as a 413-shaped error.
  if (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type?: string }).type === "entity.too.large"
  ) {
    res.status(413).json({
      error: { code: "VALIDATION_ERROR", message: "Request body too large" },
    });
    return;
  }

  // Malformed JSON from express.json().
  if (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type?: string }).type === "entity.parse.failed"
  ) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Malformed JSON body" },
    });
    return;
  }

  // Anything else: log the real error, return an opaque 500.
  logger.error("unhandled error", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
}
