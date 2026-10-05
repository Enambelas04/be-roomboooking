/**
 * Configuration + startup validation (PRD §24 "secret validation").
 *
 * Loads .env, validates every variable the app depends on, and FAILS FAST on
 * misconfiguration rather than throwing confusing errors at request time.
 *
 * Rules enforced here:
 *  - JWT_SECRET must exist and be >= 32 chars, and must not be a known default
 *    when NODE_ENV=production.
 *  - PAYMENT_WEBHOOK_SECRET must exist for any non-mock provider.
 *  - PLATFORM_FEE_BPS must stay within the PRD's 8%-12% band.
 *  - PAYMENT_PROVIDER must be one of the supported values.
 */

import "dotenv/config";
import { z } from "zod";

const SUPPORTED_PROVIDERS = ["mock", "midtrans", "xendit"] as const;

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("1h"),

  PAYMENT_PROVIDER: z.enum(SUPPORTED_PROVIDERS).default("mock"),
  PAYMENT_API_KEY: z.string().optional().default(""),
  PAYMENT_SECRET_KEY: z.string().optional().default(""),
  PAYMENT_WEBHOOK_SECRET: z.string().optional().default(""),

  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(1000),
  GATEWAY_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(0),

  CORS_ORIGINS: z.string().default(""),
  BODY_LIMIT: z.string().default("100kb"),

  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_BOOKING_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_PAYMENT_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_HOST_EMAIL: z.string().email().optional(),
  SEED_HOST_PASSWORD: z.string().optional(),
});

function fail(errors: string[]): never {
  const msg = [
    "",
    "======================================================================",
    " CONFIGURATION ERROR — the server refused to start.",
    " Fix the following in your .env (see .env.example):",
    "======================================================================",
    ...errors.map((e) => `  • ${e}`),
    "",
  ].join("\n");
  // Config errors may name variables but must never print their VALUES.
  console.error(msg);
  process.exit(1);
}

const parsed = rawSchema.safeParse(process.env);

if (!parsed.success) {
  fail(
    parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  );
}

const env = parsed.data;

// --- Cross-field validation -------------------------------------------------
const problems: string[] = [];

const DEFAULT_SECRETS = [
  "dev-only-secret-do-not-use-in-production-0000000000",
  "secret",
  "changeme",
];

if (env.NODE_ENV === "production") {
  if (DEFAULT_SECRETS.includes(env.JWT_SECRET)) {
    problems.push("JWT_SECRET is still a development default (NODE_ENV=production).");
  }
  if (env.PAYMENT_PROVIDER !== "mock" && !env.PAYMENT_WEBHOOK_SECRET) {
    problems.push(
      `PAYMENT_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER}.`,
    );
  }
  if (env.APP_PUBLIC_URL.startsWith("http://localhost")) {
    problems.push("APP_PUBLIC_URL still points at localhost in production.");
  }
}

if (env.PLATFORM_FEE_BPS < 800 || env.PLATFORM_FEE_BPS > 1200) {
  problems.push(
    `PLATFORM_FEE_BPS must be between 800 and 1200 (8%-12%), got ${env.PLATFORM_FEE_BPS}.`,
  );
}

if (env.PAYMENT_PROVIDER === "mock" && !env.PAYMENT_WEBHOOK_SECRET) {
  problems.push(
    "PAYMENT_WEBHOOK_SECRET is required even for the mock provider — " +
      "the mock gateway signs its webhooks and forged signatures must be rejected.",
  );
}

if (problems.length > 0) fail(problems);

// --- Derived config ---------------------------------------------------------
export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  port: env.PORT,
  appPublicUrl: env.APP_PUBLIC_URL.replace(/\/$/, ""),

  databaseUrl: env.DATABASE_URL,

  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },

  payment: {
    provider: env.PAYMENT_PROVIDER,
    apiKey: env.PAYMENT_API_KEY,
    secretKey: env.PAYMENT_SECRET_KEY,
    webhookSecret: env.PAYMENT_WEBHOOK_SECRET,
    webhookUrl: `${env.APP_PUBLIC_URL.replace(/\/$/, "")}/api/payments/webhook`,
  },

  fees: {
    /** Platform commission in basis points (800-1200). */
    platformBps: env.PLATFORM_FEE_BPS,
    gatewayBps: env.GATEWAY_FEE_BPS,
  },

  http: {
    bodyLimit: env.BODY_LIMIT,
    corsOrigins: env.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    authMax: env.RATE_LIMIT_AUTH_MAX,
    bookingMax: env.RATE_LIMIT_BOOKING_MAX,
    paymentMax: env.RATE_LIMIT_PAYMENT_MAX,
  },

  seed: {
    adminEmail: env.SEED_ADMIN_EMAIL,
    adminPassword: env.SEED_ADMIN_PASSWORD,
    hostEmail: env.SEED_HOST_EMAIL,
    hostPassword: env.SEED_HOST_PASSWORD,
  },
} as const;

export type Config = typeof config;
