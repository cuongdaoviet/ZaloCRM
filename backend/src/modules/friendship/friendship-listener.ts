/**
 * Friendship listener — feature 0020.
 *
 * Handles `friend_event` payloads from zca-js. Inspection of
 * `node_modules/zca-js/dist/apis/listen.js` confirmed the event name is
 * `'friend_event'` (emitted by the WebSocket listener) — the SPEC's
 * placeholder name turned out to be correct. The event has shape:
 *
 *   { type: FriendEventType, data: <varies by type>, threadId: string, isSelf: boolean }
 *
 * `FriendEventType` enum (from zca-js dist/models/FriendEvent.d.ts):
 *   ADD = 0          → friend accepted us / we accepted them
 *   REMOVE = 1       → unfriended (not our concern)
 *   REQUEST = 2      → incoming friend request (not relevant — we're senders)
 *   UNDO_REQUEST = 3 → sender retracted their request
 *   REJECT_REQUEST = 4 → recipient declined
 *   SEEN_FRIEND_REQUEST = 5
 *   BLOCK = 6, UNBLOCK = 7, BLOCK_CALL = 8, UNBLOCK_CALL = 9, PIN_* = 10/11
 *   UNKNOWN = 12
 *
 * Of these we care about ADD (accepted) and REJECT_REQUEST (declined). For
 * ADD the counterparty UID is `threadId`. The listener must swallow ALL
 * errors — never let an audit-log failure or stale event crash the
 * zca-js socket.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import {
  markAccepted,
  markDeclined,
  recordExternalFriend,
} from './friendship-service.js';

// Mirror zca-js's enum so we don't have to import its CJS at runtime.
const FRIEND_EVENT_TYPE = {
  ADD: 0,
  REMOVE: 1,
  REQUEST: 2,
  UNDO_REQUEST: 3,
  REJECT_REQUEST: 4,
  SEEN_FRIEND_REQUEST: 5,
  BLOCK: 6,
  UNBLOCK: 7,
  BLOCK_CALL: 8,
  UNBLOCK_CALL: 9,
  PIN_UNPIN: 10,
  PIN_CREATE: 11,
  UNKNOWN: 12,
} as const;

interface FriendEventPayload {
  type?: number;
  data?: unknown;
  threadId?: string;
  isSelf?: boolean;
}

/**
 * Process one friend event for the given Zalo account. Idempotent — calling
 * twice for the same UID is harmless (markAccepted is no-op if already
 * accepted).
 */
export async function handleFriendEvent(accountId: string, event: FriendEventPayload): Promise<void> {
  try {
    if (!event || typeof event.type !== 'number') {
      return;
    }

    // Only ADD and REJECT_REQUEST drive our state machine. Everything else
    // (REQUEST, BLOCK, PIN, ...) is out of scope for v1.
    if (event.type === FRIEND_EVENT_TYPE.ADD) {
      const uid = extractCounterpartyUid(event);
      if (!uid) {
        logger.warn(`[friendship-listener] ADD without uid for account ${accountId}`);
        return;
      }
      await applyAccepted(accountId, uid);
    } else if (event.type === FRIEND_EVENT_TYPE.REJECT_REQUEST) {
      const uid = extractCounterpartyUid(event);
      if (!uid) return;
      await applyDeclined(accountId, uid);
    }
    // Otherwise: silently ignore — these events are not modeled in v1.
  } catch (err) {
    // BR-0017: listener never throws — log and move on.
    logger.error(`[friendship-listener] handleFriendEvent crashed for ${accountId}:`, err);
  }
}

/**
 * For most events the counterparty UID is `event.threadId`. For
 * REJECT_REQUEST / UNDO_REQUEST the payload is { fromUid, toUid } and we
 * want the OTHER side relative to our account.
 */
function extractCounterpartyUid(event: FriendEventPayload): string | null {
  if (typeof event.threadId === 'string' && event.threadId.length > 0) {
    return event.threadId;
  }
  if (event.data && typeof event.data === 'object') {
    const data = event.data as Record<string, unknown>;
    const fromUid = typeof data.fromUid === 'string' ? data.fromUid : null;
    const toUid = typeof data.toUid === 'string' ? data.toUid : null;
    return fromUid ?? toUid ?? null;
  }
  return null;
}

async function applyAccepted(accountId: string, uid: string): Promise<void> {
  // Find an active attempt with this UID
  const attempt = await prisma.friendshipAttempt.findFirst({
    where: {
      zaloAccountId: accountId,
      zaloUidFound: uid,
      state: { in: ['sent', 'looking_up'] },
    },
    select: { id: true },
    orderBy: { sentAt: 'desc' },
  });
  if (attempt) {
    await markAccepted(attempt.id, 'listener');
    return;
  }
  // EC-0010 — accepted by someone outside CRM. Record Friend row, no attempt.
  await recordExternalFriend(accountId, uid);
}

async function applyDeclined(accountId: string, uid: string): Promise<void> {
  const attempt = await prisma.friendshipAttempt.findFirst({
    where: {
      zaloAccountId: accountId,
      zaloUidFound: uid,
      state: 'sent',
    },
    select: { id: true },
    orderBy: { sentAt: 'desc' },
  });
  if (!attempt) return;
  await markDeclined(attempt.id, 'listener');
}
