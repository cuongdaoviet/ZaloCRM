/**
 * Tiny tracker for fire-and-forget background work (activity log writes,
 * webhook deliveries) so test teardown can drain in-flight tasks before
 * destructive operations like TRUNCATE.
 *
 * Why this exists: fire-and-forget DB writes started during one test would
 * still be running when the next test's beforeEach truncated tables — the
 * resulting overlap between INSERT (holding RowShareLock on referenced
 * tables) and TRUNCATE (wanting AccessExclusiveLock on those same tables)
 * is a classic Postgres deadlock.
 */
const pending = new Set<Promise<unknown>>();

/**
 * Wrap a fire-and-forget promise so the runtime tracks it. Errors are still
 * swallowed by the caller's try/catch — this only tracks completion, not
 * outcome.
 */
export function trackBackground(p: Promise<unknown>): void {
  pending.add(p);
  // Remove from the set whether it resolves or rejects. Errors don't bubble.
  p.finally(() => pending.delete(p)).catch(() => {});
}

/**
 * Resolve when every currently-tracked task has settled. Used by test
 * `resetDb()` to drain in-flight work before truncating tables. Idempotent
 * — calling it from production code is harmless (resolves immediately when
 * nothing is queued).
 */
export async function flushBackgroundTasks(): Promise<void> {
  while (pending.size > 0) {
    // Snapshot — new tasks added after this line are waited for on the next loop
    const snapshot = Array.from(pending);
    await Promise.allSettled(snapshot);
  }
}
