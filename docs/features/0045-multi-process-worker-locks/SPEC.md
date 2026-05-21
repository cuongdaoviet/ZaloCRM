# Feature 0045: Multi-process worker locks (Postgres SKIP LOCKED)

## 1. Mô tả

Two shipped features run background workers with a JavaScript module-
level singleton flag (`let tickRunning = false`) as the safety
mechanism against overlap:

- **0037** — `backend/src/workers/workflow-runner.ts` (60s ticks)
- **0038** — `backend/src/workers/integration-runner.ts` (5min ticks)

This works fine for a single backend process. But the flag lives in
ONE Node.js process's memory; other processes have their own copy
initialized to `false`. When ZaloCRM scales to 2+ backend processes
behind a load balancer, both processes' crons fire on the same minute,
both query for due rows, both find the same rows, both run the same
steps. Result: **duplicate Telegram messages, duplicate Zalo sends,
duplicate workflow side-effects.**

Both SPECs explicitly flagged this as a phase-2 gap.

Phase 1 (this feature) ships the fix: replace the singleton-flag
guard with Postgres `SELECT FOR UPDATE SKIP LOCKED`. Each row gets
processed by exactly one process, regardless of how many processes
are running.

## 2. User Stories

- **US-0045-1:** As an Ops engineer, I scale ZaloCRM to 2+ backend
  processes behind a load balancer without changing application code.
  Workflows and integrations behave identically to single-process —
  no duplicate Zalo messages, no duplicate Telegram notifications, no
  duplicate workflow side-effects.
- **US-0045-2:** As a Developer reading the worker code, the locking
  semantics are obvious from the `$queryRaw` `FOR UPDATE SKIP LOCKED`
  clause — no implicit reliance on JavaScript module scope.
- **US-0045-3:** As an Ops engineer running a slow worker tick (e.g.
  a Google Sheets sync that takes 2 minutes), the next cron fire in
  the same process doesn't run a parallel tick — the within-process
  singleton flag still applies as belt-and-suspenders.

## 3. Business Rules

### Lock pattern (both runners)

- **BR-0001:** Worker fetches due rows inside a Prisma `$transaction`
  using `$queryRaw` with `FOR UPDATE SKIP LOCKED LIMIT N`. The
  transaction wraps the fetch + per-row processing. Lock releases on
  commit.
- **BR-0002:** Each runner uses **inline** `$queryRaw` — no shared
  helper abstraction. Pattern is short enough (~30 LOC each) that
  DRY-ing it adds more complexity than it removes. If a third worker
  arrives in phase 2, revisit.
- **BR-0003:** `tickRunning` module-level flag **stays** as a within-
  process belt-and-suspenders. Reasons:
  - Prevents one slow tick in process A from overlapping with the
    next cron fire in process A on the same connection pool.
  - Costs ~1 LOC per runner.
  - Doesn't conflict with SKIP LOCKED (which handles cross-process).
- **BR-0004:** Batch size unchanged from current values:
  - workflow-runner: 50 rows per tick (existing).
  - integration-runner: 25 rows per tick (existing).

### Per-row processing

- **BR-0005:** Inside the transaction, each row is processed one at
  a time (not parallel). If processing one row throws, the transaction
  is **NOT** rolled back wholesale — instead, processing errors are
  caught + logged per row, then the next row in the batch continues.
  The transaction commits at the end (releasing all locks). Lock is
  held for the duration of the whole batch.
- **BR-0006:** Tradeoff acknowledged: holding the lock for the whole
  batch means if process A crashes mid-batch, rows in that batch stay
  locked until the connection's transaction times out (Postgres
  default 0 = forever, but our connection pool's idle timeout will
  release within ~30s typically). Mitigation: keep batches small
  (BR-0004 limits already do this). If this becomes a real issue,
  phase 2 can split each row into its own transaction.

### Migration path

- **BR-0007:** Workflow runner refactor is **behavior-preserving**:
  same rows are picked up, same step executors run. Only the lock
  mechanism changes. Existing tests must continue to pass without
  modification.
- **BR-0008:** Integration runner: same as BR-0007.
- **BR-0009:** Each refactored worker logs on startup what locking
  it's using:
  - `[workflow-runner] started, lock=postgres-skip-locked, batch=50`
  - `[integration-runner] started, lock=postgres-skip-locked, batch=25`

### Test strategy (phase 1 scope per product call)

- **BR-0010:** Single-process correctness tests must continue to
  pass — existing integration tests for 0037 and 0038 cover the happy
  path.
- **BR-0011:** Add ONE new integration test per worker that asserts
  the `FOR UPDATE SKIP LOCKED` mechanic works using a **simulated
  concurrent claim**: open a second Prisma transaction that holds
  a row's lock, run the worker's query, assert the locked row is
  skipped, then release.
- **BR-0012:** Full multi-process concurrency tests (spawning 2 Node
  processes against same DB and asserting no double-processing) are
  **out of scope for phase 1**. Defer to a load-test pass before
  horizontal scaling rollout.

### Out of scope

- **BR-0013:** No new worker types added. No other workers refactored
  (campaign-worker, friendship-worker, appointment-reminder all
  continue using existing patterns).
- **BR-0014:** No metrics/observability for lock contention. Phase 2
  if it becomes operationally relevant.
- **BR-0015:** No "advisory lock" alternative (Postgres
  `pg_advisory_xact_lock`). SKIP LOCKED on the data table itself is
  the cleaner pattern for this use case.

## 4. Input / Output

### Schema

NO schema changes.

### Code changes

#### Worker pattern (workflow-runner.ts)

Current shape (paraphrased):

```typescript
async function runDueExecutions() {
  const due = await prisma.workflowExecution.findMany({
    where: { status: 'running', nextStepDueAt: { lte: new Date() } },
    take: 50,
    orderBy: { nextStepDueAt: 'asc' },
  });
  for (const exec of due) {
    try {
      await processStep(exec);
    } catch (err) {
      logger.error('[workflow-runner] step error:', err);
    }
  }
}
```

New shape:

```typescript
async function runDueExecutions() {
  await prisma.$transaction(async (tx) => {
    // Postgres row-level lock: claim up to 50 due rows, skipping any
    // already claimed by another process or tick. Lock releases when
    // this transaction commits.
    const due = await tx.$queryRaw<WorkflowExecutionRow[]>`
      SELECT id, org_id, workflow_id, contact_id, conversation_id,
             status, current_step_idx, next_step_due_at, step_log,
             started_at, completed_at
      FROM workflow_executions
      WHERE status = 'running'
        AND next_step_due_at <= NOW()
      ORDER BY next_step_due_at ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    `;
    for (const exec of due) {
      try {
        await processStep(exec, tx);  // pass tx so writes are part of the same transaction
      } catch (err) {
        logger.error('[workflow-runner] step error:', err);
        // Continue to next row; don't roll back the whole batch.
      }
    }
  });
}
```

#### Worker pattern (integration-runner.ts)

Mirror the same refactor. Table = `integrations`, batch = 25, status
filter = `enabled = true AND (last_synced_at IS NULL OR last_synced_at <= now() - interval matching schedule)`.

#### Type definitions

`$queryRaw` returns plain objects, not Prisma model instances. Add
explicit row types per table:

```typescript
interface WorkflowExecutionRow {
  id: string;
  org_id: string;
  workflow_id: string;
  contact_id: string;
  conversation_id: string | null;
  status: string;
  current_step_idx: number;
  next_step_due_at: Date | null;
  step_log: unknown;  // jsonb
  started_at: Date;
  completed_at: Date | null;
}
```

snake_case ↔ camelCase mapping happens at the boundary. Either:
- (a) Use snake_case throughout the worker body, OR
- (b) Map to camelCase immediately after the query.

Pick (b) — keeps the rest of the function looking like normal Prisma
results. Map function ~10 LOC.

#### Singleton flag — keep

```typescript
let tickRunning = false;

cron.schedule('* * * * *', () => {
  if (tickRunning) {
    logger.warn('[workflow-runner] previous tick still running, skipping');
    return;
  }
  tickRunning = true;
  runDueExecutions()
    .catch((err) => logger.error('[workflow-runner] tick error:', err))
    .finally(() => { tickRunning = false; });
});
```

This guards within-process overlap. SKIP LOCKED handles cross-process.
Belt + suspenders.

### Logging changes

- Startup log line per BR-0009.
- Per-tick log: `[workflow-runner] tick: claimed N rows`. Useful for
  ops to see if rows are being claimed by another process (count drops
  unexpectedly = another process is taking them).

## 5. Edge Cases

- **EC-0001:** No due rows → query returns empty array → transaction
  commits no-op → next tick fires normally.
- **EC-0002:** Process A's tick claims rows 1-50, holds lock for 30s
  (slow batch). Process B's tick fires during that window → SKIP
  LOCKED returns 0 rows for B → B logs "claimed 0 rows" and exits.
  When A commits, B's next tick picks up unprocessed rows. **Correct.**
- **EC-0003:** Process A crashes mid-batch (OOM, signal kill) → DB
  connection drops → Postgres releases lock automatically. Rows stay
  in their pre-A state (since A's transaction never committed). Next
  tick (any process) re-claims them. **Correct, no manual cleanup
  needed.**
- **EC-0004:** Process A's batch processes 30 rows, then one step
  executor throws. Per BR-0005 we log + continue. The transaction
  still commits at the end. **All 50 rows' updated state is committed
  together.** This is the same behavior as today's findMany-then-loop
  pattern; we're not introducing new semantics.
- **EC-0005:** Two cron ticks fire simultaneously in process A (clock
  jitter, drift). First call sets `tickRunning=true`, second call
  sees `true` and returns immediately. BR-0003 prevents within-process
  overlap.
- **EC-0006:** Postgres advisory lock on entire `workflow_executions`
  table is NOT used. We rely on row-level locks via FOR UPDATE. This
  scales correctly because different processes can claim different
  rows in parallel.
- **EC-0007:** A row is locked by process A. An app endpoint (e.g.
  admin UI fetching execution status) tries to read it. Read queries
  are NOT blocked by SELECT FOR UPDATE locks in default isolation
  (READ COMMITTED). Admin sees the stale state until A commits.
  Acceptable for our use case.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `workflow-runner.ts` uses `$transaction` +
      `$queryRaw` with `FOR UPDATE SKIP LOCKED`. `tickRunning` flag
      kept.
- [ ] **AC-0002:** `integration-runner.ts` uses same pattern.
- [ ] **AC-0003:** Existing 0037 integration tests pass without
      modification (behavior-preserving per BR-0007).
- [ ] **AC-0004:** Existing 0038 integration tests pass without
      modification.
- [ ] **AC-0005:** New test `workflow-runner-lock.integration.test.ts`:
      open a second Prisma transaction that locks one specific
      WorkflowExecution row → call `runDueExecutions()` → assert that
      row was NOT picked up (count from other rows is correct,
      locked row's step counter unchanged) → release second tx →
      next tick picks it up.
- [ ] **AC-0006:** Same test pattern for integration-runner.
- [ ] **AC-0007:** Per-row error in a batch does NOT roll back the
      whole batch (per BR-0005). Test: seed 3 rows, mock step 2 to
      throw → assert rows 1 and 3 processed, row 2 marked failed,
      transaction committed.
- [ ] **AC-0008:** Startup log line per BR-0009 emitted for both
      runners.
- [ ] **AC-0009:** Per-tick log line shows row count claimed.
- [ ] **AC-0010:** No regression in full backend test suite.
- [ ] **AC-0011:** Build pass: BE tsc.

## 7. Dependencies

- `backend/src/workers/workflow-runner.ts` — refactor to
  $transaction + $queryRaw.
- `backend/src/workers/integration-runner.ts` — same.
- `backend/src/modules/workflow/workflow-service.ts` — if
  `processStep` doesn't currently accept a transaction client, extend
  the signature to optionally take one. Same for integration-service
  `executeSyncRun`.
- New tests:
  - `backend/tests/integration/workflow-runner-lock.integration.test.ts`
  - `backend/tests/integration/integration-runner-lock.integration.test.ts`

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| workflow-runner refactor + row type + camelCase mapper | ~70 |
| integration-runner refactor + row type + camelCase mapper | ~70 |
| processStep signature accepting optional tx (if needed) | ~15 |
| executeSyncRun signature accepting optional tx (if needed) | ~15 |
| Per-row error-isolation tweak (BR-0005) | ~10 |
| Lock integration test (workflow) | ~100 |
| Lock integration test (integration) | ~100 |
| Logging additions | ~10 |
| **Total** | **~390 LOC** |

### Risk: LOW-MEDIUM

The pattern is well-trodden. The main risk areas:

1. **`$queryRaw` column order matters** — listing columns explicitly
   instead of `SELECT *` makes the row type stable. Document this in
   a code comment.
2. **Transaction holding the lock too long** — if any single step's
   processing takes minutes (unlikely but possible: Google Sheets
   export of 50k rows), the lock is held that long. Mitigation: keep
   batch sizes small (already the case), and document in RUNBOOK
   that long-running sync expectations should split the work.
3. **Prisma `$transaction` interactive mode + connection pool**.
   Prisma's interactive transactions hold a dedicated connection. If
   we have a small connection pool (current default is ~10), one slow
   worker tick can starve other queries. Mitigation: cron interval >
   typical tick duration, default Prisma connection pool sized for
   peak load. Existing tuning probably OK; will check in
   benchmark before merge.

### Test strategy

Unit-style tests for the lock primitive aren't feasible (Postgres
behavior is the thing being tested). Use real testcontainers
Postgres with two transactions per BR-0011.

For the multi-process correctness test deferred per BR-0012: when
horizontal scaling is on the roadmap, add a load test that spawns
2 docker containers running the backend, points them at the same
DB, generates load via API calls that create due rows, and asserts
log lines from both processes show non-overlapping claims. This
SPEC explicitly defers that work — it's a load-test concern, not
a phase-1 correctness concern.

### Migration risk

Behavior-preserving refactor. No DB schema changes. No new env vars.
Deploy is "merge PR, restart workers". Rollback is "revert commit,
restart workers". Risk floor is low because the existing tests cover
the happy path; if anything regresses, CI catches it.

### Out of scope (Phase 2)

- Spawn-2-processes test harness.
- Refactor other workers (campaign-worker, friendship-worker,
  appointment-reminder) to use the same pattern. They have different
  shapes (e.g. campaign-worker reads from a queue table; friendship-
  worker has its own claim flow) and may or may not need the same fix.
  Audit before refactoring.
- Metrics / observability for lock contention (Prometheus gauges,
  Grafana panel).
- `pg_advisory_xact_lock` alternative for cases where row-level
  locks aren't the right granularity.
- Per-row transaction (current: whole batch in one transaction).
  Switch if batch transaction times become a problem.
- Backpressure: if lock contention is high, slow down the cron
  interval. Not needed at our scale.
