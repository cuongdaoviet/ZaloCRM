/**
 * Friendship service — feature 0020.
 *
 * Business logic + DB mutations for the FriendshipAttempt state machine.
 * Routes and the worker both call into this module so the rules live in one
 * place. Every state transition is logged via `logActivityAsync` (BR-0017).
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { logActivityAsync } from '../activity/activity-service.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import {
  applyMessagePlaceholders,
} from '../campaigns/campaign-helpers.js';
import {
  canEnqueue,
  canTransition,
  extractZaloUid,
  mapZaloError,
  validateRequestMessage,
  type ZaloUserBasic,
} from './friendship-helpers.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  orgId: string;
  contactId: string;
  zaloAccountId: string;
  message?: string | null;
  userId: string;
  userRole: string;
}

export type EnqueueResult =
  | { ok: true; attempt: { id: string; state: string } & Record<string, unknown> }
  | { ok: false; status: number; code: string; error: string };

export interface BulkEnqueueInput {
  orgId: string;
  zaloAccountId: string;
  contactIds: string[];
  message?: string | null;
  userId: string;
  userRole: string;
}

export interface BulkEnqueueResult {
  queued: Array<{ contactId: string; attemptId: string }>;
  skipped: Array<{ contactId: string; reason: string }>;
  totalQueued: number;
  totalSkipped: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Permission helper — shared by enqueue + bulk
// ──────────────────────────────────────────────────────────────────────────────

async function checkEnqueuePermission(
  orgId: string,
  zaloAccountId: string,
  user: { id: string; role: string },
): Promise<{ ok: true; account: { id: string; ownerUserId: string } } | { ok: false; status: number; code: string; error: string }> {
  const account = await prisma.zaloAccount.findFirst({
    where: { id: zaloAccountId, orgId },
    select: { id: true, ownerUserId: true },
  });
  if (!account) {
    return { ok: false, status: 404, code: 'zalo_account_not_found', error: 'Tài khoản Zalo không tồn tại' };
  }
  const access = await prisma.zaloAccountAccess.findMany({
    where: { zaloAccountId, userId: user.id },
    select: { permission: true },
  });
  if (!canEnqueue(user, account, access)) {
    return { ok: false, status: 403, code: 'forbidden', error: 'Không có quyền dùng tài khoản Zalo này' };
  }
  return { ok: true, account };
}

// ──────────────────────────────────────────────────────────────────────────────
// Enqueue (single contact)
// ──────────────────────────────────────────────────────────────────────────────

export async function enqueueAttempt(input: EnqueueInput): Promise<EnqueueResult> {
  const user = { id: input.userId, role: input.userRole };

  // 1. Permission (BR-0001)
  const perm = await checkEnqueuePermission(input.orgId, input.zaloAccountId, user);
  if (!perm.ok) return perm;

  // 2. Validate message length (BR-0013)
  let requestMsg: string | null;
  try {
    requestMsg = validateRequestMessage(input.message ?? null);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_message',
      error: err instanceof Error ? err.message : 'message không hợp lệ',
    };
  }

  // 3. Contact must exist + have phone (EC-0002)
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, orgId: input.orgId },
    select: { id: true, phone: true, fullName: true },
  });
  if (!contact) {
    return { ok: false, status: 404, code: 'contact_not_found', error: 'Khách hàng không tồn tại' };
  }
  if (!contact.phone || contact.phone.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'contact_missing_phone',
      error: 'Khách hàng chưa có số điện thoại',
    };
  }

  // 4. No active attempt for (contactId, zaloAccountId) — BR-0005
  const existing = await prisma.friendshipAttempt.findFirst({
    where: {
      contactId: input.contactId,
      zaloAccountId: input.zaloAccountId,
      state: { in: ['queued', 'looking_up', 'sent'] },
    },
    select: { id: true, state: true },
  });
  if (existing) {
    return {
      ok: false,
      status: 409,
      code: 'attempt_already_active',
      error: `Đã có lời mời đang chờ (state=${existing.state})`,
    };
  }

  // 5. Insert
  const id = randomUUID();
  const attempt = await prisma.friendshipAttempt.create({
    data: {
      id,
      orgId: input.orgId,
      contactId: input.contactId,
      zaloAccountId: input.zaloAccountId,
      createdByUserId: input.userId,
      state: 'queued',
      requestMsg,
      queuedAt: new Date(),
    },
  });

  logActivityAsync({
    orgId: input.orgId,
    userId: input.userId,
    action: 'friendship.queued',
    entityType: 'friendship_attempt',
    entityId: id,
    details: { contactId: input.contactId, zaloAccountId: input.zaloAccountId },
  });

  return { ok: true, attempt };
}

// ──────────────────────────────────────────────────────────────────────────────
// Bulk enqueue — partial success (AC-0009)
// ──────────────────────────────────────────────────────────────────────────────

export async function bulkEnqueue(input: BulkEnqueueInput): Promise<
  { ok: true; result: BulkEnqueueResult } | { ok: false; status: number; code: string; error: string }
> {
  const user = { id: input.userId, role: input.userRole };

  // Permission once for the whole batch
  const perm = await checkEnqueuePermission(input.orgId, input.zaloAccountId, user);
  if (!perm.ok) return perm;

  // Message validation once
  let requestMsg: string | null;
  try {
    requestMsg = validateRequestMessage(input.message ?? null);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_message',
      error: err instanceof Error ? err.message : 'message không hợp lệ',
    };
  }

  // Dedupe + bound the batch (also catches sloppy clients)
  const uniqueContactIds = Array.from(new Set(input.contactIds.filter((c) => typeof c === 'string' && c.length > 0)));
  if (uniqueContactIds.length === 0) {
    return { ok: false, status: 400, code: 'no_contacts', error: 'Cần ít nhất 1 contactId' };
  }
  if (uniqueContactIds.length > 500) {
    return { ok: false, status: 400, code: 'too_many_contacts', error: 'Tối đa 500 contactId/lần' };
  }

  // Single round-trip to fetch all contacts (org-scoped)
  const contacts = await prisma.contact.findMany({
    where: { id: { in: uniqueContactIds }, orgId: input.orgId },
    select: { id: true, phone: true },
  });
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  // Single round-trip to find existing active attempts for this account
  const activeAttempts = await prisma.friendshipAttempt.findMany({
    where: {
      contactId: { in: uniqueContactIds },
      zaloAccountId: input.zaloAccountId,
      state: { in: ['queued', 'looking_up', 'sent'] },
    },
    select: { contactId: true, state: true },
  });
  const activeByContact = new Map(activeAttempts.map((a) => [a.contactId, a.state]));

  const queued: BulkEnqueueResult['queued'] = [];
  const skipped: BulkEnqueueResult['skipped'] = [];

  for (const contactId of uniqueContactIds) {
    const contact = contactById.get(contactId);
    if (!contact) {
      skipped.push({ contactId, reason: 'contact_not_found' });
      continue;
    }
    if (!contact.phone || contact.phone.trim().length === 0) {
      skipped.push({ contactId, reason: 'contact_missing_phone' });
      continue;
    }
    const activeState = activeByContact.get(contactId);
    if (activeState) {
      skipped.push({ contactId, reason: `attempt_already_active:${activeState}` });
      continue;
    }

    // Insert one-by-one so a malformed row in the middle doesn't kill the batch.
    // Volume is bounded at 500 → tens of ms total, acceptable.
    const id = randomUUID();
    try {
      await prisma.friendshipAttempt.create({
        data: {
          id,
          orgId: input.orgId,
          contactId,
          zaloAccountId: input.zaloAccountId,
          createdByUserId: input.userId,
          state: 'queued',
          requestMsg,
          queuedAt: new Date(),
        },
      });
      queued.push({ contactId, attemptId: id });
      logActivityAsync({
        orgId: input.orgId,
        userId: input.userId,
        action: 'friendship.queued',
        entityType: 'friendship_attempt',
        entityId: id,
        details: { contactId, zaloAccountId: input.zaloAccountId, source: 'bulk' },
      });
    } catch (err) {
      logger.warn(`[friendship] bulk enqueue insert failed for contact ${contactId}: ${err}`);
      skipped.push({ contactId, reason: 'insert_failed' });
    }
  }

  return {
    ok: true,
    result: {
      queued,
      skipped,
      totalQueued: queued.length,
      totalSkipped: skipped.length,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Cancel — BR-0002, BR-0008
// ──────────────────────────────────────────────────────────────────────────────

export type CancelResult =
  | { ok: true; attempt: { id: string; state: string } }
  | { ok: false; status: number; code: string; error: string };

export async function cancelAttempt(
  orgId: string,
  attemptId: string,
  user: { id: string; role: string },
): Promise<CancelResult> {
  const attempt = await prisma.friendshipAttempt.findFirst({
    where: { id: attemptId, orgId },
    select: { id: true, state: true, createdByUserId: true },
  });
  if (!attempt) {
    return { ok: false, status: 404, code: 'not_found', error: 'Không tồn tại' };
  }
  // Permission: owner/admin OR creator
  const isOwnerAdmin = user.role === 'owner' || user.role === 'admin';
  if (!isOwnerAdmin && attempt.createdByUserId !== user.id) {
    return { ok: false, status: 403, code: 'forbidden', error: 'Không có quyền huỷ' };
  }
  if (!canTransition(attempt.state, 'cancelled')) {
    return {
      ok: false,
      status: 409,
      code: 'cannot_cancel',
      error: `Không thể huỷ ở trạng thái ${attempt.state}`,
    };
  }
  const updated = await prisma.friendshipAttempt.update({
    where: { id: attemptId },
    data: { state: 'cancelled', decidedAt: new Date() },
    select: { id: true, state: true },
  });
  logActivityAsync({
    orgId,
    userId: user.id,
    action: 'friendship.cancelled',
    entityType: 'friendship_attempt',
    entityId: attemptId,
    details: { from: attempt.state },
  });
  return { ok: true, attempt: updated };
}

// ──────────────────────────────────────────────────────────────────────────────
// Mark accepted / declined — BR-0015, BR-0016
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Transition `sent → accepted` (or `looking_up → accepted` for the
 * already-friends shortcut per BR-0012). Upserts Friend row + empty
 * Conversation (BR-0016). Idempotent — if the attempt is already in a
 * terminal state, returns ok without writing.
 *
 * @param source 'listener' = zca-js push, 'already_friends' = idempotent
 *   shortcut, 'manual' = future use.
 */
export async function markAccepted(
  attemptId: string,
  source: 'listener' | 'already_friends' | 'manual',
): Promise<{ ok: boolean; reason?: string }> {
  const attempt = await prisma.friendshipAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      orgId: true,
      state: true,
      zaloAccountId: true,
      zaloUidFound: true,
      contactId: true,
    },
  });
  if (!attempt) return { ok: false, reason: 'not_found' };
  if (attempt.state === 'accepted') return { ok: true, reason: 'already_accepted' };
  if (!canTransition(attempt.state, 'accepted')) {
    return { ok: false, reason: `bad_transition:${attempt.state}` };
  }
  if (!attempt.zaloUidFound) {
    // Defensive — by the time we mark accepted, the UID MUST be known
    return { ok: false, reason: 'missing_uid' };
  }

  const now = new Date();
  await prisma.friendshipAttempt.update({
    where: { id: attemptId },
    data: { state: 'accepted', decidedAt: now },
  });

  // Upsert Friend
  await prisma.friend.upsert({
    where: {
      zaloAccountId_zaloUid: {
        zaloAccountId: attempt.zaloAccountId,
        zaloUid: attempt.zaloUidFound,
      },
    },
    create: {
      id: randomUUID(),
      orgId: attempt.orgId,
      zaloAccountId: attempt.zaloAccountId,
      zaloUid: attempt.zaloUidFound,
      contactId: attempt.contactId,
      attemptId: attempt.id,
    },
    update: {
      contactId: attempt.contactId,
      attemptId: attempt.id,
    },
  });

  // BR-0016: upsert empty Conversation so sale can open chat immediately
  await prisma.conversation.upsert({
    where: {
      zaloAccountId_externalThreadId: {
        zaloAccountId: attempt.zaloAccountId,
        externalThreadId: attempt.zaloUidFound,
      },
    },
    create: {
      id: randomUUID(),
      orgId: attempt.orgId,
      zaloAccountId: attempt.zaloAccountId,
      contactId: attempt.contactId,
      threadType: 'user',
      externalThreadId: attempt.zaloUidFound,
    },
    update: {
      contactId: attempt.contactId ?? undefined,
    },
  });

  logActivityAsync({
    orgId: attempt.orgId,
    userId: null,
    action: 'friendship.accepted',
    entityType: 'friendship_attempt',
    entityId: attemptId,
    details: { source, zaloUid: attempt.zaloUidFound },
  });
  return { ok: true };
}

export async function markDeclined(
  attemptId: string,
  source: 'listener' | 'manual',
): Promise<{ ok: boolean; reason?: string }> {
  const attempt = await prisma.friendshipAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, orgId: true, state: true },
  });
  if (!attempt) return { ok: false, reason: 'not_found' };
  if (attempt.state === 'declined') return { ok: true, reason: 'already_declined' };
  if (!canTransition(attempt.state, 'declined')) {
    return { ok: false, reason: `bad_transition:${attempt.state}` };
  }
  await prisma.friendshipAttempt.update({
    where: { id: attemptId },
    data: { state: 'declined', decidedAt: new Date() },
  });
  logActivityAsync({
    orgId: attempt.orgId,
    userId: null,
    action: 'friendship.declined',
    entityType: 'friendship_attempt',
    entityId: attemptId,
    details: { source },
  });
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// External upsert — listener saw an accepted UID with no matching attempt
// (sale kết bạn ngoài CRM — EC-0010). Create a Friend row, no attempt.
// ──────────────────────────────────────────────────────────────────────────────

export async function recordExternalFriend(
  zaloAccountId: string,
  zaloUid: string,
): Promise<void> {
  const account = await prisma.zaloAccount.findUnique({
    where: { id: zaloAccountId },
    select: { orgId: true },
  });
  if (!account) return;
  await prisma.friend.upsert({
    where: { zaloAccountId_zaloUid: { zaloAccountId, zaloUid } },
    create: {
      id: randomUUID(),
      orgId: account.orgId,
      zaloAccountId,
      zaloUid,
    },
    update: {},
  });
  logActivityAsync({
    orgId: account.orgId,
    userId: null,
    action: 'friendship.accepted',
    entityType: 'friend',
    details: { source: 'external', zaloAccountId, zaloUid },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Worker-facing: process a single attempt (lookup OR send phase).
// Exposed so tests can drive the state machine without waiting for cron.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Drive `queued → looking_up → sent` for one attempt. Returns the final
 * state for assertions. Side effects: rate-limiter records, activity log,
 * Contact.metadata.notOnZalo when applicable.
 *
 * NOTE: This is the entry point used by the worker's batch loop AND by
 * integration tests. The worker pre-checks rate-limit before calling; this
 * function checks again so test callers can use it standalone.
 */
export async function processOneAttempt(attemptId: string): Promise<{
  finalState: string;
  reason?: string;
}> {
  const attempt = await prisma.friendshipAttempt.findUnique({
    where: { id: attemptId },
    include: {
      contact: { select: { id: true, phone: true, fullName: true, metadata: true } },
    },
  });
  if (!attempt) return { finalState: 'not_found' };
  if (attempt.state !== 'queued' && attempt.state !== 'looking_up') {
    return { finalState: attempt.state, reason: 'not_pickable' };
  }

  // EC-0007: contact got deleted between enqueue and now
  if (!attempt.contact) {
    return failAttempt(attempt.id, attempt.orgId, 'contact_deleted', 'Contact đã bị xoá');
  }
  if (!attempt.contact.phone || attempt.contact.phone.trim().length === 0) {
    return failAttempt(attempt.id, attempt.orgId, 'contact_missing_phone', 'Contact thiếu phone');
  }

  // Account must be connected
  const instance = zaloPool.getInstance(attempt.zaloAccountId);
  if (!instance?.api) {
    return failAttempt(attempt.id, attempt.orgId, 'account_disconnected', 'Zalo account không kết nối');
  }

  // ── Phase A: queued → looking_up → findUser
  if (attempt.state === 'queued') {
    const limit = zaloRateLimiter.checkLimits(attempt.zaloAccountId);
    if (!limit.allowed) {
      // Transient — leave at queued for next tick
      return { finalState: 'queued', reason: `rate_limited:${limit.reason}` };
    }
    await prisma.friendshipAttempt.update({
      where: { id: attempt.id },
      data: { state: 'looking_up', lookedUpAt: new Date() },
    });
    zaloRateLimiter.recordSend(attempt.zaloAccountId);

    let result: ZaloUserBasic | null = null;
    try {
      // Single retry on transient failure (per SPEC §5 "Lookup fail → retry immediate once")
      try {
        result = await instance.api.findUser(attempt.contact.phone);
      } catch {
        result = await instance.api.findUser(attempt.contact.phone);
      }
    } catch (err) {
      const { errorCode, errorDetail } = mapZaloError(err, 'lookup');
      // BR-0011 — when zca-js says "not on zalo", mark Contact.metadata
      if (errorCode === 'phone_not_on_zalo') {
        await markContactNotOnZalo(attempt.contact.id, attempt.zaloAccountId);
      }
      return failAttempt(attempt.id, attempt.orgId, errorCode, errorDetail);
    }

    const uid = extractZaloUid(result);
    if (!uid) {
      // BR-0011 — set Contact.metadata.notOnZalo, mark attempt error
      await markContactNotOnZalo(attempt.contact.id, attempt.zaloAccountId);
      return failAttempt(
        attempt.id,
        attempt.orgId,
        'phone_not_on_zalo',
        'findUser không trả về Zalo UID',
      );
    }

    // BR-0012 — already a friend → skip send, mark accepted
    const existingFriend = await prisma.friend.findUnique({
      where: { zaloAccountId_zaloUid: { zaloAccountId: attempt.zaloAccountId, zaloUid: uid } },
      select: { id: true },
    });
    await prisma.friendshipAttempt.update({
      where: { id: attempt.id },
      data: { zaloUidFound: uid },
    });
    if (existingFriend) {
      const r = await markAccepted(attempt.id, 'already_friends');
      return { finalState: r.ok ? 'accepted' : 'error', reason: r.reason };
    }
    // Otherwise fall through to send phase below (re-fetch to get fresh state)
  }

  // ── Phase B: looking_up → sent → sendFriendRequest
  // Re-fetch — caller may have cancelled (EC-0008)
  const fresh = await prisma.friendshipAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, state: true, zaloUidFound: true, requestMsg: true, contactId: true },
  });
  if (!fresh || fresh.state !== 'looking_up' || !fresh.zaloUidFound) {
    return { finalState: fresh?.state ?? 'not_found', reason: 'not_pickable_for_send' };
  }

  const limit = zaloRateLimiter.checkLimits(attempt.zaloAccountId);
  if (!limit.allowed) {
    return { finalState: 'looking_up', reason: `rate_limited:${limit.reason}` };
  }

  const resolvedMsg = applyMessagePlaceholders(fresh.requestMsg ?? '', attempt.contact);
  zaloRateLimiter.recordSend(attempt.zaloAccountId);

  try {
    try {
      await instance.api.sendFriendRequest(resolvedMsg, fresh.zaloUidFound);
    } catch {
      await instance.api.sendFriendRequest(resolvedMsg, fresh.zaloUidFound);
    }
  } catch (err) {
    const { errorCode, errorDetail } = mapZaloError(err, 'send');
    if (errorCode === 'already_friends') {
      // EC-0005 — flip straight to accepted
      const r = await markAccepted(attempt.id, 'already_friends');
      return { finalState: r.ok ? 'accepted' : 'error', reason: r.reason };
    }
    return failAttempt(attempt.id, attempt.orgId, errorCode, errorDetail);
  }

  const sentAt = new Date();
  await prisma.friendshipAttempt.update({
    where: { id: attemptId },
    data: { state: 'sent', sentAt, resolvedMsg },
  });
  logActivityAsync({
    orgId: attempt.orgId,
    userId: null,
    action: 'friendship.sent',
    entityType: 'friendship_attempt',
    entityId: attemptId,
    details: { zaloUid: fresh.zaloUidFound },
  });
  return { finalState: 'sent' };
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

async function failAttempt(
  attemptId: string,
  orgId: string,
  errorCode: string,
  errorDetail: string,
): Promise<{ finalState: 'error'; reason: string }> {
  await prisma.friendshipAttempt.update({
    where: { id: attemptId },
    data: {
      state: 'error',
      errorCode,
      errorDetail: errorDetail.slice(0, 1000), // cap to avoid runaway
      decidedAt: new Date(),
    },
  });
  const action =
    errorCode === 'phone_not_on_zalo' ? 'friendship.lookup_failed' : 'friendship.error';
  logActivityAsync({
    orgId,
    userId: null,
    action,
    entityType: 'friendship_attempt',
    entityId: attemptId,
    details: { errorCode, errorDetail },
  });
  return { finalState: 'error', reason: errorCode };
}

async function markContactNotOnZalo(contactId: string, zaloAccountId: string): Promise<void> {
  try {
    const current = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { metadata: true },
    });
    const meta = (current?.metadata && typeof current.metadata === 'object' ? current.metadata : {}) as Record<string, unknown>;
    meta.notOnZalo = {
      checkedAt: new Date().toISOString(),
      by: zaloAccountId,
    };
    await prisma.contact.update({
      where: { id: contactId },
      data: { metadata: meta as object },
    });
  } catch (err) {
    logger.warn(`[friendship] markContactNotOnZalo failed for ${contactId}: ${err}`);
  }
}
