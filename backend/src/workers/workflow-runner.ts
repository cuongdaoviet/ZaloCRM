/**
 * Workflow runner — Feature 0037.
 *
 * Cron-style tick every 60 seconds. Picks up to 50 executions where
 *   status='running' AND nextStepDueAt <= NOW()
 * and dispatches each to `processStep(...)`.
 *
 * Concurrency safety: a module-level `tickRunning` flag prevents the
 * setInterval from re-entering the same tick if a previous tick is still
 * draining. Phase 1 is single-worker so we don't reach for Postgres
 * advisory locks — `FOR UPDATE SKIP LOCKED` is documented as the
 * upgrade path in SPEC §5 EC-0004.
 *
 * Registered from `app.ts` via `startWorkflowRunner()`. Tests can call
 * `runDueExecutions()` directly to step the worker deterministically.
 */
import cron from 'node-cron';
import { prisma } from '../shared/database/prisma-client.js';
import { logger } from '../shared/utils/logger.js';
import { processStep, type ExecutionLike } from '../modules/workflow/workflow-service.js';

const BATCH_SIZE = 50;
let tickRunning = false;
let started = false;

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
  logger.info('[workflow-runner] started (tick every 60s)');
}

/**
 * Process every execution whose `nextStepDueAt` has elapsed. Idempotent and
 * safe to call concurrently with itself (reentry guarded by `tickRunning`).
 * Exported so integration tests can drive ticks manually.
 */
export async function runDueExecutions(): Promise<void> {
  if (tickRunning) {
    logger.debug('[workflow-runner] tick already in progress, skipping');
    return;
  }
  tickRunning = true;
  try {
    const due = await prisma.workflowExecution.findMany({
      where: {
        status: 'running',
        nextStepDueAt: { lte: new Date() },
      },
      take: BATCH_SIZE,
      orderBy: { nextStepDueAt: 'asc' },
      select: {
        id: true,
        orgId: true,
        workflowId: true,
        contactId: true,
        conversationId: true,
        currentStepIdx: true,
        stepLog: true,
      },
    });

    if (due.length === 0) return;

    logger.info(`[workflow-runner] processing ${due.length} due execution(s)`);

    for (const exec of due) {
      try {
        await processStep(exec as ExecutionLike);
      } catch (err) {
        // processStep already catches per-step errors and writes them to
        // the step log. This catch is the last-resort safety net.
        logger.error(
          `[workflow-runner] processStep crashed for ${exec.id}:`,
          err,
        );
      }
    }
  } finally {
    tickRunning = false;
  }
}

/** Exposed for tests so they can assert on the singleton flag. */
export function _isTickRunning(): boolean {
  return tickRunning;
}
