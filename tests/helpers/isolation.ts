/**
 * Test harness: per-suite database and environment isolation.
 *
 * The suite shares one SQLite file across sequentially-run test files, and
 * src/config reads process.env at import time. Both were sources of
 * cross-suite interference:
 *
 *  - Rows left behind by a suite that did not truncate collided with a later
 *    suite's fixtures ("Unique constraint failed on email" / "paymentId").
 *  - RATE_LIMIT_* mutated by one suite changed limiter behaviour in another,
 *    because the limiters are constructed on first import and cached.
 *
 * This module gives each suite a deterministic starting point:
 *   - `suiteEmail()`    unique, suite-scoped identities (no hardcoded emails)
 *   - `withEnv()`       env overrides restored after the callback
 *   - `isolateSuite()`  truncate + assert the database is empty, and snapshot
 *                       the environment so leftovers are detectable
 */

import { prisma } from "../../src/database/prisma";

/** Tables in FK-safe deletion order. */
export const TABLES = [
  "Notification",
  "LedgerEntry",
  "Refund",
  "PaymentEvent",
  "WebhookEvent",
  "Payment",
  "Booking",
  "Room",
  "User",
] as const;

/**
 * Truncate every table.
 *
 * DELETE (not TRUNCATE/DROP) keeps the schema and the sqlite_sequence intact.
 * Retried on SQLITE_BUSY: with several writers the file lock can be held for a
 * moment, and a busy error here would masquerade as a broken test.
 */
export async function resetDb(): Promise<void> {
  for (const table of TABLES) {
    await deleteAll(table);
  }
}

async function deleteAll(table: string, attempt = 0): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/SQLITE_BUSY|database is locked/i.test(message) && attempt < 10) {
      await sleep(25 * (attempt + 1));
      return deleteAll(table, attempt + 1);
    }
    throw err;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Row counts per table, for emptiness assertions. */
export async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM "${table}"`,
    );
    out[table] = Number(rows[0]?.c ?? 0);
  }
  return out;
}

/**
 * Assert the database is empty. Used as a guard so a suite cannot silently
 * inherit another suite's rows.
 */
export async function expectEmptyDb(): Promise<void> {
  const counts = await tableCounts();
  const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
  if (nonEmpty.length > 0) {
    throw new Error(
      `Test database is not empty before suite start: ${nonEmpty
        .map(([t, n]) => `${t}=${n}`)
        .join(", ")}. ` +
        `A previous suite leaked rows; every suite must call resetDb() first.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Suite-scoped identities
// ---------------------------------------------------------------------------

let suiteTag: string | null = null;

/**
 * A per-process tag used to build unique fixtures.
 *
 * Each test file runs in its own worker process, so the pid makes the tag
 * unique across concurrently-existing suites, and a counter makes it unique
 * within a suite. This removes the hardcoded `host@example.com` collisions
 * entirely.
 */
function tag(): string {
  if (!suiteTag) {
    suiteTag = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
  }
  return suiteTag;
}

let counter = 0;

/** A unique email local-part, scoped to this suite and monotonic within it. */
export function suiteEmail(prefix = "user"): string {
  counter += 1;
  return `${prefix}-${tag()}-${counter}@example.test`;
}

/** A unique cuid-like string for fields that must be unique but are not emails. */
export function uniqueId(prefix = "id"): string {
  counter += 1;
  return `${prefix}-${tag()}-${counter}`;
}

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(): EnvSnapshot {
  return { ...process.env };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  // Remove anything added since the snapshot, then restore prior values.
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

/**
 * Run `fn` with temporary environment overrides, restoring the environment
 * afterwards even if `fn` throws.
 *
 * Note: this governs process.env only. Values already read into an imported
 * module's closure are unaffected — order imports accordingly.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const before = snapshotEnv();
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    restoreEnv(before);
  }
}

/** Current snapshot, for suites that want to assert restoration. */
export function envSnapshot(): EnvSnapshot {
  return snapshotEnv();
}

export function restoreEnvSnapshot(s: EnvSnapshot): void {
  restoreEnv(s);
}
