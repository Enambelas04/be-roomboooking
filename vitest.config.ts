import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
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
