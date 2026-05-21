/**
 * Feature 0045 — workflow-runner row-level lock (AC-0005).
 *
 * Phase 1 multi-process correctness is asserted via a *simulated*
 * concurrent claim (per SPEC §3 BR-0011 and §8). Spawning two Node
 * processes against the same DB is deferred to a load-test pass; here
 * we open a second Prisma transaction that holds an explicit row
 * lock, drive `runDueExecutions()` while that lock is held, and
 * assert the locked row is skipped — proving `FOR UPDATE SKIP LOCKED`
 * is the mechanic in play.
 *
 * Why two real Postgres transactions (not Vitest mocks):
 *   - The lock primitive being tested IS Postgres' SKIP LOCKED. A
 *     mock can't exercise it; we need a real container.
 *   - Existing 0037 integration tests already use testcontainers in
 *     the same way; we reuse `setupDb()` for symmetry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const sendMessageMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { sendMessage: sendMessageMock } })),
};

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

interface Seed {
  orgId: string;
  contactId: string;
  conversationId: string;
  wfId: string;
}

async function seed(name: string): Promise<Seed> {
  const org = await prisma.organization.create({ data: { name } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `owner-${name}-${Date.now()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      status: 'connected',
      zaloUid: `self-${name}`,
    },
  });
  const contact = await prisma.contact.create({
    data: {
      orgId: org.id,
      zaloUid: `contact-${name}`,
      fullName: 'Contact',
      status: 'new',
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contact.id,
      externalThreadId: `thread-${name}`,
      threadType: 'user',
      unreadCount: 0,
    },
  });
  const wf = await prisma.workflowDefinition.create({
    data: {
      orgId: org.id,
      name: `Wf-${name}`,
      isActive: true,
      trigger: { type: 'inbound_message' },
      steps: [{ type: 'add_tag', tag: 'lead' }],
    },
  });
  return {
    orgId: org.id,
    contactId: contact.id,
    conversationId: conversation.id,
    wfId: wf.id,
  };
}

async function dueExecution(seed: Seed, idx: number = 0): Promise<string> {
  const exec = await prisma.workflowExecution.create({
    data: {
      orgId: seed.orgId,
      workflowId: seed.wfId,
      contactId: seed.contactId,
      conversationId: seed.conversationId,
      status: 'running',
      currentStepIdx: idx,
      nextStepDueAt: new Date(Date.now() - 1000),
    },
  });
  return exec.id;
}

/**
 * Sleep helper. Used to keep the simulated competing transaction
 * holding its lock for long enough that runDueExecutions has time to
 * race through `SELECT … FOR UPDATE SKIP LOCKED` and observe the
 * skip.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AC-0005: workflow-runner uses FOR UPDATE SKIP LOCKED', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
  });

  it('skips a row that is already locked by a competing transaction', async () => {
    const s = await seed('skip-locked');
    const lockedId = await dueExecution(s, 0);
    const freeId = await dueExecution(s, 0);

    // Sanity: both rows visible + due before we start the simulated
    // competing claim.
    const dueBefore = await prisma.workflowExecution.findMany({
      where: { status: 'running', nextStepDueAt: { lte: new Date() } },
    });
    expect(dueBefore).toHaveLength(2);

    // Open a competing Prisma transaction that explicitly locks the
    // first execution row via `FOR UPDATE` (no SKIP LOCKED — we want
    // it to claim the row outright). Hold the lock for ~1.5s — well
    // beyond the worker's tick time so the race is deterministic.
    let competingDone = false;
    const competing = prisma
      .$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM workflow_executions
          WHERE id = ${lockedId}
          FOR UPDATE
        `;
        await sleep(1500);
        competingDone = true;
      })
      .catch((err) => {
        // Surface any unexpected error to the test rather than letting
        // it dangle.
        throw err;
      });

    // Give the competing transaction a beat to actually acquire the
    // lock before we kick off the worker — without this Postgres can
    // process them concurrently and either claim first.
    await sleep(200);

    // Drive the worker while the competing tx still holds its lock.
    // Expectation: SKIP LOCKED claims only `freeId`; `lockedId` is
    // invisible to this transaction.
    const { runDueExecutions } = await import('../../src/workers/workflow-runner.js');
    await runDueExecutions();

    // Competing tx still in flight? Then the skip is real.
    expect(competingDone).toBe(false);

    const lockedAfter = await prisma.workflowExecution.findUnique({
      where: { id: lockedId },
    });
    const freeAfter = await prisma.workflowExecution.findUnique({
      where: { id: freeId },
    });

    // Locked row untouched: status still running, step pointer at 0.
    expect(lockedAfter?.status).toBe('running');
    expect(lockedAfter?.currentStepIdx).toBe(0);
    // Free row processed: step 0 ran, status completed (single-step wf).
    expect(freeAfter?.status).toBe('completed');
    expect(freeAfter?.currentStepIdx).toBe(1);

    // Wait for the competing tx to release; the next tick should now
    // pick up the previously-locked row.
    await competing;
    expect(competingDone).toBe(true);

    // Reset nextStepDueAt because the locked row's value may have
    // drifted in some edge cases; ensures it's due for the next tick.
    await prisma.workflowExecution.update({
      where: { id: lockedId },
      data: { nextStepDueAt: new Date(Date.now() - 1000) },
    });

    await runDueExecutions();

    const lockedFinal = await prisma.workflowExecution.findUnique({
      where: { id: lockedId },
    });
    expect(lockedFinal?.status).toBe('completed');
    expect(lockedFinal?.currentStepIdx).toBe(1);
  }, 30_000);
});

describe('AC-0007: per-row error isolation inside the worker batch', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
  });

  /**
   * SPEC 0045 §6 AC-0007 + BR-0005 — a single step failure inside the
   * batch must NOT roll back the whole transaction. The batch commits
   * with the per-row state changes still in place: rows that ran fine
   * advance + complete, the failing row is marked `failed` with an
   * error appended to its stepLog.
   *
   * Test shape: seed 3 due executions in the same org, force the
   * middle row's step executor to throw, drive a single
   * `runDueExecutions()`. Assert rows 1 and 3 are `completed` while
   * row 2 is `failed` with a stepLog entry — proving the batch
   * transaction committed all three updates atomically.
   */
  it(
    'one failing row does not poison the other rows in the batch',
    async () => {
      const s = await seed('per-row-iso');

      // Three workflows, three executions. Rows 1 and 3 run the
      // (always-succeeding) add_tag step; row 2 runs send_message
      // which is wired to throw via `sendMessageMock.mockRejectedValueOnce`.
      const wfOk1 = await prisma.workflowDefinition.create({
        data: {
          orgId: s.orgId,
          name: 'PerRowOk1',
          isActive: true,
          trigger: { type: 'inbound_message' },
          steps: [{ type: 'add_tag', tag: 'iso-1' }],
        },
      });
      const wfFail = await prisma.workflowDefinition.create({
        data: {
          orgId: s.orgId,
          name: 'PerRowFail',
          isActive: true,
          trigger: { type: 'inbound_message' },
          steps: [{ type: 'send_message', content: 'fail-here' }],
        },
      });
      const wfOk2 = await prisma.workflowDefinition.create({
        data: {
          orgId: s.orgId,
          name: 'PerRowOk2',
          isActive: true,
          trigger: { type: 'inbound_message' },
          steps: [{ type: 'add_tag', tag: 'iso-3' }],
        },
      });

      // Stagger `nextStepDueAt` so the ORDER BY next_step_due_at ASC
      // claim returns the rows in (ok1, fail, ok2) order — matches the
      // SPEC's "row 1, row 2, row 3" framing.
      const now = Date.now();
      const okId1 = (
        await prisma.workflowExecution.create({
          data: {
            orgId: s.orgId,
            workflowId: wfOk1.id,
            contactId: s.contactId,
            conversationId: s.conversationId,
            status: 'running',
            currentStepIdx: 0,
            nextStepDueAt: new Date(now - 3000),
          },
        })
      ).id;
      const failId = (
        await prisma.workflowExecution.create({
          data: {
            orgId: s.orgId,
            workflowId: wfFail.id,
            contactId: s.contactId,
            conversationId: s.conversationId,
            status: 'running',
            currentStepIdx: 0,
            nextStepDueAt: new Date(now - 2000),
          },
        })
      ).id;
      const okId2 = (
        await prisma.workflowExecution.create({
          data: {
            orgId: s.orgId,
            workflowId: wfOk2.id,
            contactId: s.contactId,
            conversationId: s.conversationId,
            status: 'running',
            currentStepIdx: 0,
            nextStepDueAt: new Date(now - 1000),
          },
        })
      ).id;

      // Only the FAIL row's step calls sendMessage. mockRejectedValueOnce
      // means the first (and only) call throws. The two add_tag rows
      // don't touch zca-js at all.
      sendMessageMock.mockRejectedValueOnce(new Error('boom in middle row'));

      const { runDueExecutions } = await import(
        '../../src/workers/workflow-runner.js'
      );
      await runDueExecutions();

      // Row 1 (add_tag) — completed, step advanced.
      const ok1 = await prisma.workflowExecution.findUnique({
        where: { id: okId1 },
      });
      expect(ok1?.status).toBe('completed');
      expect(ok1?.currentStepIdx).toBe(1);

      // Row 2 (send_message that threw) — failed, stepLog has error entry.
      const fail = await prisma.workflowExecution.findUnique({
        where: { id: failId },
      });
      expect(fail?.status).toBe('failed');
      const failLog = fail?.stepLog as unknown as Array<{
        status: string;
        error?: string;
      }>;
      expect(failLog).toHaveLength(1);
      expect(failLog[0].status).toBe('failed');
      expect(failLog[0].error).toContain('boom in middle row');

      // Row 3 (add_tag) — completed, step advanced. THIS is the key
      // assertion: the row AFTER the failing one still got committed,
      // proving BR-0005's per-row error isolation works end-to-end.
      const ok2 = await prisma.workflowExecution.findUnique({
        where: { id: okId2 },
      });
      expect(ok2?.status).toBe('completed');
      expect(ok2?.currentStepIdx).toBe(1);

      // Belt-and-suspenders: the add_tag executor for each ok row should
      // have created its ContactTag link, proving those writes also
      // committed (i.e. the failing row didn't roll back the batch's
      // tag writes either).
      const tags = await prisma.crmTag.findMany({
        where: { orgId: s.orgId },
        select: { normalizedName: true },
      });
      const tagNames = tags.map((t) => t.normalizedName).sort();
      expect(tagNames).toEqual(['iso-1', 'iso-3']);
    },
    30_000,
  );
});
