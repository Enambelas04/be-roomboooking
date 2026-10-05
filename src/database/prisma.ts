/**
 * Prisma client singleton.
 *
 * In development, tsx watch reloads modules; without a global cache that
 * leaks a new connection pool on every reload. Cache on globalThis.
 */

import { PrismaClient } from "@prisma/client";
import { config } from "../config";

const globalForPrisma = globalThis as unknown as {
  __prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log: config.isProduction ? ["error"] : ["error", "warn"],
  });

if (!config.isProduction) {
  globalForPrisma.__prisma = prisma;
}

export type { PrismaClient };
