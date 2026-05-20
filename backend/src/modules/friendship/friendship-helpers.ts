/**
 * Pure helpers for the friendship module — feature 0020.
 *
 * Kept side-effect free so they can be unit tested without Prisma or Fastify.
 * - State machine validator (BR-0007).
 * - Permission check (BR-0001).
 * - zca-js error → our error-code mapping (BR-0011, BR-0015, EC-0005, EC-0009).
 */

/**
 * Allowed transitions per BR-0007.
 * Terminal states {accepted, declined, timeout, error, cancelled} have NO
 * outgoing transitions — any further mutation is a 409.
 */
export const VALID_STATE_TRANSITIONS: Record<string, string[]> = {
  queued: ['looking_up', 'cancelled'],
  looking_up: ['sent', 'accepted', 'error', 'cancelled'],
  sent: ['accepted', 'declined', 'timeout', 'error'],
  accepted: [],
  declined: [],
  timeout: [],
  error: [],
  cancelled: [],
};

export function canTransition(from: string, to: string): boolean {
  return VALID_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A state is "active" (occupies the unique slot per BR-0005) iff it is non-terminal. */
export const ACTIVE_STATES: ReadonlyArray<string> = ['queued', 'looking_up', 'sent'];

export function isActiveState(state: string): boolean {
  return ACTIVE_STATES.includes(state);
}

/**
 * BR-0001 — enqueue permission. Caller is allowed when:
 *   - role is owner/admin (full access), OR
 *   - owns the ZaloAccount, OR
 *   - has explicit ZaloAccountAccess with permission ∈ {chat, admin}.
 */
export function canEnqueue(
  user: { id: string; role: string },
  zaloAccount: { ownerUserId: string } | null | undefined,
  access: ReadonlyArray<{ permission: string }>,
): boolean {
  if (!zaloAccount) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;
  if (zaloAccount.ownerUserId === user.id) return true;
  return access.some((a) => a.permission === 'chat' || a.permission === 'admin');
}

/**
 * Map zca-js / network exceptions raised by findUser / sendFriendRequest to our
 * normalized error codes. Used by the worker so the state machine has stable
 * inputs regardless of which Zalo SDK version we're on.
 *
 * Codes covered (per SPEC §3 BR-0011, BR-0015 and §7 edge cases):
 *  - 'phone_not_on_zalo' — findUser returned nothing useful
 *  - 'already_friends'   — send said "already friends" (EC-0005)
 *  - 'lookup_failed'     — findUser threw / timed out
 *  - 'send_failed'       — sendFriendRequest threw / timed out
 *  - 'account_disconnected' — pool returned no instance
 *  - 'contact_deleted'   — race with contact delete (EC-0007)
 *  - 'unknown'           — anything we don't recognize
 */
export function mapZaloError(
  err: unknown,
  phase: 'lookup' | 'send' = 'send',
): { errorCode: string; errorDetail: string } {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const lower = message.toLowerCase();

  if (
    lower.includes('not on zalo') ||
    lower.includes('user not found') ||
    lower.includes('không có zalo') ||
    lower.includes('không tồn tại') ||
    lower.includes('uid not found')
  ) {
    return { errorCode: 'phone_not_on_zalo', errorDetail: message };
  }
  if (lower.includes('already') && lower.includes('friend')) {
    return { errorCode: 'already_friends', errorDetail: message };
  }
  if (
    lower.includes('disconnected') ||
    lower.includes('not connected') ||
    lower.includes('listener')
  ) {
    return { errorCode: 'account_disconnected', errorDetail: message };
  }

  return {
    errorCode: phase === 'lookup' ? 'lookup_failed' : 'send_failed',
    errorDetail: message,
  };
}

/**
 * Validate the optional requestMsg per BR-0013/BR-0014.
 * Returns the trimmed message (may be empty string) or null when the input
 * is null/undefined. Throws if length > 200.
 */
export function validateRequestMessage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error('message phải là chuỗi');
  }
  // Don't trim aggressively — placeholders rely on the literal string. But
  // we strip leading/trailing whitespace for sanity.
  const trimmed = raw.trim();
  if (trimmed.length > 200) {
    throw new Error('message tối đa 200 ký tự');
  }
  return trimmed;
}

/** zca-js `findUser` returns this shape (subset used here). */
export interface ZaloUserBasic {
  uid?: string;
  zalo_name?: string;
  display_name?: string;
  avatar?: string;
}

/**
 * Pull the Zalo UID from a `findUser` result. Returns null when the SDK
 * returns an empty/garbled response (EC-0009). The worker treats null as
 * `phone_not_on_zalo`.
 */
export function extractZaloUid(result: ZaloUserBasic | null | undefined): string | null {
  const uid = result?.uid;
  if (!uid || typeof uid !== 'string') return null;
  const trimmed = uid.trim();
  if (trimmed.length === 0) return null;
  // Zalo UIDs are numeric strings. Reject anything wild.
  if (!/^\d+$/.test(trimmed)) return null;
  return trimmed;
}
