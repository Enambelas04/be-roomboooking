/**
 * Vitest project for the rate-limit suite.
 *
 * The rate limiter MAX values are read from process.env when `src/config` is
 * first evaluated, and the limiters are constructed when the route modules are
 * first imported. There is therefore no way to change them from inside a test
 * body — the values are already baked in.
 *
 * Rather than mutate the shared environment (which leaked into other suites and
 * made unrelated tests fail), this suite gets its own vitest project with the
 * limits supplied as process environment. `tests/setup.ts` is still loaded
 * first and sets the shared defaults; the `env` block below then overrides just
 * the rate-limit values for this project, and the overrides cannot escape the
 * worker process.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "rate-limit",
    environment: "node",
    globals: true,
    include: ["tests/rate-limit.test.ts"],
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      // Its own database file: the two vitest projects must not share a SQLite
      // file, or one project's write lock can surface as an unrelated failure
      // in the other.
      DATABASE_URL: "file:./test-ratelimit.db",
      RATE_LIMIT_AUTH_MAX: "3",
      RATE_LIMIT_BOOKING_MAX: "3",
      RATE_LIMIT_PAYMENT_MAX: "3",
      RATE_LIMIT_WINDOW_MS: "60000",
    },
  },
});
