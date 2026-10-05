import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Payment/booking flows touch a real SQLite file; keep suites sequential so
    // one suite's DB reset cannot race another's.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
