/**
 * Reaction service — feature 0021.
 *
 * Three public operations:
 *   - addOrToggleReaction: POST /messages/:id/reactions
 *   - removeReaction: DELETE /messages/:id/reactions
 *   - listReactions: GET /messages/:id/reactions
 *
 * The unique key on `MessageReaction` is `(messageId, reactorId)`. POSTing
 * the same emoji twice toggles off (row delete); a different emoji updates
 * the existing row. zca-js's outbound `addReaction` call is awaited INSIDE
 * the same transaction so a partner failure rolls back the DB write
 * (AC-0013).
 *
 * ACL is enforced at the route layer via `requireZaloAccess('chat')` — the
 * service trusts the caller. The service DOES however do the org-scoped
 * lookup so cross-org / nonexistent message → typed `not_found`.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import {
  emojiToZcaIcon,
  isStandardEmoji,
  REACTIONS_ENUM,
} from './reaction-mapping.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface ReactionCaller {
  id: string;
  orgId: string;
  fullName: string | null;
}

export type AddOrToggleResult =
  | {
      ok: true;
      kind: 'created' | 'updated';
      reaction: {
        id: string;
        messageId: string;
        reactorId: string;
        reactorSource: string;
        reactorName: string | null;
        emoji: string;
        createdAt: Date;
      };
    }
  | { ok: true; kind: 'toggled_off'; messageId: string; emoji: string }
  | { ok: false; status: number; code: string; error: string };

export type RemoveResult =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

export type ListResult =
  | {
      ok: true;
      reactions: Array<{
        id: string;
        reactorId: string;
        reactorSource: string;
        reactorName: string | null;
        emoji: string;
        createdAt: Date;
      }>;
    }
  | { ok: false; status: number; code: string; error: string };

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

interface MessageContext {
  messageId: string;
  conversationId: string;
  zaloAccountId: string;
  threadId: string;
  threadType: 'user' | 'group';
  zaloMsgId: string | null;
  cliMsgId: string;
  isDeleted: boolean;
}

/**
 * Resolve `(messageId, orgId)` → everything we need to call zca-js and
 * enforce org isolation. Returns null when the message doesn't exist in the
 * caller's org (cross-org or wrong id) — caller turns that into a 404
 * without leaking existence (BR-0003).
 */
async function resolveMessageContext(
  messageId: string,
  orgId: string,
): Promise<MessageContext | null> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { orgId } },
    select: {
      id: true,
      conversationId: true,
      zaloMsgId: true,
      isDeleted: true,
      conversation: {
        select: {
          zaloAccountId: true,
          externalThreadId: true,
          threadType: true,
        },
      },
    },
  });
  if (!message || !message.conversation) return null;
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    zaloAccountId: message.conversation.zaloAccountId,
    threadId: message.conversation.externalThreadId || '',
    threadType: (message.conversation.threadType === 'group' ? 'group' : 'user'),
    zaloMsgId: message.zaloMsgId,
    // zca-js requires a `cliMsgId` on the destination shape; we use zaloMsgId
    // as the cliMsgId when nothing better is available (the bridge accepts
    // the same value for both fields when the message originated outside
    // CRM).
    cliMsgId: message.zaloMsgId ?? '',
    isDeleted: message.isDeleted,
  };
}

interface ZcaReactionInstance {
  api: { addReaction: (icon: string, dest: unknown) => Promise<unknown> };
}

function getZcaInstance(accountId: string): ZcaReactionInstance | null {
  const instance = zaloPool.getInstance(accountId);
  if (!instance || !('api' in instance) || !instance.api) return null;
  // The zalo-pool returns full instances; we only need addReaction here.
  return instance as unknown as ZcaReactionInstance;
}

/** Build the `AddReactionDestination` shape that zca-js's `addReaction` expects. */
function buildDestination(ctx: MessageContext): {
  data: { msgId: string; cliMsgId: string };
  threadId: string;
  type: number;
} {
  return {
    data: { msgId: ctx.zaloMsgId || '', cliMsgId: ctx.cliMsgId },
    threadId: ctx.threadId,
    // zca-js ThreadType: 0=User, 1=Group
    type: ctx.threadType === 'group' ? 1 : 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// addOrToggleReaction (POST)
// ──────────────────────────────────────────────────────────────────────────────

export async function addOrToggleReaction(input: {
  messageId: string;
  emoji: string;
  user: ReactionCaller;
}): Promise<AddOrToggleResult> {
  const { messageId, emoji, user } = input;

  // 1. Validate emoji (BR-0014 — Phase 1 only allows the 6 standard ones).
  if (!isStandardEmoji(emoji)) {
    return { ok: false, status: 400, code: 'invalid_emoji', error: 'Emoji không hợp lệ' };
  }

  // 2. Resolve message + ACL (org-scoped).
  const ctx = await resolveMessageContext(messageId, user.orgId);
  if (!ctx) {
    return { ok: false, status: 404, code: 'message_not_found', error: 'Tin nhắn không tồn tại' };
  }
  if (ctx.isDeleted) {
    return {
      ok: false,
      status: 400,
      code: 'message_deleted',
      error: 'Không thể thả reaction lên tin nhắn đã thu hồi',
    };
  }
  if (!ctx.zaloMsgId) {
    // EC-0002 — outbound message hasn't been ack'd yet so we don't know the
    // Zalo-side msgId to feed addReaction. FE retries after a short delay.
    return {
      ok: false,
      status: 400,
      code: 'message_missing_zalo_msg_id',
      error: 'Tin nhắn chưa được đồng bộ với Zalo (thử lại sau giây lát)',
    };
  }

  // 3. zca-js instance must be connected; otherwise no point starting the tx.
  const zca = getZcaInstance(ctx.zaloAccountId);
  if (!zca) {
    return {
      ok: false,
      status: 502,
      code: 'zalo_reaction_failed',
      error: 'Tài khoản Zalo chưa kết nối',
    };
  }

  // 4. Inspect existing reaction (BR-0004) — decide create / update / toggle.
  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_reactorId: { messageId, reactorId: user.id } },
    select: { id: true, emoji: true },
  });

  const dest = buildDestination(ctx);

  // ── Toggle off path (same emoji again) — delete row + send NONE ──────────
  if (existing && existing.emoji === emoji) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.messageReaction.delete({ where: { id: existing.id } });
        await zca.api.addReaction(REACTIONS_ENUM.NONE, dest);
      });
    } catch (err) {
      logger.warn(`[reactions] toggle-off zca-js failed for ${messageId}:`, err);
      return {
        ok: false,
        status: 502,
        code: 'zalo_reaction_failed',
        error: 'Gửi reaction qua Zalo thất bại',
      };
    }
    return { ok: true, kind: 'toggled_off', messageId, emoji };
  }

  // ── Create or update path — upsert + send new enum ───────────────────────
  const icon = emojiToZcaIcon(emoji);
  let saved: {
    id: string;
    messageId: string;
    reactorId: string;
    reactorSource: string;
    reactorName: string | null;
    emoji: string;
    createdAt: Date;
  };
  try {
    saved = await prisma.$transaction(async (tx) => {
      const upserted = await tx.messageReaction.upsert({
        where: { messageId_reactorId: { messageId, reactorId: user.id } },
        create: {
          id: randomUUID(),
          messageId,
          reactorId: user.id,
          reactorSource: 'crm',
          reactorName: user.fullName,
          emoji,
        },
        update: { emoji, reactorName: user.fullName },
        select: {
          id: true,
          messageId: true,
          reactorId: true,
          reactorSource: true,
          reactorName: true,
          emoji: true,
          createdAt: true,
        },
      });
      // zca-js call is inside the tx so a throw here rolls back the upsert.
      await zca.api.addReaction(icon, dest);
      return upserted;
    });
  } catch (err) {
    logger.warn(`[reactions] addOrToggle zca-js failed for ${messageId}:`, err);
    return {
      ok: false,
      status: 502,
      code: 'zalo_reaction_failed',
      error: 'Gửi reaction qua Zalo thất bại',
    };
  }

  return {
    ok: true,
    kind: existing ? 'updated' : 'created',
    reaction: saved,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// removeReaction (DELETE) — idempotent
// ──────────────────────────────────────────────────────────────────────────────

export async function removeReaction(input: {
  messageId: string;
  user: ReactionCaller;
}): Promise<RemoveResult> {
  const { messageId, user } = input;

  const ctx = await resolveMessageContext(messageId, user.orgId);
  if (!ctx) {
    return { ok: false, status: 404, code: 'message_not_found', error: 'Tin nhắn không tồn tại' };
  }

  const zca = getZcaInstance(ctx.zaloAccountId);
  // Even if the Zalo account is offline we keep the DB write idempotent —
  // delete locally and report success. The user can resync state on next
  // open. (We do still try zca-js when connected.)
  await prisma.messageReaction.deleteMany({
    where: { messageId, reactorId: user.id },
  });

  if (zca && ctx.zaloMsgId) {
    try {
      await zca.api.addReaction(REACTIONS_ENUM.NONE, buildDestination(ctx));
    } catch (err) {
      // Swallow — local row is already gone. Surfacing a 502 here would
      // confuse FE callers since the action _did_ partially succeed.
      logger.warn(`[reactions] removeReaction zca-js failed for ${messageId}:`, err);
    }
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// listReactions (GET)
// ──────────────────────────────────────────────────────────────────────────────

export async function listReactions(input: {
  messageId: string;
  user: ReactionCaller;
}): Promise<ListResult> {
  const { messageId, user } = input;
  const ctx = await resolveMessageContext(messageId, user.orgId);
  if (!ctx) {
    return { ok: false, status: 404, code: 'message_not_found', error: 'Tin nhắn không tồn tại' };
  }
  const reactions = await prisma.messageReaction.findMany({
    where: { messageId },
    select: {
      id: true,
      reactorId: true,
      reactorSource: true,
      reactorName: true,
      emoji: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return { ok: true, reactions };
}
