/**
 * Per-room serialization (audit fix F5).
 *
 * The overlap check is read-then-write: two concurrent bookings for the same
 * room can both observe "no overlap" and both insert, producing an
 * overbooking. This lock serializes booking creation per room within the
 * process, so the check and the insert cannot interleave.
 *
 * Scope: correct for the current single-process deployment. A multi-instance
 * deployment must additionally rely on a database-level guard
 * (SELECT ... FOR UPDATE on the room row, or an exclusion constraint in
 * PostgreSQL). The DB-level overlap re-check inside the transaction remains as
 * the second line of defence.
 */

const chains = new Map<string, Promise<unknown>>();

export function withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(roomId) ?? Promise.resolve();
  // Run after the previous holder settles, whether it resolved or rejected.
  const run = previous.then(fn, fn);
  // Keep the chain alive but never let a rejection poison the next waiter.
  chains.set(
    roomId,
    run.catch(() => undefined),
  );
  return run;
}

/** Test helper: number of rooms with an in-flight lock chain. */
export function activeRoomLocks(): number {
  return chains.size;
}
