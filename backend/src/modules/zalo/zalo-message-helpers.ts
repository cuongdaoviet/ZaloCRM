/**
 * zalo-message-helpers.ts — utilities for processing incoming Zalo messages.
 * Detects content type from msgType and updates contact avatars fire-and-forget.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import {
  handleIncomingMessage,
  type HandleMessageResult,
  type IncomingQuoteRef,
} from '../chat/message-handler.js';

/**
 * Shared cache entry for user-info lookups.
 */
export interface UserInfoCacheEntry {
  zaloName: string;
  avatar: string;
  phone?: string;
  // Feature 0034 — canonical Zalo identifier. Cached alongside the
  // existing zaloName/avatar so we don't pay a second `getUserInfo` call
  // when persisting an incoming message.
  globalId?: string;
  cachedAt: number;
}

const USER_INFO_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch zaloName + avatar (+ globalId, Feature 0034) from API with a shared
 * in-memory cache (5 min TTL). Returns empty defaults on error so callers
 * can keep going.
 */
export async function resolveZaloName(
  api: any,
  uid: string,
  cache: Map<string, UserInfoCacheEntry>,
): Promise<{ zaloName: string; avatar: string; globalId: string }> {
  const cached = cache.get(uid);
  if (cached && Date.now() - cached.cachedAt < USER_INFO_CACHE_TTL_MS) {
    return {
      zaloName: cached.zaloName,
      avatar: cached.avatar,
      globalId: cached.globalId ?? '',
    };
  }
  try {
    const result = await api.getUserInfo(uid);
    const profiles = result?.changed_profiles || {};
    const profile = profiles[uid] || profiles[`${uid}_0`];
    if (profile) {
      const entry: UserInfoCacheEntry = {
        zaloName:
          profile.zaloName ||
          profile.zalo_name ||
          profile.displayName ||
          profile.display_name ||
          '',
        avatar: profile.avatar || '',
        phone: profile.phoneNumber || '',
        // Feature 0034 — zca-js exposes both `globalId` (camelCase, User type)
        // and `global_id` (snake_case, UserBasic raw) shapes. Read both.
        globalId:
          (typeof profile.globalId === 'string' && profile.globalId) ||
          (typeof profile.global_id === 'string' && profile.global_id) ||
          '',
        cachedAt: Date.now(),
      };
      cache.set(uid, entry);
      return {
        zaloName: entry.zaloName,
        avatar: entry.avatar,
        globalId: entry.globalId ?? '',
      };
    }
  } catch {
    // Network/permission error — fall through and return empty defaults
  }
  return { zaloName: '', avatar: '', globalId: '' };
}

/**
 * Fetch group display name from the zca-js API. Returns '' on error.
 */
export async function resolveGroupName(api: any, groupId: string): Promise<string> {
  try {
    const result = await api.getGroupInfo(groupId);
    return result?.gridInfoMap?.[groupId]?.name || '';
  } catch {
    return '';
  }
}

/**
 * Normalize one zca-js message (UserMessage or GroupMessage shape) and persist it.
 * Used by realtime listener, offline `old_messages` event, and history sync route.
 * Returns the handler result (null if dedupe/skip).
 */
export async function processZaloMessage(opts: {
  accountId: string;
  api: any;
  message: any; // zca-js UserMessage | GroupMessage
  isGroup: boolean;
  userInfoCache: Map<string, UserInfoCacheEntry>;
}): Promise<HandleMessageResult | null> {
  const { accountId, api, message, isGroup, userInfoCache } = opts;
  const senderUid = String(message.data?.uidFrom || '');

  let senderName: string = message.data?.dName || '';
  // Feature 0034 — track the canonical Zalo identifier through the pipeline.
  // Always captured from the same `getUserInfo` call we already make for the
  // display name/avatar, so no extra API roundtrip.
  let senderGlobalId: string | null = null;
  if (!message.isSelf && senderUid && api?.getUserInfo) {
    const userInfo = await resolveZaloName(api, senderUid, userInfoCache);
    if (userInfo.zaloName) senderName = userInfo.zaloName;
    if (userInfo.avatar) updateContactAvatar(senderUid, userInfo.avatar);
    if (userInfo.globalId) senderGlobalId = userInfo.globalId;
  }

  let groupName: string | undefined;
  if (isGroup && message.threadId) {
    groupName = await resolveGroupName(api, message.threadId);
  }

  const rawContent = message.data?.content;
  const content =
    typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
  const contentType = detectContentType(message.data?.msgType, rawContent);

  // Feature 0031 — zca-js delivers reply/quote refs under either
  // `data.quote` or `data.quoted`. The shape varies slightly across versions;
  // extractQuoteRef tolerates both and returns null when no ref is present.
  const quoteRef = extractQuoteRef(message.data);

  return handleIncomingMessage({
    accountId,
    senderUid,
    senderName,
    content,
    contentType,
    msgId: String(message.data?.msgId || ''),
    timestamp: parseInt(message.data?.ts || String(Date.now())),
    isSelf: message.isSelf || false,
    threadId: message.threadId || '',
    threadType: isGroup ? 'group' : 'user',
    groupName,
    attachments: [],
    // Feature 0034 — propagated through to upsertContact for BR-0002.
    senderGlobalId,
    // Feature 0031 — propagated through to the FK resolution in
    // handleIncomingMessage (BR-0006 / BR-0008 fallback).
    quoteRef,
  });
}

/**
 * Feature 0031 — pull a quote ref out of a zca-js message payload. We accept
 * both `data.quote` and `data.quoted` (zca-js versions disagree). The shape
 * we look for is roughly:
 *   { msgId | globalMsgId, content | msg, senderId | uidFrom, ts }
 *
 * Returns null when no usable ref is found; we don't want a partial ref (no
 * msgId) to short-circuit the FK lookup downstream.
 */
export function extractQuoteRef(data: unknown): IncomingQuoteRef | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  const raw =
    (root.quote as Record<string, unknown> | undefined) ||
    (root.quoted as Record<string, unknown> | undefined) ||
    null;
  if (!raw || typeof raw !== 'object') return null;

  // zca-js variants: `msgId`, `globalMsgId`, `cliMsgId`. Prefer the
  // platform-wide msgId which is what our DB uses for dedupe.
  const msgIdRaw =
    raw.msgId ?? raw.globalMsgId ?? raw.cliMsgId ?? raw.msg_id ?? null;
  if (msgIdRaw == null || String(msgIdRaw).trim() === '') return null;

  // `content` may be a string OR an object (image/file envelopes). Stringify
  // objects so the downstream FE can JSON.parse if it cares about media.
  const rawContent = raw.content ?? raw.msg ?? raw.message ?? '';
  const content =
    typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? '');

  const senderUid = String(raw.senderId ?? raw.uidFrom ?? raw.fromUid ?? '');

  // `ts` may be a number or a numeric string; coerce to number, default to 0
  // when malformed.
  const tsRaw = raw.ts ?? raw.cliMsgId ?? null;
  const tsParsed = typeof tsRaw === 'number' ? tsRaw : parseInt(String(tsRaw ?? '0'));
  const ts = Number.isFinite(tsParsed) ? tsParsed : 0;

  return {
    msgId: String(msgIdRaw),
    content,
    senderUid,
    ts,
  };
}

/**
 * Map zca-js msgType string to a normalized content type label.
 * Falls back to 'text' for unrecognised types or plain-string content.
 *
 * Feature 0029 — Zinstant (Zalo bank/QR card) detection. We check BEFORE
 * generic `card` matching because Zalo sometimes ships zinstant payloads
 * under msgType strings that contain "card" too (e.g. `webchat`). Marker
 * `@@ZINSTANT@@` is Zalo's plain-text envelope; JSON-shaped payloads
 * carry `{ appId, params }` keys.
 */
export function detectContentType(msgType: string | undefined, content: any): string {
  // Zinstant detection runs first so it wins over generic 'card'/'rich'.
  if (isZinstantPayload(content)) return 'zinstant';

  if (!msgType) return 'text';
  if (msgType.includes('photo') || msgType.includes('image')) return 'image';
  if (msgType.includes('sticker')) return 'sticker';
  if (msgType.includes('video')) return 'video';
  if (msgType.includes('voice')) return 'voice';
  if (msgType.includes('gif')) return 'gif';
  if (msgType.includes('link')) return 'link';
  if (msgType.includes('location')) return 'location';
  if (msgType.includes('file') || msgType.includes('doc')) return 'file';
  if (msgType.includes('recommended') || msgType.includes('card')) return 'contact_card';
  if (typeof content === 'object' && content !== null) return 'rich';
  return 'text';
}

/**
 * Feature 0029 — true when raw content looks like a Zalo zinstant card
 * envelope (bank/QR/share cards). Tolerant of both string and object
 * shapes. JSON parse failures are swallowed silently (BR-0004).
 */
function isZinstantPayload(content: unknown): boolean {
  if (typeof content === 'string') {
    if (content.includes('@@ZINSTANT@@')) return true;
    if (content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        return hasZinstantShape(parsed);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (content && typeof content === 'object') {
    return hasZinstantShape(content);
  }
  return false;
}

function hasZinstantShape(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return Boolean(obj.appId) && obj.params !== undefined && obj.params !== null;
}

/**
 * Fire-and-forget: fill in a missing avatarUrl on a Contact row.
 * Only updates rows where avatarUrl is currently null.
 */
export function updateContactAvatar(zaloUid: string, avatarUrl: string): void {
  prisma.contact
    .updateMany({
      where: { zaloUid, avatarUrl: null },
      data: { avatarUrl },
    })
    .catch(() => {});
}
