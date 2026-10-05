/**
 * Express application factory.
 *
 * Exported as a function so the test suite can build an app without binding a
 * port, and so middleware order is explicit and reviewable in one place.
 *
 * Security stack (PRD §24), in order:
 *   1. helmet              — security headers
 *   2. trust proxy         — correct client IPs behind a proxy
 *   3. CORS                — explicit allowlist
 *   4. request logging     — method/path/status only, no secrets
 *   5. webhook router      — BEFORE the JSON parser (raw body needed)
 *   6. body limit          — express.json with a hard size cap
 *   7. API router          — public / auth / host / admin
 *   8. 404 handler
 *   9. central error handler
 */

import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { config } from "../config";
import { apiRouter, webhookRouter } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { requestLogger } from "../lib/logger";

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy this makes req.ip the real client IP, which the
  // rate limiters key on. Enabled only in production to avoid a spoofable
  // X-Forwarded-For being trusted in local development.
  app.set("trust proxy", config.isProduction ? 1 : false);
  app.disable("x-powered-by");

  // 1. Security headers.
  app.use(
    helmet({
      // The mock checkout page is HTML; a strict CSP would need nonces.
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // 3. CORS — explicit allowlist, credentials off (auth is a bearer token).
  const origins = config.http.corsOrigins;
  app.use(
    cors({
      origin: origins.length > 0 ? origins : false,
      credentials: false,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

  // 4. Request logging (never logs query strings or headers).
  app.use(requestLogger());

  // 5. Webhook routes FIRST — raw body capture must see the untouched stream.
  app.use("/api", webhookRouter);

  // 6. JSON body with a hard size limit (PRD §24 "request body size limits").
  app.use(express.json({ limit: config.http.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.http.bodyLimit }));

  // 7. Everything else.
  app.use("/api", apiRouter);

  // Health probe — no auth, no rate limit, no DB access.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", env: config.nodeEnv, provider: config.payment.provider });
  });

  // 8. 404
  app.use(notFoundHandler);

  // 9. Central error handler (must be last, must take 4 args).
  app.use(errorHandler);

  return app;
}
