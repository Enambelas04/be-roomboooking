/**
 * Structured logger with secret redaction (PRD §24 "no sensitive logging").
 *
 * Never logs: passwords, JWT secrets, API keys, webhook secrets,
 * authorization headers, tokens, card numbers, CVV.
 *
 * Any key matching REDACT_KEYS is replaced before output, so even if a caller
 * passes a whole request body through, secrets cannot reach the logs.
 */

type Level = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = [
  "password",
  "passwordhash",
  "password_hash",
  "newpassword",
  "currentpassword",
  "token",
  "accesstoken",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "secret",
  "jwt",
  "jwt_secret",
  "jwtsecret",
  "apikey",
  "api_key",
  "payment_api_key",
  "payment_secret_key",
  "payment_webhook_secret",
  "webhooksecret",
  "webhook_secret",
  "signature",
  "cardnumber",
  "card_number",
  "cvv",
  "cvc",
  "pin",
];

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return REDACT_KEYS.some((r) => k.includes(r.replace(/_/g, "")));
}

/** Deep-clone a value, replacing anything under a sensitive key. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
  };
  if (meta) line.meta = redact(meta);

  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};

/**
 * Request logging that records only method/path/status/duration.
 * Query strings are omitted because tracking tokens travel in the path or
 * query and must not be written to disk.
 */
export function requestLogger() {
  return (
    req: { method: string; path: string },
    res: { statusCode: number; on: (e: string, cb: () => void) => void },
    next: () => void,
  ): void => {
    const start = Date.now();
    res.on("finish", () => {
      logger.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  };
}
