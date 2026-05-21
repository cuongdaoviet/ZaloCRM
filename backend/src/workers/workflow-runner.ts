/**
 * Workflow runner — Feature 0037 (claim mechanic refactored in Feature 0045).
 *
 * Cron-style tick every 60 seconds. Picks up to 50 executions where
 *   status='running' AND nextStepDueAt <= NOW()
 * and dispatches each to `processStep(...)`.
 *
 * Concurrency safety has TWO layers:
 *
 *   1. Cross-process: a Prisma `$transaction` claims the batch via
 *      `$queryRaw` with `FOR UPDATE SKIP LOCKED LIMIT 50`. Other backend
 *      processes querying the same table skip already-claimed rows
 *      automatically. Lock releases on transaction commit (or abort).
 *      See SPEC 0045 §3 BR-0001..BR-0006.
 *
 *   2. Within-process: a module-level `tickRunning` flag prevents the
 *      cron from re-entering the same tick if a previous tick is still
 *      draining (e.g. a slow Sheets sync). Keeps belt-and-suspenders
 *      semantics per SPEC 0045 BR-0003.
 *
 * Registered from `app.ts` via `startWorkflowRunner()`. Tests can call
 * `runDueExecutions()` directly to step the worker deterministically.
 */
import cron from 'node-cron';
import type { Prisma } from '@prisma/client';
import { prisma } from '../shared/database/prisma-client.js';
import { logger } from '../shared/utils/logger.js';
import { processStep, type ExecutionLike } from '../modules/workflow/workflow-service.js';

const BATCH_SIZE = 50;
let tickRunning = false;
let started = false;

/**
 * Raw row shape returned by `$queryRaw`. Prisma does NOT camelCase or type
 * raw query results, so we map snake_case → camelCase explicitly below.
 * Column list is enumerated to keep the type stable (see SPEC §8 Risk #1
 * — `SELECT *` would silently break this contract whenever the schema
 * grows a column).
 */
interface WorkflowExecutionRow {
  id: string;
  org_id: string;
  workflow_id: string;
  contact_id: string;
  conversation_id: string | null;
  status: string;
  current_step_idx: number;
  next_step_due_at: Date | null;
  step_log: unknown;
  started_at: Date;
  completed_at: Date | null;
}

function rowToExecution(row: WorkflowExecutionRow): ExecutionLike {
  return {
    id: row.id,
    orgId: row.org_id,
    workflowId: row.workflow_id,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    currentStepIdx: row.current_step_idx,
    stepLog: row.step_log,
  };
}

export function startWorkflowRunner(): void {
  if (started) {
    logger.warn('[workflow-runner] already started, skipping');
    return;
  }
  // Every minute. node-cron's 5-field expression: minute hour dom mon dow.
  cron.schedule('* * * * *', () => {
    runDueExecutions().catch((err) =>
      logger.error('[workflow-runner] tick error:', err),
    );
  });
  started = true;
  // BR-0009 — make the locking strategy explicit in logs.
  logger.info(
    `[workflow-runner] started, lock=postgres-skip-locked, batch=${BATCH_SIZE}`,
  );
}

/**
 * Process every execution whose `nextStepDueAt` has elapsed. Idempotent and
 * safe to call concurrently across processes — Postgres' `FOR UPDATE SKIP
 * LOCKED` ensures each row is claimed by exactly one process.
 *
 * Within a single process, re-entry is still guarded by `tickRunning` so
 * a slow tick can't trigger a second concurrent batch on the same Node
 * event loop.
 *
 * Exported so integration tests can drive ticks manually.
 */
export async function runDueExecutions(): Promise<void> {
  if (tickRunning) {
    logger.debug('[workflow-runner] tick already in progress, skipping');
    return;
  }
  tickRunning = true;
  try {
    // The whole batch lives in ONE Prisma interactive transaction. The
    // row-level locks taken by `FOR UPDATE SKIP LOCKED` are held until
    // the transaction commits at the bottom of this block. Any updates
    // applied inside `processStep` MUST route through `tx` (we pass it
    // in) so they're part of this same transaction; otherwise they'd
    // escape the lock and race with another process re-claiming the row.
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const rows = await tx.$queryRaw<WorkflowExecutionRow[]>`
        SELECT id, org_id, workflow_id, contact_id, conversation_id,
               status, current_step_idx, next_step_due_at, step_log,
               started_at, completed_at
        FROM workflow_executions
        WHERE status = 'running'
          AND next_step_due_at <= NOW()
        ORDER BY next_step_due_at ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;

      // BR-0009 / AC-0009 — observability: a steady-state of 0 here on
      // a multi-process deployment indicates another process is claiming
      // the rows first, which is the intended behavior.
      logger.info(`[workflow-runner] tick: claimed ${rows.length} row(s)`);

      if (rows.length === 0) return;

      for (const row of rows) {
        const exec = rowToExecution(row);
        try {
          // BR-0005 — per-row error isolation. A throwing step does NOT
          // roll back the whole transaction. We log + continue to the
          // next row; the transaction commits at the end, releasing all
          // locks and persisting whatever state each step wrote.
          await processStep(exec, tx);
        } catch (err) {
          logger.error(
            `[workflow-runner] processStep crashed for ${exec.id}:`,
            err,
          );
        }
      }
    });
  } finally {
    tickRunning = false;
  }
}

/** Exposed for tests so they can assert on the singleton flag. */
export function _isTickRunning(): boolean {
  return tickRunning;
}
