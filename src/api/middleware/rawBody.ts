/**
 * Raw body capture for webhook routes (PRD §6).
 *
 * Provider signatures are computed over the EXACT bytes of the request body.
 * Re-serializing parsed JSON would change key order/whitespace and break
 * verification, so webhook routes use this instead of express.json().
 */

import type { NextFunction, Request, Response } from "express";
import { config } from "../../config";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

/**
 * Captures the raw body as a UTF-8 string and also exposes the parsed JSON on
 * req.body for handlers that need it. Enforces the same size limit as the
 * JSON parser so a huge webhook body cannot exhaust memory.
 */
export function rawBodyCapture() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const limit = parseSize(config.http.bodyLimit);
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > limit) {
        aborted = true;
        const err = Object.assign(new Error("Request body too large"), {
          type: "entity.too.large",
        });
        next(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      req.rawBody = raw;
      if (raw.length > 0) {
        try {
          req.body = JSON.parse(raw);
        } catch {
          const err = Object.assign(new Error("Malformed JSON body"), {
            type: "entity.parse.failed",
          });
          next(err);
          return;
        }
      }
      next();
    });

    req.on("error", (err) => {
      if (!aborted) next(err);
    });
  };
}

/** Parse an Express-style size string ("100kb", "1mb", "512") into bytes. */
export function parseSize(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(input.trim());
  if (!m) return 100 * 1024;
  const n = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.floor(n * mult);
}
