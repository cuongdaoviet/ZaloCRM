/**
 * Friendship worker — feature 0020.
 *
 * node-cron tick (every 30s) that:
 *   1. Recovers attempts stuck in `looking_up` for > STUCK_LOOKUP_MS — resets
 *      them to `queued` (EC-0006).
 *   2. Sweeps `sent` attempts past FRIENDSHIP_TIMEOUT_DAYS → `timeout`.
 *   3. Processes a LOOKUP_BATCH of `queued` attempts → findUser.
 *   4. Processes a SEND_BATCH of `looking_up` attempts → sendFriendRequest.
 *
 * Pattern mirrors campaign-worker.ts. Re-entrant safe: every send re-fetches
 * state from DB so a manual cancel takes effect immediately.
 *
 * MANDATORY: every fire-and-forget DB write goes through `logActivityAsync`
 * (which is `trackBackground`-wrapped) — see PR #24 and SPEC §10.
 */
import cron from 'node-cron';
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { logActivityAsync } from '../activity/activity-service.js';
import { nextSendDelayMs } from '../campaigns/campaign-helpers.js';
import { processOneAttempt } from './friendship-service.js';

// Tunables — exposed via env so ops can tweak without redeploying code.
export const LOOKUP_BATCH = 20;
export const SEND_BATCH = 20;
export const MAX_ACCOUNTS_PER_TICK = 5;
export const FRIENDSHIP_TIMEOUT_DAYS = Number(
  process.env.FRIENDSHIP_TIMEOUT_DAYS ?? '7',
);
export const STUCK_LOOKUP_MS = 5 * 60_000;

let workerIo: Server | null = null;
let started = false;

export function startFriendshipWorker(io: Server | null): void {
  if (started) {
    logger.warn('[friendship-worker] already started, skipping');
    return;
  }
  workerIo = io;
  // 6-field cron expr — every 30s
  cron.schedule('*/30 * * * * *', () => {
    tick().catch((err) => logger.error('[friendship-worker] tick error:', err));
  });
  started = true;
  logger.info('[friendship-worker] started (tick every 30s)');
}

/**
 * One tick. Exported for tests + manual triggering.
 */
export async function tick(): Promise<void> {
  await recoverStuckLookups();
  await sweepTimeouts();
  await processBatches();
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Recovery — reset stuck `looking_up` rows back to `queued`
// ──────────────────────────────────────────────────────────────────────────────

async function recoverStuckLookups(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_LOOKUP_MS);
  const result = await prisma.friendshipAttempt.updateMany({
    where: { state: 'looking_up', updatedAt: { lt: cutoff } },
    data: { state: 'queued' },
  });
  if (result.count > 0) {
    logger.info(`[friendship-worker] reset ${result.count} stuck looking_up → queued`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. Timeout sweep — `sent` older than FRIENDSHIP_TIMEOUT_DAYS → `timeout`
// ──────────────────────────────────────────────────────────────────────────────

async function sweepTimeouts(): Promise<void> {
  const cutoff = new Date(Date.now() - FRIENDSHIP_TIMEOUT_DAYS * 86_400_000);
  // Need IDs first so we can emit activity log per row
  const rows = await prisma.friendshipAttempt.findMany({
    where: { state: 'sent', sentAt: { lt: cutoff } },
    select: { id: true, orgId: true },
    take: 500, // safety cap; the next tick will pick up the rest
  });
  if (rows.length === 0) return;

  const now = new Date();
  await prisma.friendshipAttempt.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { state: 'timeout', decidedAt: now },
  });
  for (const r of rows) {
    logActivityAsync({
      orgId: r.orgId,
      userId: null,
      action: 'friendship.timeout',
      entityType: 'friendship_attempt',
      entityId: r.id,
      details: { afterDays: FRIENDSHIP_TIMEOUT_DAYS },
    });
  }
  logger.info(`[friendship-worker] swept ${rows.length} sent → timeout`);
}

// ──────────────────────────────────────────────────────────────────────────────
// 3-4. Batched processing — lookup phase + send phase, grouped per account
// ──────────────────────────────────────────────────────────────────────────────

async function processBatches(): Promise<void> {
  // Fetch active accounts. Group attempts by zaloAccountId; cap at
  // MAX_ACCOUNTS_PER_TICK so a single noisy account can't starve others.
  const candidates = await prisma.friendshipAttempt.findMany({
    where: { state: { in: ['queued', 'looking_up'] } },
    select: { id: true, zaloAccountId: true, state: true, queuedAt: true },
    orderBy: { queuedAt: 'asc' },
    take: (LOOKUP_BATCH + SEND_BATCH) * MAX_ACCOUNTS_PER_TICK,
  });
  if (candidates.length === 0) return;

  // Group per account
  const grouped = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const arr = grouped.get(c.zaloAccountId) ?? [];
    arr.push(c);
    grouped.set(c.zaloAccountId, arr);
  }

  const accountIds = Array.from(grouped.keys()).slice(0, MAX_ACCOUNTS_PER_TICK);
  for (const accountId of accountIds) {
    const items = grouped.get(accountId) ?? [];
    // Lookup phase first
    const lookupIds = items.filter((i) => i.state === 'queued').slice(0, LOOKUP_BATCH).map((i) => i.id);
    const sendIds = items.filter((i) => i.state === 'looking_up').slice(0, SEND_BATCH).map((i) => i.id);

    await processAccountBatch(accountId, [...lookupIds, ...sendIds]);
  }

  if (workerIo) {
    // Cheap progress signal — UI just refreshes the list.
    workerIo.emit('friendship:tick', { processedAccounts: accountIds.length });
  }
}

async function processAccountBatch(accountId: string, attemptIds: string[]): Promise<void> {
  for (const id of attemptIds) {
    let result;
    try {
      result = await processOneAttempt(id);
    } catch (err) {
      logger.error(`[friendship-worker] processOneAttempt ${id} crashed:`, err);
      continue;
    }
    // If we got rate-limited mid-batch, stop processing this account — the
    // remaining attempts wait for the next tick (AC-0012).
    if (result.reason?.startsWith('rate_limited')) {
      logger.info(`[friendship-worker] account ${accountId} rate-limited, breaking batch`);
      return;
    }
    // Don't sleep after terminal failures or unpickables — only between real
    // SDK calls. The "sent" branch is where we actually hit Zalo.
    if (result.finalState === 'sent' || result.finalState === 'accepted') {
      await sleep(nextSendDelayMs());
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
