/**
 * Vitest setup — runs before each test file's modules are imported.
 *
 * Config values are set here (not only in vitest.config.ts) because
 * src/config/index.ts validates process.env at import time and calls
 * process.exit(1) on a bad value. Anything a test module imports transitively
 * would otherwise see an unconfigured environment.
 *
 * The suite uses its own SQLite file so the development database is never
 * touched. It is covered by the "*.db" rule in .gitignore.
 */

import { execSync } from "node:child_process";

process.env.NODE_ENV = "test";

// Dedicated test database. Relative paths in DATABASE_URL resolve against the
// prisma/ directory, so this is prisma/test.db.
process.env.DATABASE_URL = "file:./test.db";

// Valid configuration that satisfies the startup validator.
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-1234";
process.env.JWT_EXPIRES_IN = "1h";
process.env.APP_PUBLIC_URL = "http://localhost:3000";
process.env.PAYMENT_PROVIDER = "mock";
process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
process.env.PLATFORM_FEE_BPS = "1000";
process.env.GATEWAY_FEE_BPS = "0";
process.env.CORS_ORIGINS = "http://localhost:5173";
process.env.BODY_LIMIT = "100kb";

// Rate limiters are constructed once per module load, so their counters are
// shared across every test in a file. Keep them high here; rate limiting is
// exercised separately in tests/rate-limit.test.ts.
process.env.RATE_LIMIT_AUTH_MAX = "10000";
process.env.RATE_LIMIT_BOOKING_MAX = "10000";
process.env.RATE_LIMIT_PAYMENT_MAX = "10000";
process.env.RATE_LIMIT_WINDOW_MS = "60000";

// Bring the test schema up to date. `migrate deploy` is idempotent, so running
// it once per test file is safe and cheap.
execSync("npx prisma migrate deploy", {
  stdio: "pipe",
  env: process.env,
  cwd: process.cwd(),
});
