/**
 * Server entry point.
 *
 * Imports config first so startup validation runs before anything else — a
 * misconfigured deployment fails immediately with a readable message instead
 * of throwing on the first request.
 */

import { config } from "./config";
import { createApp } from "./api/app";
import { logger } from "./lib/logger";
import { prisma } from "./database/prisma";

async function main(): Promise<void> {
  const app = createApp();

  const server = app.listen(config.port, () => {
    logger.info("server listening", {
      port: config.port,
      env: config.nodeEnv,
      provider: config.payment.provider,
      publicUrl: config.appPublicUrl,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    // Force-exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("fatal startup error", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
