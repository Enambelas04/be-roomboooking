/**
 * Input validation (PRD §24, §25).
 *
 * A single `validate()` middleware parses and REPLACES req.body / req.query /
 * req.params with the parsed result, so downstream handlers work with typed,
 * sanitized data. Unknown keys are stripped by zod's default object behavior,
 * which prevents mass-assignment style bugs.
 */

import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodSchema } from "zod";
import { badRequest } from "../../domain/errors";

type Source = "body" | "query" | "params";

function formatIssues(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}

export function validate(schema: ZodSchema, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(badRequest("Request validation failed", formatIssues(result.error)));
      return;
    }
    // Express 4: req.query is a getter in some versions; assign defensively.
    if (source === "query") {
      Object.defineProperty(req, "query", {
        value: result.data,
        writable: true,
        configurable: true,
      });
    } else {
      req[source] = result.data as never;
    }
    next();
  };
}

/**
 * Webhook bodies must be verified against the EXACT raw bytes the provider
 * signed, so the JSON body parser is replaced by a raw-body capture for that
 * route (see src/api/middleware/rawBody.ts).
 */
