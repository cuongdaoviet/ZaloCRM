/**
 * message-handler.ts — persists incoming Zalo messages to the database.
 * Called from zalo-pool's startListener on every 'message' / 'undo' event.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { randomUUID } from 'node:crypto';
import { emitWebhook } from '../api/webhook-service.js';
import { mirrorAttachment } from '../../shared/storage/download-mirror.js';

export interface IncomingMessage {
  accountId: string;
  senderUid: string;
  senderName: string;       // zaloName (from cache or dName fallback)
  content: string;
  contentType: string;      // text, image, sticker, video, voice, gif, link, file
  msgId: string;
  timestamp: number;        // epoch ms
  isSelf: boolean;
  threadId: string;         // For user: contact UID. For group: group ID
  threadType: 'user' | 'group'; // user or group conversation
  groupName?: string;       // group name if group message
  attachments?: any[];
  // Feature 0034 — canonical Zalo identifier resolved from `getUserInfo`.
  // Optional: older zca-js payloads and self messages may not carry this.
  senderGlobalId?: string | null;
  // Feature 0031 — reply / quote ref extracted upstream from
  // `message.data.quote` (or `quoted`). When the referenced Zalo msgId
  // matches an existing local Message we set the FK; otherwise we persist
  // the metadata into the content envelope so the FE can still render the
  // quote bubble (no scroll-to-source).
  quoteRef?: IncomingQuoteRef | null;
}

/**
 * Feature 0031 — minimal projection of a zca-js quote/reply ref. We capture
 * the four fields the FE needs to render a fallback bubble when the parent
 * message isn't in our DB (BR-0006 / BR-0008).
 */
export interface IncomingQuoteRef {
  /** Zalo's msgId of the message being replied to. */
  msgId: string;
  /** Quoted preview text (may already be a JSON envelope for media). */
  content: string;
  /** UID of the quoted message's sender. */
  senderUid: string;
  /** Sent timestamp of the quoted message (epoch ms). */
  ts: number;
}

export interface HandleMessageResult {
  message: {
    id: string;
    conversationId: string;
    zaloMsgId: string | null;
    senderType: string;
    senderUid: string | null;
    senderName: string | null;
    content: string | null;
    contentType: string;
    attachments: any;
    isDeleted: boolean;
    deletedAt: Date | null;
    sentAt: Date;
    repliedByUserId: string | null;
    createdAt: Date;
    // Feature 0031 — set when we matched the quote ref to a local message.
    replyToMessageId?: string | null;
  };
  conversationId: string;
  orgId: string;
  contactId: string | null;
  // Feature 0023 — true when this inbound message flipped the conversation
  // from tab='other' back to tab='main'. Caller (listener-factory) emits the
  // `chat:tab` socket event so the FE can move the row between tabs.
  tabPromoted: boolean;
}

export async function handleIncomingMessage(
  msg: IncomingMessage,
): Promise<HandleMessageResult | null> {
  try {
    const account = await prisma.zaloAccount.findUnique({
      where: { id: msg.accountId },
      select: { orgId: true, ownerUserId: true },
    });
    if (!account) return null;

    // Dedupe by zaloMsgId — protect against duplicate inserts when offline
    // messages or history sync overlap with realtime events.
    if (msg.msgId) {
      const existing = await prisma.message.findFirst({
        where: { zaloMsgId: msg.msgId },
        select: { id: true },
      });
      if (existing) return null;
    }

    const contactId = await upsertContact(msg, account.orgId);

    const conversation = await findOrCreateConversation(msg, account.orgId, contactId);

    const sentAt = new Date(msg.timestamp);

    // Feature 0031 BR-0006 — resolve the quote ref to a local FK when the
    // referenced Zalo msgId matches an existing message in OUR conversation
    // (we scope the lookup so we never link to a row from a different
    // conversation). If the ref doesn't match anything in DB we fall back to
    // embedding a `quotedMeta` envelope into `content` so the FE can still
    // render a fallback bubble without a scroll target.
    let replyToMessageId: string | null = null;
    let persistedContent: string = msg.content || '';
    const quoteRef = msg.quoteRef ?? null;
    if (quoteRef?.msgId) {
      const parent = await prisma.message.findFirst({
        where: { zaloMsgId: quoteRef.msgId, conversationId: conversation.id },
        select: { id: true },
      });
      if (parent) {
        replyToMessageId = parent.id;
      } else {
        // BR-0006 fallback — embed quote metadata in content. We keep the
        // user's text intact and tuck the meta into a JSON envelope so the
        // FE's existing parsers can detect it via `quotedMeta` key. EC-0006:
        // FE renders the preview but disables scroll-to-source.
        persistedContent = JSON.stringify({
          text: msg.content || '',
          quotedMeta: {
            msgId: quoteRef.msgId,
            content: truncateInboundQuotePreview(quoteRef.content),
            senderUid: quoteRef.senderUid,
            ts: quoteRef.ts,
          },
        });
      }
    }

    const message = await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: conversation.id,
        zaloMsgId: msg.msgId || null,
        senderType: msg.isSelf ? 'self' : 'contact',
        senderUid: msg.senderUid,
        senderName: msg.senderName || null,
        content: persistedContent,
        contentType: msg.contentType || 'text',
        attachments: msg.attachments ?? [],
        sentAt,
        replyToMessageId,
      },
    });

    await updateConversationAfterMessage(conversation.id, sentAt, msg.isSelf);

    // Feature 0023 — auto-promote: a contact-sent inbound message on a
    // conversation currently in the "Khác" tab flips it back to the main
    // inbox. Self-sent messages do NOT trigger this — the rep replying
    // inside the Khác tab shouldn't yank the row back to Chính (BR-0005).
    let tabPromoted = false;
    if (!msg.isSelf && conversation.tab === 'other') {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { tab: 'main' },
      });
      tabPromoted = true;
    }

    // Feature 0027 — inbound attachment mirror.
    // For image/video/file messages we have an extractable Zalo CDN URL in
    // the content envelope. Download it, re-upload to MinIO, and rewrite
    // the URL fields inside the same JSON envelope (preserving Zalo's
    // metadata like params/fileExt — see MessageThread.vue's getFileInfo).
    // BR-0008: this is BEST-EFFORT. Any failure → keep the original Zalo
    // URL, log a warn, return the message anyway. The message has already
    // been persisted at this point so an exception here would orphan
    // a successful insert — wrap broadly.
    let finalContent = message.content;
    if (['image', 'video', 'file'].includes(message.contentType) && message.content) {
      try {
        const mirrored = await tryMirrorInboundContent(message.content, message.contentType);
        if (mirrored && mirrored !== message.content) {
          const updated = await prisma.message.update({
            where: { id: message.id },
            data: { content: mirrored },
          });
          finalContent = updated.content;
        }
      } catch (err) {
        logger.warn('[message-handler] inbound mirror failed:', err);
      }
    }

    // Track first outbound contact date — set once when agent sends first message
    if (msg.isSelf && contactId) {
      prisma.contact.updateMany({
        where: { id: contactId, firstContactDate: null },
        data: { firstContactDate: new Date(msg.timestamp) },
      }).catch(() => {});
    }

    // Emit webhook for message event (fire-and-forget)
    emitWebhook(account.orgId, msg.isSelf ? 'message.sent' : 'message.received', {
      messageId: message.id,
      conversationId: conversation.id,
      senderUid: msg.senderUid,
      content: msg.content,
      contentType: msg.contentType,
      sentAt: message.sentAt,
    });

    return {
      message: { ...message, content: finalContent },
      conversationId: conversation.id,
      orgId: account.orgId,
      contactId,
      tabPromoted,
    };
  } catch (err) {
    logger.error('[message-handler] handleIncomingMessage error:', err);
    return null;
  }
}

// Upsert contact — handles both user and group conversations.
//
// Feature 0024 — dual name display. `fullName` is the CRM-editable name owned
// by the rep; `zaloDisplayName` is the Zalo display name auto-synced from
// inbound messages. On contact CREATE we seed both with the Zalo name so the
// rep sees something useful before they pick a CRM name. On UPDATE we only
// refresh `zaloDisplayName` — never overwrite `fullName`, the rep owns it
// (BR-0001 / BR-0002). Empty/null senderName never overwrites (EC-0001).
async function upsertContact(msg: IncomingMessage, orgId: string): Promise<string | null> {
  // Group messages: create/update a "contact" record representing the group
  if (msg.threadType === 'group') {
    const groupUid = msg.threadId;
    let groupContact = await prisma.contact.findFirst({
      where: { zaloUid: groupUid, orgId },
      select: { id: true, fullName: true, zaloDisplayName: true },
    });

    if (!groupContact) {
      const initialName = msg.groupName || 'Nhóm';
      groupContact = await prisma.contact.create({
        data: {
          id: randomUUID(),
          orgId,
          zaloUid: groupUid,
          fullName: initialName,
          // BR-0002 — seed zaloDisplayName from groupName on create. Use null
          // when groupName is empty so EC-0001 (no overwrite with empty) still
          // applies on subsequent inbound updates.
          zaloDisplayName: msg.groupName || null,
          metadata: { isGroup: true },
        },
        select: { id: true, fullName: true, zaloDisplayName: true },
      });
      // Emit webhook for new contact created
      emitWebhook(orgId, 'contact.created', { contactId: groupContact.id, fullName: groupContact.fullName });
    } else if (msg.groupName && groupContact.zaloDisplayName !== msg.groupName) {
      // BR-0002 — refresh zaloDisplayName only when the group renamed.
      // fullName is rep-owned now, do NOT touch it.
      await prisma.contact.update({
        where: { id: groupContact.id },
        data: { zaloDisplayName: msg.groupName },
      });
    }
    return groupContact.id;
  }

  // User messages: self messages don't create a contact
  if (msg.isSelf) return null;

  // Feature 0034 — sanitize globalId once at the boundary. Empty / placeholder
  // values are dropped so we never store a meaningless string.
  const incomingGlobalId =
    typeof msg.senderGlobalId === 'string' && msg.senderGlobalId.trim()
      ? msg.senderGlobalId.trim()
      : null;

  let contact = await prisma.contact.findFirst({
    where: { zaloUid: msg.senderUid, orgId },
    // Feature 0024 — read `zaloDisplayName` to skip redundant writes.
    // Feature 0034 BR-0002 — read `zaloGlobalId` so we can apply the
    // no-overwrite policy when incoming and existing values differ.
    select: {
      id: true,
      fullName: true,
      zaloDisplayName: true,
      zaloGlobalId: true,
    },
  });

  if (!contact) {
    const initialName = msg.senderName || 'Unknown';
    contact = await prisma.contact.create({
      data: {
        id: randomUUID(),
        orgId,
        zaloUid: msg.senderUid,
        fullName: initialName,
        // Feature 0024 BR-0001 — seed zaloDisplayName from senderName on create.
        zaloDisplayName: msg.senderName || null,
        // Feature 0034 BR-0002 — set globalId at creation when available.
        zaloGlobalId: incomingGlobalId,
      },
      select: {
        id: true,
        fullName: true,
        zaloDisplayName: true,
        zaloGlobalId: true,
      },
    });
    // Emit webhook for new contact created
    emitWebhook(orgId, 'contact.created', { contactId: contact.id, fullName: contact.fullName });
  } else {
    // Build a single conditional patch so we issue at most one UPDATE.
    const patch: { zaloDisplayName?: string; zaloGlobalId?: string } = {};
    // Feature 0024 BR-0001 — refresh zaloDisplayName only. fullName is
    // rep-owned and must NEVER be overwritten by inbound.
    if (msg.senderName && contact.zaloDisplayName !== msg.senderName) {
      patch.zaloDisplayName = msg.senderName;
    }
    // Feature 0034 BR-0002 — only fill `zaloGlobalId` when currently NULL.
    // If a non-null value differs from `incomingGlobalId` we DO NOT overwrite;
    // log a warning so ops can inspect. Self-match (same value) is a no-op.
    if (incomingGlobalId) {
      if (contact.zaloGlobalId == null) {
        patch.zaloGlobalId = incomingGlobalId;
      } else if (contact.zaloGlobalId !== incomingGlobalId) {
        logger.warn(
          `[message-handler] globalId conflict — contact=${contact.id} ` +
            `existing=${contact.zaloGlobalId} incoming=${incomingGlobalId} ` +
            `zaloUid=${msg.senderUid} orgId=${orgId} — keeping existing`,
        );
      }
    }
    if (Object.keys(patch).length > 0) {
      await prisma.contact.update({ where: { id: contact.id }, data: patch });
    }
  }

  return contact.id;
}

// Find or create conversation — externalThreadId = threadId for both user and group
async function findOrCreateConversation(
  msg: IncomingMessage,
  orgId: string,
  contactId: string | null,
) {
  const externalThreadId = msg.threadId;

  const existing = await prisma.conversation.findFirst({
    where: { zaloAccountId: msg.accountId, externalThreadId },
    // `tab` is needed so the caller can decide whether to auto-promote
    // an existing Khác-tab conversation back to Chính (Feature 0023).
    select: { id: true, tab: true },
  });

  if (existing) return existing;

  // Create with schema defaults (unreadCount=0, isReplied=true, tab='main').
  // updateConversationAfterMessage runs immediately after and applies the
  // correct delta for this specific message — keeping the math in one place.
  return prisma.conversation.create({
    data: {
      id: randomUUID(),
      orgId,
      zaloAccountId: msg.accountId,
      contactId,
      threadType: msg.threadType,
      externalThreadId,
      lastMessageAt: new Date(msg.timestamp),
    },
    select: { id: true, tab: true },
  });
}

// Update conversation metadata after a new message
async function updateConversationAfterMessage(
  conversationId: string,
  sentAt: Date,
  isSelf: boolean,
): Promise<void> {
  const updateData: any = { lastMessageAt: sentAt };
  if (isSelf) {
    updateData.isReplied = true;
    updateData.unreadCount = 0;
  } else {
    updateData.unreadCount = { increment: 1 };
    updateData.isReplied = false;
  }
  await prisma.conversation.update({ where: { id: conversationId }, data: updateData });
}

/**
 * Feature 0027 — Inbound mirror helper.
 *
 * Zalo pushes attachment messages as a JSON envelope serialized into
 * `Message.content` (see zalo-message-helpers.ts → processZaloMessage).
 * The envelope contains the Zalo CDN URL under one or more of:
 * `href`, `hdUrl`, `thumb`. We download whichever URL is most useful,
 * re-upload to MinIO, and rewrite those fields inside the same envelope
 * so the FE still sees the rich shape it expects (params, title, etc.)
 * with the URL now pointing at our bucket.
 *
 * For plain-string URLs (rare — `content` literally starts with `http`)
 * we return a plain MinIO URL string.
 *
 * Returns the rewritten content string, or `null` when there's nothing
 * to mirror (no URL extractable, mirror failed, etc.) — caller keeps the
 * original content unchanged.
 */
async function tryMirrorInboundContent(
  rawContent: string,
  contentType: string,
): Promise<string | null> {
  // Plain URL form — e.g. content === 'https://zdn.vn/...'.
  if (rawContent.startsWith('http')) {
    const result = await mirrorAttachment({ url: rawContent });
    return result ? result.url : null;
  }

  if (!rawContent.startsWith('{')) return null;

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawContent);
  } catch {
    return null;
  }

  // Prefer hdUrl (full-quality video/image) over href, thumb is the poster.
  const sourceUrl =
    pickUrl(envelope.hdUrl) || pickUrl(envelope.href) || pickUrl(envelope.thumb);
  if (!sourceUrl) return null;

  // Best filename hint we have for extension inference.
  const filename =
    (typeof envelope.title === 'string' && envelope.title) ||
    extractFilenameFromParams(envelope.params) ||
    undefined;

  // MIME hint: only `image/video` known from contentType, file MIME lives
  // inside params.fileExt — we'd need a full mapping, so let download-mirror
  // fall back to the response Content-Type header.
  const mimeHint =
    contentType === 'image'
      ? 'image/jpeg'
      : contentType === 'video'
        ? 'video/mp4'
        : undefined;

  const main = await mirrorAttachment({ url: sourceUrl, mimeType: mimeHint, filename });
  if (!main) return null;

  const next: Record<string, unknown> = { ...envelope };
  if (typeof envelope.href === 'string') next.href = main.url;
  if (typeof envelope.hdUrl === 'string') next.hdUrl = main.url;

  // Mirror the thumbnail separately when it's a distinct URL — videos often
  // have a poster image we want to retain locally too. Best-effort: if it
  // fails, leave the Zalo thumb URL in place.
  if (typeof envelope.thumb === 'string' && envelope.thumb && envelope.thumb !== sourceUrl) {
    const thumb = await mirrorAttachment({ url: envelope.thumb, mimeType: 'image/jpeg' });
    if (thumb) next.thumb = thumb.url;
  } else if (typeof envelope.thumb === 'string' && envelope.thumb === sourceUrl) {
    next.thumb = main.url;
  }

  return JSON.stringify(next);
}

function pickUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
}

function extractFilenameFromParams(params: unknown): string | null {
  if (!params) return null;
  try {
    const parsed = typeof params === 'string' ? JSON.parse(params) : params;
    if (parsed && typeof parsed === 'object' && 'fileName' in parsed) {
      const name = (parsed as { fileName?: unknown }).fileName;
      if (typeof name === 'string') return name;
    }
  } catch {
    // Ignore — params is sometimes a free-form string.
  }
  return null;
}

/**
 * Feature 0031 — clip the inbound quote preview before persisting it inside
 * `content.quotedMeta`. Mirrors the GET list endpoint's truncation cap so the
 * FE bubble width stays bounded regardless of which path produced the data.
 */
const INBOUND_QUOTE_PREVIEW_MAX_CHARS = 200;

function truncateInboundQuotePreview(content: string): string {
  if (content.length <= INBOUND_QUOTE_PREVIEW_MAX_CHARS) return content;
  return content.slice(0, INBOUND_QUOTE_PREVIEW_MAX_CHARS) + '…';
}

// Soft-delete a message by its Zalo message ID
export async function handleMessageUndo(accountId: string, zaloMsgId: string): Promise<void> {
  try {
    await prisma.message.updateMany({
      where: { zaloMsgId: String(zaloMsgId) },
      data: { isDeleted: true, deletedAt: new Date() },
    });
    logger.info(`[message-handler] Undo message ${zaloMsgId} for account ${accountId}`);
  } catch (err) {
    logger.error('[message-handler] handleMessageUndo error:', err);
  }
}
