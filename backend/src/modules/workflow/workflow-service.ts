/**
 * Workflow service — Feature 0037 (phase 1).
 *
 * Two public entry points:
 *
 *  1. `evaluateWorkflowTriggers(...)` — called from the inbound message
 *     handler (fire-and-forget via trackBackground). Matches active
 *     workflows against the incoming message and creates new
 *     `WorkflowExecution` rows. Respects the 24h cooldown (BR-0007).
 *
 *  2. `processStep(execution)` — called by the worker (workflow-runner.ts)
 *     when a step's `nextStepDueAt` has elapsed. Dispatches to the matching
 *     step executor, updates the execution row's pointer/log, and either
 *     schedules the next step or marks the execution complete.
 *
 * Step executors live below as private helpers; each returns either `ok`
 * or `{ error }`. A failed step sets the execution to `failed` (BR-0006)
 * — subsequent steps do NOT run, admin can manual cancel/retry (phase 2).
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { logActivityAsync } from '../activity/activity-service.js';
import { validateTagName } from '../crm-tags/crm-tag-helpers.js';
import {
  appendStepLog,
  substituteTemplateVars,
  triggerMatches,
  withinCooldown,
  type InboundTrigger,
  type StepLogEntry,
  type StepType,
  type WorkflowStep,
} from './workflow-helpers.js';

export interface EvaluateTriggerInput {
  orgId: string;
  contactId: string | null;
  conversationId: string;
  threadType: 'user' | 'group';
  isSelf: boolean;
  content: string | null;
}

/**
 * Match the incoming inbound message against every active workflow in the
 * caller's org, creating new `WorkflowExecution` rows for those whose
 * trigger fires (and that are NOT inside the 24h cooldown).
 *
 * Safe to call as fire-and-forget — every error is caught + logged so the
 * caller (message-handler) never blocks.
 */
export async function evaluateWorkflowTriggers(
  input: EvaluateTriggerInput,
): Promise<void> {
  try {
    // BR-0005/0006-style: only inbound 1-1 messages can trigger phase 1.
    if (input.threadType !== 'user') return;
    if (input.isSelf) return;
    if (!input.contactId) return;

    const workflows = await prisma.workflowDefinition.findMany({
      where: { orgId: input.orgId, isActive: true },
    });
    if (workflows.length === 0) return;

    const contact = await prisma.contact.findUnique({
      where: { id: input.contactId },
      select: { status: true },
    });

    // EC: contact deleted between message persist and trigger evaluation.
    if (!contact) return;

    // Single query to compute `isFirstInbound` per (account) — we count
    // contact-sent messages in this conversation; if exactly 1 exists
    // (the one we just persisted), this is the first inbound ever.
    const inboundCount = await prisma.message.count({
      where: {
        conversationId: input.conversationId,
        senderType: 'contact',
      },
    });
    const isFirstInbound = inboundCount <= 1;

    for (const wf of workflows) {
      const trigger = wf.trigger as unknown as InboundTrigger;
      if (!trigger || trigger.type !== 'inbound_message') continue;

      const matches = triggerMatches(trigger, {
        content: input.content,
        contactStatus: contact.status,
        isFirstInbound,
      });
      if (!matches) continue;

      // BR-0007 — 24h cooldown per (workflow, contact)
      const latest = await prisma.workflowExecution.findFirst({
        where: { workflowId: wf.id, contactId: input.contactId },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      });
      if (withinCooldown(latest?.startedAt ?? null)) {
        logger.debug(
          `[workflow] cooldown active for wf=${wf.id} contact=${input.contactId}, skip`,
        );
        continue;
      }

      const steps = wf.steps as unknown as WorkflowStep[];
      if (!Array.isArray(steps) || steps.length === 0) continue;

      // Compute when the FIRST step becomes due — honor its delayMinutes
      // so a "Wait X minutes before sending the first message" flow works.
      const firstDelayMin = Number(steps[0].delayMinutes ?? 0);
      const nextStepDueAt = new Date(Date.now() + firstDelayMin * 60 * 1000);

      await prisma.workflowExecution.create({
        data: {
          id: randomUUID(),
          orgId: input.orgId,
          workflowId: wf.id,
          contactId: input.contactId,
          conversationId: input.conversationId,
          status: 'running',
          currentStepIdx: 0,
          nextStepDueAt,
        },
      });

      logger.info(
        `[workflow] triggered wf=${wf.id} contact=${input.contactId} steps=${steps.length}`,
      );
      logActivityAsync({
        orgId: input.orgId,
        userId: null,
        action: 'workflow.triggered',
        entityType: 'workflow',
        entityId: wf.id,
        details: {
          workflowName: wf.name,
          contactId: input.contactId,
          conversationId: input.conversationId,
        },
      });
    }
  } catch (err) {
    logger.error('[workflow] evaluateWorkflowTriggers error:', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Step processing (called by the worker)
// ────────────────────────────────────────────────────────────────────────────

export interface ExecutionLike {
  id: string;
  orgId: string;
  workflowId: string;
  contactId: string;
  conversationId: string | null;
  currentStepIdx: number;
  stepLog: unknown;
}

/**
 * Run the current step of one execution. Updates the row in place:
 *   - On success → advance currentStepIdx, recompute nextStepDueAt for the
 *     NEXT step (or mark `completed` if we just ran the last step).
 *   - On failure → set status='failed', append a step-log entry with the
 *     error, do NOT advance the pointer (BR-0006).
 *
 * Safe to call concurrently against different executions; same-row reentry
 * is prevented at the worker level by `FOR UPDATE SKIP LOCKED` (worker).
 */
export async function processStep(exec: ExecutionLike): Promise<void> {
  // Re-read the workflow definition every tick so an admin disabling /
  // editing a workflow takes effect on subsequent steps. EC-0001 — we
  // continue execution even on disable (predictable behavior phase 1).
  const wf = await prisma.workflowDefinition.findUnique({
    where: { id: exec.workflowId },
  });
  if (!wf) {
    // Definition deleted mid-flight → cancel the execution gracefully.
    await prisma.workflowExecution.update({
      where: { id: exec.id },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    return;
  }

  const steps = wf.steps as unknown as WorkflowStep[];
  if (!Array.isArray(steps) || exec.currentStepIdx >= steps.length) {
    await prisma.workflowExecution.update({
      where: { id: exec.id },
      data: { status: 'completed', completedAt: new Date(), nextStepDueAt: null },
    });
    return;
  }

  const step = steps[exec.currentStepIdx];
  const result = await runStep(step, exec);

  if (!result.ok) {
    const entry: StepLogEntry = {
      idx: exec.currentStepIdx,
      type: step.type as StepType,
      status: 'failed',
      ranAt: new Date().toISOString(),
      error: result.error,
    };
    await prisma.workflowExecution.update({
      where: { id: exec.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        nextStepDueAt: null,
        stepLog: appendStepLog(exec.stepLog, entry) as unknown as object,
      },
    });
    logger.warn(
      `[workflow] step ${exec.currentStepIdx} failed for exec ${exec.id}: ${result.error}`,
    );
    return;
  }

  const okEntry: StepLogEntry = {
    idx: exec.currentStepIdx,
    type: step.type as StepType,
    status: 'ok',
    ranAt: new Date().toISOString(),
  };
  const newLog = appendStepLog(exec.stepLog, okEntry);

  const nextIdx = exec.currentStepIdx + 1;
  if (nextIdx >= steps.length) {
    await prisma.workflowExecution.update({
      where: { id: exec.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        nextStepDueAt: null,
        currentStepIdx: nextIdx,
        stepLog: newLog as unknown as object,
      },
    });
    logger.info(`[workflow] execution ${exec.id} completed`);
    return;
  }

  // Schedule next step based on its own delayMinutes
  const nextStep = steps[nextIdx];
  const delayMin = Number(nextStep.delayMinutes ?? 0);
  const nextDue = new Date(Date.now() + delayMin * 60 * 1000);

  await prisma.workflowExecution.update({
    where: { id: exec.id },
    data: {
      currentStepIdx: nextIdx,
      nextStepDueAt: nextDue,
      stepLog: newLog as unknown as object,
    },
  });
}

// ── Step executors ─────────────────────────────────────────────────────────

type RunResult = { ok: true } | { ok: false; error: string };

async function runStep(step: WorkflowStep, exec: ExecutionLike): Promise<RunResult> {
  try {
    switch (step.type) {
      case 'send_message':
        return await runSendMessage(step.content, exec);
      case 'add_tag':
        return await runAddTag(step.tag, exec);
      case 'assign_user':
        return await runAssignUser(step.userId, exec);
      case 'wait':
        // `wait` is purely a delay — by the time processStep picks it up
        // the delay has already elapsed (nextStepDueAt was set on entry).
        // Nothing to do here except mark it ok and advance.
        return { ok: true };
      default: {
        const exhaustive: never = step;
        return { ok: false, error: `Unknown step type: ${JSON.stringify(exhaustive)}` };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runSendMessage(
  content: string,
  exec: ExecutionLike,
): Promise<RunResult> {
  const contact = await prisma.contact.findUnique({
    where: { id: exec.contactId },
    select: { id: true, fullName: true, zaloUid: true, assignedUserId: true },
  });
  if (!contact) return { ok: false, error: 'Contact không tồn tại' };
  if (!contact.zaloUid) return { ok: false, error: 'Contact thiếu zaloUid' };

  // Resolve repName — prefer assignedUser, fall back to empty so the
  // placeholder collapses cleanly when none assigned.
  let repName = '';
  if (contact.assignedUserId) {
    const rep = await prisma.user.findUnique({
      where: { id: contact.assignedUserId },
      select: { fullName: true },
    });
    if (rep) repName = rep.fullName;
  }

  const text = substituteTemplateVars(content, {
    contactName: contact.fullName,
    repName,
  });

  // Find the Zalo account hosting this conversation so we know which
  // zca-js instance to drive. EC: conversation deleted mid-flight.
  let zaloAccountId: string | null = null;
  if (exec.conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: exec.conversationId },
      select: { zaloAccountId: true },
    });
    if (conv) zaloAccountId = conv.zaloAccountId;
  }
  if (!zaloAccountId) {
    // Fallback: pick any connected zalo account in the org. Phase 1
    // workflows are simple enough that this is acceptable; phase 2 can
    // pin a workflow to a specific account.
    const account = await prisma.zaloAccount.findFirst({
      where: { orgId: exec.orgId, status: 'connected' },
      select: { id: true },
    });
    if (!account) return { ok: false, error: 'Không có tài khoản Zalo nào kết nối' };
    zaloAccountId = account.id;
  }

  const instance = zaloPool.getInstance(zaloAccountId);
  if (!instance?.api) {
    return { ok: false, error: 'Tài khoản Zalo không kết nối' };
  }

  // Defensive sanitize — strip any control chars zca-js could misinterpret.
  const safeText = text.replace(/[ --]/g, '');

  await instance.api.sendMessage({ msg: safeText }, contact.zaloUid, 0);

  // Persist a self-message so the thread shows the outbound (mirrors
  // campaign-worker.ts pattern). Best-effort: failure here doesn't undo
  // the actual send.
  try {
    if (exec.conversationId) {
      const account = await prisma.zaloAccount.findUnique({
        where: { id: zaloAccountId },
        select: { zaloUid: true },
      });
      await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: exec.conversationId,
          senderType: 'self',
          senderUid: account?.zaloUid ?? '',
          senderName: 'Workflow',
          content: safeText,
          contentType: 'text',
          sentAt: new Date(),
        },
      });
      await prisma.conversation.update({
        where: { id: exec.conversationId },
        data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
      });
    }
  } catch (err) {
    logger.warn('[workflow] persist self message failed (non-fatal):', err);
  }

  return { ok: true };
}

async function runAddTag(tag: string, exec: ExecutionLike): Promise<RunResult> {
  const validation = validateTagName(tag);
  if (!validation.ok) return { ok: false, error: `Tag không hợp lệ: ${validation.error}` };

  // Upsert + link in a transaction so a partial failure doesn't leave a
  // CrmTag row without the ContactTag join.
  await prisma.$transaction(async (tx) => {
    const crmTag = await tx.crmTag.upsert({
      where: {
        orgId_normalizedName: {
          orgId: exec.orgId,
          normalizedName: validation.normalized,
        },
      },
      create: {
        id: randomUUID(),
        orgId: exec.orgId,
        name: validation.display,
        normalizedName: validation.normalized,
      },
      update: {},
      select: { id: true },
    });

    const link = await tx.contactTag.findUnique({
      where: { contactId_tagId: { contactId: exec.contactId, tagId: crmTag.id } },
      select: { contactId: true },
    });
    if (!link) {
      await tx.contactTag.create({
        data: {
          contactId: exec.contactId,
          tagId: crmTag.id,
          addedByUserId: null,
        },
      });
      await tx.crmTag.update({
        where: { id: crmTag.id },
        data: { usageCount: { increment: 1 } },
      });
    }
  });

  return { ok: true };
}

async function runAssignUser(userId: string, exec: ExecutionLike): Promise<RunResult> {
  // Validate the user exists in the same org. Defensive — admin may have
  // deleted the assignee after building the workflow.
  const user = await prisma.user.findFirst({
    where: { id: userId, orgId: exec.orgId },
    select: { id: true },
  });
  if (!user) return { ok: false, error: 'assignee không thuộc tổ chức' };

  await prisma.contact.update({
    where: { id: exec.contactId },
    data: { assignedUserId: userId },
  });
  return { ok: true };
}
