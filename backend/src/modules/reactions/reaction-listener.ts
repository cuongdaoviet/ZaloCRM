/**
 * Reaction listener — feature 0021.
 *
 * Handles `'reaction'` events emitted by zca-js when somebody on the Zalo
 * side adds, changes, or removes a reaction on a message. Listener
 * inspection of `node_modules/zca-js/dist/apis/listen.js` (lines 265–289)
 * confirmed the event name + per-reaction payload shape.
 *
 * Payload (`Reaction` instance, see `dist/models/Reaction.d.ts`):
 *   {
 *     data: {
 *       msgId: string,
 *       uidFrom: string,           // "0" when self (Zalo sets to "0" for sender)
 *       dName?: string,
 *       content: { rType: number, rIcon: Reactions, ... },
 *       ...
 *     },
 *     threadId: string,            // contact UID (1-1) or group id
 *     isSelf: boolean,
 *     isGroup: boolean,
 *   }
 *
 * Pattern mirrors `friendship-listener.ts` — every code path is wrapped in
 * a single try/catch so the listener can never throw out and crash the
 * upstream zca-js socket (BR-0011's spec-pattern; same lesson as 0020).
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { trackBackground } from '../../shared/utils/background-tasks.js';
import { rTypeToEmoji } from './reaction-mapping.js';

interface ReactionEventPayload {
  data?: {
    msgId?: string | number;
    uidFrom?: string;
    dName?: string;
    content?: { rType?: number; rIcon?: string };
  };
  threadId?: string;
  isSelf?: boolean;
  isGroup?: boolean;
}

interface PersistedReaction {
  id: string;
  messageId: string;
  reactorId: string;
  reactorSource: string;
  reactorName: string | null;
  emoji: string;
  createdAt: Date;
}

interface EmitContext {
  accountId: string;
  conversationId: string;
  messageId: string;
  reaction: PersistedReaction | null;
  removed?: { reactorSource: string; reactorId: string };
}

// One-shot guard so we only spam the verification log for the first event we
// see, not every reaction forever. The numeric rType ↔ emoji mapping is
// convention-based (see reaction-mapping.ts); the very first real event
// either confirms the table or shows us the actual values.
let didLogVerificationEvent = false;

/**
 * Process one reaction event for the given Zalo account. Never throws —
 * all errors are caught and logged. Idempotent — replays produce the same
 * end state.
 *
 * @param io  optional Socket.IO server for live broadcast. When null
 *            (e.g. unit tests calling this directly), the listener still
 *            persists; the socket emit is just skipped.
 */
export async function handleReactionEvent(
  accountId: string,
  reaction: ReactionEventPayload,
  io: Server | null = null,
): Promise<void> {
  try {
    if (!reaction || !reaction.data) return;
    const data = reaction.data;
    const msgId = data.msgId !== undefined && data.msgId !== null ? String(data.msgId) : '';
    if (!msgId) {
      logger.warn(`[reaction-listener] event missing msgId for ${accountId}`);
      return;
    }
    const rType = typeof data.content?.rType === 'number' ? data.content.rType : -1;
    const rIcon = data.content?.rIcon ?? '';

    // ── DEV verification log — see reaction-mapping.ts for context ────────
    if (!didLogVerificationEvent) {
      didLogVerificationEvent = true;
      const mapped = rType === 0 ? '(unreact)' : rTypeToEmoji(rType);
      logger.info(
        `[reaction-listener] FIRST EVENT for ${accountId} — rType=${rType}, rIcon="${rIcon}", mappedEmoji="${mapped}"`,
      );
    }

    // ── Find local message ────────────────────────────────────────────────
    // The reaction's threadId tells us which conversation (1-1 or group).
    const message = await prisma.message.findFirst({
      where: {
        zaloMsgId: msgId,
        conversation: { zaloAccountId: accountId },
      },
      select: { id: true, conversationId: true },
    });
    if (!message) {
      // EC-0001 — Zalo sent us a reaction for a message we don't have
      // locally (history sync gap or purged). Drop silently.
      logger.warn(
        `[reaction-listener] dropping reaction for unknown msgId ${msgId} on account ${accountId}`,
      );
      return;
    }

    // ── Resolve reactor identity ──────────────────────────────────────────
    let reactorSource: 'zalo';
    let reactorId: string;
    let reactorName: string | null;

    if (reaction.isSelf) {
      // BR-0008 — react came from the account owner. Use Zalo UID so the
      // CRM-side `(messageId, user.id)` row and the Zalo-side
      // `(messageId, zaloUid)` row can coexist (EC-0004).
      const account = await prisma.zaloAccount.findUnique({
        where: { id: accountId },
        select: { zaloUid: true, displayName: true },
      });
      if (!account || !account.zaloUid) {
        logger.warn(
          `[reaction-listener] self-reaction but ZaloAccount.zaloUid is null for ${accountId}`,
        );
        return;
      }
      reactorSource = 'zalo';
      reactorId = account.zaloUid;
      reactorName = account.displayName ?? null;
    } else {
      reactorSource = 'zalo';
      reactorId = typeof data.uidFrom === 'string' ? data.uidFrom : '';
      reactorName = typeof data.dName === 'string' && data.dName.length > 0 ? data.dName : null;
      if (!reactorId) {
        logger.warn(`[reaction-listener] missing uidFrom for ${accountId}/${msgId}`);
        return;
      }
    }

    // ── rType=0 → unreact: delete row + emit null ────────────────────────
    if (rType === 0) {
      await prisma.messageReaction.deleteMany({
        where: { messageId: message.id, reactorId },
      });
      const ctx: EmitContext = {
        accountId,
        conversationId: message.conversationId,
        messageId: message.id,
        reaction: null,
        removed: { reactorSource, reactorId },
      };
      emitReactionSocket(io, ctx);
      return;
    }

    // ── rType > 0 → upsert ────────────────────────────────────────────────
    const emoji = rTypeToEmoji(rType); // standard or "custom:<rType>"
    const saved = await prisma.messageReaction.upsert({
      where: {
        messageId_reactorId: { messageId: message.id, reactorId },
      },
      create: {
        id: randomUUID(),
        messageId: message.id,
        reactorId,
        reactorSource,
        reactorName,
        emoji,
      },
      update: {
        emoji,
        reactorName,
        reactorSource,
      },
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
    emitReactionSocket(io, {
      accountId,
      conversationId: message.conversationId,
      messageId: message.id,
      reaction: saved,
    });
  } catch (err) {
    // BR-0011-style swallow — never let the listener throw.
    logger.error(`[reaction-listener] handleReactionEvent crashed for ${accountId}:`, err);
  }
}

function emitReactionSocket(io: Server | null, payload: EmitContext): void {
  if (!io) return;
  // Wrap in trackBackground so test teardown drains the emit-callback
  // microtask queue before TRUNCATE (PR #24 lesson). The emit itself is
  // synchronous, so we resolve immediately.
  trackBackground(
    Promise.resolve().then(() => {
      try {
        io.emit('chat:reaction', payload);
      } catch (err) {
        logger.warn('[reaction-listener] socket emit failed:', err);
      }
    }),
  );
}
