import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // The rate-limit suite runs as a separate vitest project
    // (vitest.rate-limit.config.ts) because its limits must be in the
    // environment before src/config is imported. It is excluded here so it is
    // not also collected with the shared limits.
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/rate-limit.test.ts"],
    // Sets the test environment before any test module (and therefore before
    // src/config, which validates at import time) is evaluated.
    setupFiles: ["tests/setup.ts"],
    // Payment/booking flows touch a real SQLite file; keep suites sequential so
    // one suite's DB reset cannot race another's.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
