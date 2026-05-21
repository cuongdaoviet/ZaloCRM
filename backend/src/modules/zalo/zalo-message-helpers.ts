/**
 * zalo-message-helpers.ts — utilities for processing incoming Zalo messages.
 * Detects content type from msgType and updates contact avatars fire-and-forget.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { handleIncomingMessage, type HandleMessageResult } from '../chat/message-handler.js';

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
  });
}

/**
 * Map zca-js msgType string to a normalized content type label.
 * Falls back to 'text' for unrecognised types or plain-string content.
 */
export function detectContentType(msgType: string | undefined, content: any): string {
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
