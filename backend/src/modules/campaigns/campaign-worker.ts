/**
 * Campaign worker — node-cron tick that:
 *   1. Promotes scheduled campaigns whose `scheduledAt` has arrived to running.
 *   2. For each running campaign, processes a batch of pending targets,
 *      sending each through zca-js with a randomized inter-message delay.
 *
 * Re-entrant safe: every tick re-reads campaign state from DB before sending
 * the next target, so a manual pause/cancel takes effect immediately even
 * inside an in-flight batch.
 */
import cron from 'node-cron';
import type { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import {
  applyMessagePlaceholders,
  nextSendDelayMs,
} from './campaign-helpers.js';
import { logActivityAsync } from '../activity/activity-service.js';

const BATCH_SIZE = 10;
const MAX_CONCURRENT_CAMPAIGNS_PER_TICK = 5;

let workerIo: Server | null = null;
let started = false;

export function startCampaignWorker(io: Server | null): void {
  if (started) {
    logger.warn('[campaign-worker] already started, skipping');
    return;
  }
  workerIo = io;
  // Every 30 seconds — node-cron supports 6-field expressions
  cron.schedule('*/30 * * * * *', () => {
    tick().catch((err) => logger.error('[campaign-worker] tick error:', err));
  });
  started = true;
  logger.info('[campaign-worker] started (tick every 30s)');
}

async function tick(): Promise<void> {
  // 1. Promote scheduled campaigns due now
  const due = await prisma.campaign.findMany({
    where: {
      status: 'scheduled',
      scheduledAt: { lte: new Date() },
      isDeleted: false,
    },
    select: { id: true },
  });
  for (const c of due) {
    await prisma.campaign.update({
      where: { id: c.id },
      data: { status: 'running', startedAt: new Date() },
    });
    emitStatus(c.id, 'running');
    logger.info(`[campaign-worker] promoted ${c.id} scheduled → running`);
  }

  // 2. Process running campaigns. Group by zaloAccountId so we only handle
  // ONE campaign per account per tick — sequential per account (BR-0008).
  const running = await prisma.campaign.findMany({
    where: { status: 'running', isDeleted: false },
    orderBy: { startedAt: 'asc' }, // oldest first → FIFO when 2 queued on same account
    select: { id: true, zaloAccountId: true },
    take: MAX_CONCURRENT_CAMPAIGNS_PER_TICK * 3, // overfetch since we dedupe by account
  });

  const seenAccounts = new Set<string>();
  const toProcess: string[] = [];
  for (const c of running) {
    if (seenAccounts.has(c.zaloAccountId)) continue;
    seenAccounts.add(c.zaloAccountId);
    toProcess.push(c.id);
    if (toProcess.length >= MAX_CONCURRENT_CAMPAIGNS_PER_TICK) break;
  }

  for (const id of toProcess) {
    await processCampaignBatch(id);
  }
}

async function processCampaignBatch(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { zaloAccount: { select: { id: true, status: true } } },
  });
  if (!campaign || campaign.status !== 'running') return;

  // Pick pending targets
  const targets = await prisma.campaignTarget.findMany({
    where: { campaignId, status: 'pending' },
    include: { contact: { select: { id: true, zaloUid: true, fullName: true } } },
    take: BATCH_SIZE,
  });

  if (targets.length === 0) {
    // No pending → check if all targets are terminal → mark completed
    const remaining = await prisma.campaignTarget.count({
      where: { campaignId, status: 'pending' },
    });
    if (remaining === 0) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'completed', completedAt: new Date() },
      });
      emitStatus(campaignId, 'completed');
      logger.info(`[campaign-worker] campaign ${campaignId} completed`);
      logActivityAsync({
        orgId: campaign.orgId,
        userId: null, // system event
        action: 'campaign.completed',
        entityType: 'campaign',
        entityId: campaignId,
        details: {
          sentCount: campaign.sentCount,
          failedCount: campaign.failedCount,
          skippedCount: campaign.skippedCount,
        },
      });
    }
    return;
  }

  for (const target of targets) {
    // Re-check campaign + account state before each send
    const fresh = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (fresh?.status !== 'running') {
      logger.info(`[campaign-worker] ${campaignId} no longer running, stopping batch`);
      return;
    }

    // Rate limit check
    const limit = zaloRateLimiter.checkLimits(campaign.zaloAccountId);
    if (!limit.allowed) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'paused' },
      });
      emitStatus(campaignId, 'paused', { reason: limit.reason });
      logger.warn(`[campaign-worker] ${campaignId} paused — rate limit: ${limit.reason}`);
      logActivityAsync({
        orgId: campaign.orgId,
        userId: null,
        action: 'campaign.paused',
        entityType: 'campaign',
        entityId: campaignId,
        details: { reason: 'rate_limit', detail: limit.reason },
      });
      return;
    }

    // Skip targets whose contact lost its zaloUid mid-campaign
    if (!target.contact.zaloUid) {
      await markTarget(target.id, campaignId, 'skipped', 'Contact thiếu zaloUid');
      continue;
    }

    // Account must be connected
    const instance = zaloPool.getInstance(campaign.zaloAccountId);
    if (!instance?.api) {
      await markTarget(
        target.id,
        campaignId,
        'failed',
        'Tài khoản Zalo không kết nối',
      );
      continue;
    }

    try {
      const text = applyMessagePlaceholders(campaign.message, target.contact);
      zaloRateLimiter.recordSend(campaign.zaloAccountId);
      await instance.api.sendMessage({ msg: text }, target.contact.zaloUid, 0);
      // Persist a Message row so the conversation thread shows the send
      await persistOutgoingMessage(campaign, target.contact, text);
      await markTarget(target.id, campaignId, 'sent', null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markTarget(target.id, campaignId, 'failed', msg);
    }

    // Inter-message delay
    await sleep(nextSendDelayMs());
  }

  // After batch, emit progress
  const stats = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { sentCount: true, failedCount: true, skippedCount: true, totalTargets: true },
  });
  if (stats) {
    workerIo?.emit('campaign:progress', { campaignId, ...stats });
  }
}

async function persistOutgoingMessage(
  campaign: { id: string; zaloAccountId: string; orgId: string },
  contact: { id: string; zaloUid: string | null },
  text: string,
): Promise<void> {
  if (!contact.zaloUid) return;

  // Reuse or create the conversation tied to this contact+account pair
  const conversation = await prisma.conversation.upsert({
    where: {
      zaloAccountId_externalThreadId: {
        zaloAccountId: campaign.zaloAccountId,
        externalThreadId: contact.zaloUid,
      },
    },
    create: {
      id: randomUUID(),
      orgId: campaign.orgId,
      zaloAccountId: campaign.zaloAccountId,
      contactId: contact.id,
      threadType: 'user',
      externalThreadId: contact.zaloUid,
      lastMessageAt: new Date(),
    },
    update: { lastMessageAt: new Date() },
  });

  await prisma.message.create({
    data: {
      id: randomUUID(),
      conversationId: conversation.id,
      senderType: 'self',
      senderUid: '',
      senderName: `Campaign: ${campaign.id.slice(0, 8)}`,
      content: text,
      contentType: 'text',
      sentAt: new Date(),
    },
  });
}

async function markTarget(
  targetId: string,
  campaignId: string,
  status: 'sent' | 'failed' | 'skipped',
  errorMessage: string | null,
): Promise<void> {
  await prisma.campaignTarget.update({
    where: { id: targetId },
    data: {
      status,
      errorMessage,
      sentAt: status === 'sent' ? new Date() : undefined,
      attemptCount: { increment: 1 },
    },
  });
  // Bump campaign-level counter atomically
  const counterField =
    status === 'sent' ? 'sentCount' : status === 'failed' ? 'failedCount' : 'skippedCount';
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { [counterField]: { increment: 1 } },
  });
}

function emitStatus(campaignId: string, status: string, extra?: Record<string, unknown>): void {
  workerIo?.emit('campaign:status', { campaignId, status, ...extra });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
