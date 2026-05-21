/**
 * chat-routes.ts — REST API for conversations and messages.
 * All routes require JWT auth and are scoped to the user's org.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import { logger } from '../../shared/utils/logger.js';
import { uploadBuffer } from '../../shared/storage/minio-client.js';
import { config } from '../../config/index.js';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'socket.io';

type QueryParams = Record<string, string>;

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── List conversations (paginated, filtered) ────────────────────────────
  // Feature 0022 — query params (subset of ZaloCRM-3.0 FilterRail shape):
  //   page, limit, search, accountId       — existing
  //   unread     = '' | 'true' | '1'       — only convs with unreadCount > 0
  //   unreplied  = '' | 'true' | '1'       — only convs with isReplied = false
  //   dateFrom   = YYYY-MM-DD              — lastMessageAt >= start of date (UTC)
  //   dateTo     = YYYY-MM-DD              — lastMessageAt <= end of date (UTC)
  //   from / to                            — legacy aliases for dateFrom/dateTo
  //   tags       = CSV of CrmTag UUIDs     — contact has ANY of these tags
  //                                          (Phase 0019-C — junction-based,
  //                                          differs from 3.0 which sent names)
  app.get('/api/v1/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const {
      page = '1',
      limit = '50',
      search = '',
      accountId = '',
      unread = '',
      unreplied = '',
      dateFrom = '',
      dateTo = '',
      from = '',
      to = '',
      tags = '',
      // Feature 0023 — split inbox into "main" (Chính) / "other" (Khác).
      // Omitted → no filter (returns both tabs) for back-compat with
      // existing callers (campaigns, dashboard, search).
      tab = '',
    } = request.query as QueryParams;

    const where: any = { orgId: user.orgId };
    if (accountId) where.zaloAccountId = accountId;
    if (tab) where.tab = tab;

    // Build a single `contact` sub-filter that composes search + tag filter.
    const contactWhere: any = {};
    if (search) {
      contactWhere.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }
    if (tags) {
      const tagIds = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagIds.length > 0) {
        contactWhere.contactTags = { some: { tagId: { in: tagIds } } };
      }
    }
    if (Object.keys(contactWhere).length > 0) {
      where.contact = contactWhere;
    }

    if (unread === 'true' || unread === '1') {
      where.unreadCount = { gt: 0 };
    }
    if (unreplied === 'true' || unreplied === '1') {
      where.isReplied = false;
    }

    // Date range on lastMessageAt. `dateFrom`/`dateTo` preferred (FilterRail
    // shape); `from`/`to` accepted as legacy aliases. Invalid → 400.
    const dFrom = dateFrom || from;
    const dTo = dateTo || to;
    if (dFrom || dTo) {
      const range: { gte?: Date; lte?: Date } = {};
      if (dFrom) {
        const d = new Date(dFrom);
        if (Number.isNaN(d.getTime())) {
          return reply.status(400).send({ error: 'dateFrom không hợp lệ' });
        }
        range.gte = d;
      }
      if (dTo) {
        const d = new Date(dTo + 'T23:59:59.999Z');
        if (Number.isNaN(d.getTime())) {
          return reply.status(400).send({ error: 'dateTo không hợp lệ' });
        }
        range.lte = d;
      }
      if (range.gte || range.lte) {
        where.lastMessageAt = range;
      }
    }

    // Members can only see conversations from Zalo accounts they have access to
    if (user.role === 'member') {
      const accessibleAccounts = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      const accessibleIds = accessibleAccounts.map((a) => a.zaloAccountId);
      if (accountId && accessibleIds.includes(accountId)) {
        where.zaloAccountId = accountId;
      } else {
        where.zaloAccountId = { in: accessibleIds };
      }
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          // Feature 0024 — include zaloDisplayName so the conversation list
          // can render the Zalo display name as muted secondary text when it
          // differs from the rep-owned fullName.
          contact: { select: { id: true, fullName: true, zaloDisplayName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
          messages: {
            take: 1,
            orderBy: { sentAt: 'desc' },
            select: { content: true, contentType: true, senderType: true, sentAt: true, isDeleted: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.conversation.count({ where }),
    ]);

    return { conversations, total, page: parseInt(page), limit: parseInt(limit) };
  });

  // ── Conversation filter counts (unread, unreplied, total) — feature 0022 ─
  // NOTE: Must be registered BEFORE /api/v1/conversations/:id to avoid the
  // parameterised route swallowing the literal 'counts' segment.
  app.get('/api/v1/conversations/counts', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { accountId = '' } = request.query as QueryParams;

    const baseWhere: any = { orgId: user.orgId };
    if (accountId) baseWhere.zaloAccountId = accountId;

    if (user.role === 'member') {
      const accessibleAccounts = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      const accessibleIds = accessibleAccounts.map((a) => a.zaloAccountId);
      if (accountId && accessibleIds.includes(accountId)) {
        baseWhere.zaloAccountId = accountId;
      } else {
        baseWhere.zaloAccountId = { in: accessibleIds };
      }
    }

    // Feature 0023 — `mainUnread` / `otherUnread` break down the unread total
    // by tab so the FE can render per-tab badges. Existing `unread` is the
    // sum across both tabs (back-compat with Feature 0022).
    const [unread, unreplied, total, mainUnread, otherUnread] = await Promise.all([
      prisma.conversation.count({ where: { ...baseWhere, unreadCount: { gt: 0 } } }),
      prisma.conversation.count({ where: { ...baseWhere, isReplied: false } }),
      prisma.conversation.count({ where: baseWhere }),
      prisma.conversation.count({
        where: { ...baseWhere, unreadCount: { gt: 0 }, tab: 'main' },
      }),
      prisma.conversation.count({
        where: { ...baseWhere, unreadCount: { gt: 0 }, tab: 'other' },
      }),
    ]);

    return reply.send({ unread, unreplied, total, mainUnread, otherUnread });
  });

  // ── Move conversation between tabs (feature 0023) ────────────────────────
  // PATCH /api/v1/conversations/:id/tab — body: { tab: 'main' | 'other' }.
  // Permission: requireZaloAccess('chat'). Owner/admin bypass; members need
  // 'chat' or 'admin' on the underlying Zalo account.
  // Cross-org → 404 (updateMany returns 0 because orgId filter doesn't match).
  app.patch(
    '/api/v1/conversations/:id/tab',
    { preHandler: requireZaloAccess('chat') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const { tab } = (request.body ?? {}) as { tab?: string };

      if (!tab || !['main', 'other'].includes(tab)) {
        return reply.status(400).send({ error: 'tab phải là "main" hoặc "other"' });
      }

      const updated = await prisma.conversation.updateMany({
        where: { id, orgId: user.orgId },
        data: { tab },
      });

      if (updated.count === 0) {
        return reply.status(404).send({ error: 'Không tìm thấy cuộc trò chuyện' });
      }

      // Broadcast so other tabs / clients can move the row between tabs.
      // `reason: 'manual'` lets the FE distinguish user actions from
      // auto-promote (BR-0005) and decide whether to show a toast.
      const io = (app as any).io as Server | undefined;
      io?.emit('chat:tab', {
        conversationId: id,
        tab,
        reason: 'manual',
      });

      return { success: true, tab };
    },
  );

  // ── Get single conversation ──────────────────────────────────────────────
  app.get('/api/v1/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: {
        contact: true,
        zaloAccount: { select: { id: true, displayName: true, zaloUid: true, status: true } },
      },
    });
    if (!conversation) return reply.status(404).send({ error: 'Not found' });

    return conversation;
  });

  // ── List messages for a conversation (paginated, newest first) ──────────
  app.get('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { page = '1', limit = '50' } = request.query as QueryParams;

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: id },
        // Feature 0021 — reactions are returned inline so MessageThread
        // doesn't need a round-trip per message. Other relations stay
        // implicit (Prisma includes scalar fields by default).
        include: {
          reactions: {
            select: {
              id: true,
              reactorId: true,
              reactorSource: true,
              reactorName: true,
              emoji: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { sentAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.message.count({ where: { conversationId: id } }),
    ]);

    return { messages: messages.reverse(), total, page: parseInt(page), limit: parseInt(limit) };
  });

  // ── Send message ─────────────────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('chat') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { content } = request.body as { content: string };

    if (!content?.trim()) return reply.status(400).send({ error: 'Content required' });

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: { zaloAccount: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const instance = zaloPool.getInstance(conversation.zaloAccountId);
    if (!instance?.api) return reply.status(400).send({ error: 'Zalo account not connected' });

    // Rate limit check — prevent account blocking
    const limits = zaloRateLimiter.checkLimits(conversation.zaloAccountId);
    if (!limits.allowed) {
      return reply.status(429).send({ error: limits.reason });
    }

    try {
      const threadId = conversation.externalThreadId || '';
      // zca-js sendMessage(message, threadId, type) — type: 0=User, 1=Group
      const threadType = conversation.threadType === 'group' ? 1 : 0;

      zaloRateLimiter.recordSend(conversation.zaloAccountId);
      await instance.api.sendMessage({ msg: content }, threadId, threadType);

      const message = await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          senderType: 'self',
          senderUid: conversation.zaloAccount.zaloUid || '',
          senderName: 'Staff',
          content,
          contentType: 'text',
          sentAt: new Date(),
          repliedByUserId: user.id,
        },
      });

      await prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
      });

      const io = (app as any).io as Server;
      io?.emit('chat:message', { accountId: conversation.zaloAccountId, message, conversationId: id });

      return message;
    } catch (err) {
      logger.error('[chat] Send message error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });

  // ── Mark conversation as read ────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/mark-read', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    await prisma.conversation.updateMany({
      where: { id, orgId: user.orgId },
      data: { unreadCount: 0 },
    });

    return { success: true };
  });

  // ── Upload + send an attachment (image / file) — feature 0003 ────────────
  // Allowed MIME types — keep in sync with SPEC §3 BR-0004
  const ALLOWED_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip',
  ]);
  const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

  app.post(
    '/api/v1/conversations/:id/attachments',
    { preHandler: requireZaloAccess('chat') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const conversation = await prisma.conversation.findFirst({
        where: { id, orgId: user.orgId },
        include: { zaloAccount: true },
      });
      if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

      const instance = zaloPool.getInstance(conversation.zaloAccountId);
      if (!instance?.api) return reply.status(400).send({ error: 'Zalo account not connected' });

      // Rate limit (shared with text send)
      const limits = zaloRateLimiter.checkLimits(conversation.zaloAccountId);
      if (!limits.allowed) return reply.status(429).send({ error: limits.reason });

      // Pull the single uploaded file from multipart form
      let file: Awaited<ReturnType<typeof request.file>> | undefined;
      try {
        file = await request.file();
      } catch (err: any) {
        // @fastify/multipart throws FST_REQ_FILE_TOO_LARGE when limit hit
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(413).send({ error: 'File quá lớn (tối đa 20MB)' });
        }
        return reply.status(400).send({ error: 'Upload không hợp lệ' });
      }
      if (!file) return reply.status(400).send({ error: 'Thiếu file trong form-data' });

      const mimeType = file.mimetype;
      if (!ALLOWED_MIME.has(mimeType)) {
        return reply.status(415).send({ error: `Loại tệp không cho phép: ${mimeType}` });
      }

      // Buffer the file. multipart may throw FST_REQ_FILE_TOO_LARGE here too.
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch (err: any) {
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(413).send({ error: 'File quá lớn (tối đa 20MB)' });
        }
        throw err;
      }
      if (buffer.length === 0) return reply.status(400).send({ error: 'File rỗng' });

      const isImage = IMAGE_MIME.has(mimeType);
      const filename = file.filename || 'attachment';
      // zca-js AttachmentSource requires filename to have an extension like `${string}.${string}`
      const safeFilename = filename.includes('.') ? filename : `${filename}.bin`;

      // Feature 0027 — MinIO/S3 attachment mirror (primary path).
      // Feature 0032 — Zalo CDN fallback when MinIO is disabled.
      //
      // Flow:
      //   1. Save buffer to a tmp file (uploadAttachment needs a path).
      //   2. If `config.minioEnabled` (default), upload to MinIO first.
      //      - On success: call zca-js sendMessage with the buffer
      //        (AttachmentSource), persist Message with MinIO URL as
      //        `content`. Existing 0027 contract preserved.
      //      - On failure: 502 `storage_failed` (Feature 0027 BR-0005 —
      //        opt-in to MinIO means we never accept a Zalo-only URL).
      //   3. If `minioEnabled=false` (env opt-out): Zalo CDN fallback
      //      (Feature 0032 BR-0001..BR-0003):
      //      a. `api.uploadAttachment(tmpPath, threadDest)` — returns
      //         `{ hdUrl, normalUrl, thumb, ... }` from Zalo CDN.
      //      b. Validate hdUrl non-empty — if empty (Zalo flake / 3.0 bug):
      //         502 `upload_failed`. We NEVER persist a Message with an
      //         empty hdUrl (root cause of the 3.0 image-preview bug).
      //      c. `api.sendMessage({ attachments: [hdUrl] })` to deliver.
      //      d. Persist Message with `content` as a JSON envelope
      //         `{ href, hdUrl, thumb }` — matches the inbound envelope
      //         shape (see message-handler.ts), so the FE's getImageUrl()
      //         picks up the URL without changes.
      //   4. Both paths populate `attachments[0]` JSON metadata with
      //      `hdUrl` + `thumb` (when available) so future export / forward
      //      features have the Zalo CDN reference, not just the mirror URL.
      //   5. Delete the tmp file in `finally`.
      //
      // If zca-js sendMessage fails AFTER MinIO succeeds (0027 BR-0006) →
      // 502 `zalo_send_failed`, MinIO object orphaned (acceptable, RUNBOOK).
      const tmpDir = path.join(tmpdir(), 'zalocrm-upload', randomUUID());
      const tmpPath = path.join(tmpDir, safeFilename);

      try {
        await mkdir(tmpDir, { recursive: true });
        await writeFile(tmpPath, buffer);

        let mirrorUrl: string | null = null;
        if (config.minioEnabled) {
          // Primary path — MinIO mirror. On failure we return 502
          // `storage_failed` (Feature 0027 BR-0005) WITHOUT calling Zalo,
          // because the deployment opted into MinIO mirroring and we must
          // not silently persist a Zalo-only URL.
          try {
            const mirror = await uploadBuffer(buffer, mimeType, safeFilename);
            mirrorUrl = mirror.url;
          } catch (err) {
            logger.error('[chat] MinIO upload failed:', err);
            return reply
              .status(502)
              .send({ error: 'Không lưu được file lên bộ nhớ', code: 'storage_failed' });
          }
        }
        // else: Feature 0032 — env opted out (MINIO_ENABLED=false) → skip
        // MinIO entirely and drop straight into the Zalo CDN fallback below.

        const threadId = conversation.externalThreadId || '';
        const threadType = conversation.threadType === 'group' ? 1 : 0;

        if (mirrorUrl) {
          // ── Primary path: MinIO mirror + zca-js sendMessage with buffer ─
          try {
            zaloRateLimiter.recordSend(conversation.zaloAccountId);
            const attachmentSource = {
              data: buffer,
              filename: safeFilename as `${string}.${string}`,
              metadata: { totalSize: buffer.length },
            };
            const sendResult = await instance.api.sendMessage(
              { msg: '', attachments: [attachmentSource] },
              threadId,
              threadType,
            );

            const zaloMsgId =
              sendResult?.attachment?.[0]?.msgId !== undefined
                ? String(sendResult.attachment[0].msgId)
                : null;

            // Feature 0032 — best-effort: zca-js sometimes echoes hdUrl /
            // normalUrl in the attachment response. Persist when present so
            // future export / forward features have the Zalo CDN ref.
            const zaloAtt = (sendResult?.attachment?.[0] ?? {}) as Record<string, unknown>;
            const echoedHdUrl =
              typeof zaloAtt.hdUrl === 'string'
                ? zaloAtt.hdUrl
                : typeof zaloAtt.normalUrl === 'string'
                  ? zaloAtt.normalUrl
                  : null;
            const echoedThumb = typeof zaloAtt.thumb === 'string' ? zaloAtt.thumb : null;

            const message = await prisma.message.create({
              data: {
                id: randomUUID(),
                conversationId: id,
                zaloMsgId,
                senderType: 'self',
                senderUid: conversation.zaloAccount.zaloUid || '',
                senderName: 'Staff',
                // 0027 contract: `content` is the MinIO URL (plain string).
                // FE's getImageUrl() handles `content.startsWith('http')`.
                content: mirrorUrl,
                contentType: isImage ? 'image' : 'file',
                attachments: [
                  {
                    filename: safeFilename,
                    size: buffer.length,
                    mimeType,
                    url: mirrorUrl,
                    // 0032 BR-0002 — populate when Zalo response carries them.
                    hdUrl: echoedHdUrl,
                    thumb: echoedThumb,
                  },
                ],
                sentAt: new Date(),
                repliedByUserId: user.id,
              },
            });

            await prisma.conversation.update({
              where: { id },
              data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
            });

            const io = (app as any).io as Server | undefined;
            io?.emit('chat:message', {
              accountId: conversation.zaloAccountId,
              message,
              conversationId: id,
            });

            return reply.status(201).send(message);
          } catch (err) {
            // 0027 BR-0006 — MinIO succeeded but Zalo failed. We orphan
            // the MinIO object on purpose; replaying with the same buffer
            // would create a second object. RUNBOOK documents the sweep.
            logger.error('[chat] Send attachment to Zalo failed:', err);
            return reply
              .status(502)
              .send({ error: 'Gửi file qua Zalo thất bại', code: 'zalo_send_failed' });
          }
        }

        // ── Feature 0032 — Zalo CDN fallback path ────────────────────────
        // BR-0001..BR-0003: uploadAttachment FIRST → validate hdUrl →
        // sendMessage with the returned URL. We persist the hdUrl from
        // uploadAttachment (NOT from sendMessage) because zca-js
        // sometimes returns empty hdUrl on the sendMessage response — the
        // root cause of the 3.0 empty-preview bug.
        let uploadResp: Record<string, unknown> = {};
        try {
          zaloRateLimiter.recordSend(conversation.zaloAccountId);
          const apiAny = instance.api as unknown as {
            uploadAttachment?: (
              src: string | string[],
              threadId: string,
              threadType?: number,
            ) => Promise<unknown>;
          };
          if (typeof apiAny.uploadAttachment !== 'function') {
            logger.error(
              '[chat] zca-js instance does not expose uploadAttachment — fallback unavailable',
            );
            return reply
              .status(502)
              .send({ error: 'Không tải được file lên Zalo', code: 'upload_failed' });
          }

          const raw = await apiAny.uploadAttachment(tmpPath, threadId, threadType);
          // zca-js may return the response directly or wrapped in an array
          // (single-file API). Normalise to a single object.
          uploadResp =
            (Array.isArray(raw) ? (raw[0] as Record<string, unknown>) : (raw as Record<string, unknown>)) ?? {};
        } catch (err) {
          // EC-0002 — uploadAttachment threw (network, quota, auth).
          logger.error('[chat] Zalo uploadAttachment failed:', err);
          return reply
            .status(502)
            .send({ error: 'Không tải được file lên Zalo', code: 'upload_failed' });
        }

        // BR-0003 / EC-0001 — validate non-empty hdUrl. Prefer hdUrl, then
        // normalUrl, then fileUrl (zca-js variants observed in the wild).
        const pick = (v: unknown): string | null =>
          typeof v === 'string' && v.length > 0 ? v : null;
        const hdUrl =
          pick(uploadResp.hdUrl) ||
          pick(uploadResp.normalUrl) ||
          pick(uploadResp.fileUrl) ||
          pick((uploadResp as { url?: unknown }).url);
        const thumb = pick(uploadResp.thumb);

        if (!hdUrl) {
          logger.error(
            '[chat] uploadAttachment returned empty hdUrl — refusing to persist:',
            uploadResp,
          );
          return reply
            .status(502)
            .send({ error: 'Không tải được file lên Zalo', code: 'upload_failed' });
        }

        try {
          const sendResult = await instance.api.sendMessage(
            { msg: '', attachments: [hdUrl] } as any,
            threadId,
            threadType,
          );

          const zaloMsgId =
            sendResult?.attachment?.[0]?.msgId !== undefined
              ? String(sendResult.attachment[0].msgId)
              : sendResult?.message?.msgId !== undefined
                ? String(sendResult.message.msgId)
                : null;

          // BR-0002 — `content` is a JSON envelope matching the inbound
          // shape so the FE's getImageUrl() (and any export/forward code)
          // sees the same structure regardless of inbound vs. outbound.
          const envelope = {
            href: hdUrl,
            hdUrl,
            thumb,
          };

          const message = await prisma.message.create({
            data: {
              id: randomUUID(),
              conversationId: id,
              zaloMsgId,
              senderType: 'self',
              senderUid: conversation.zaloAccount.zaloUid || '',
              senderName: 'Staff',
              content: JSON.stringify(envelope),
              contentType: isImage ? 'image' : 'file',
              attachments: [
                {
                  filename: safeFilename,
                  size: buffer.length,
                  mimeType,
                  url: hdUrl,
                  hdUrl,
                  thumb,
                },
              ],
              sentAt: new Date(),
              repliedByUserId: user.id,
            },
          });

          await prisma.conversation.update({
            where: { id },
            data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
          });

          const io = (app as any).io as Server | undefined;
          io?.emit('chat:message', {
            accountId: conversation.zaloAccountId,
            message,
            conversationId: id,
          });

          return reply.status(201).send(message);
        } catch (err) {
          // EC-0003 — MinIO down + Zalo sendMessage failed: surface 502.
          logger.error('[chat] Send attachment to Zalo (fallback) failed:', err);
          return reply
            .status(502)
            .send({ error: 'Gửi file qua Zalo thất bại', code: 'zalo_send_failed' });
        }
      } finally {
        // Best-effort cleanup — disk-full or permission issues here are
        // already a problem we'd see from the writeFile above.
        await unlink(tmpPath).catch(() => {});
      }
    },
  );

  // ── Create new conversation with a contact (feature 0002) ────────────────
  app.post<{ Body: { accountId?: string; contactId?: string } }>(
    '/api/v1/conversations',
    async (request, reply) => {
      const user = request.user!;
      const { accountId, contactId } = request.body ?? {};

      if (!accountId || !contactId) {
        return reply.status(400).send({ error: 'accountId và contactId là bắt buộc' });
      }

      // Verify account belongs to user's org
      const account = await prisma.zaloAccount.findFirst({
        where: { id: accountId, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account không tồn tại' });

      // Verify contact belongs to user's org + has a Zalo UID (synced)
      const contact = await prisma.contact.findFirst({
        where: { id: contactId, orgId: user.orgId },
        select: { id: true, zaloUid: true },
      });
      if (!contact) return reply.status(404).send({ error: 'Khách hàng không tồn tại' });
      if (!contact.zaloUid) {
        return reply
          .status(400)
          .send({ error: 'Khách hàng chưa được sync từ Zalo (chưa có zaloUid)' });
      }

      // Permission gate: members need 'chat' permission on the Zalo account
      if (!['owner', 'admin'].includes(user.role)) {
        const access = await prisma.zaloAccountAccess.findFirst({
          where: { zaloAccountId: accountId, userId: user.id },
        });
        const level = access?.permission;
        if (level !== 'chat' && level !== 'admin') {
          return reply
            .status(403)
            .send({ error: 'Không có quyền chat trên tài khoản Zalo này' });
        }
      }

      // Idempotent: return existing conversation if one already exists
      const existing = await prisma.conversation.findFirst({
        where: { zaloAccountId: accountId, externalThreadId: contact.zaloUid },
        include: {
          // Feature 0024 — include zaloDisplayName for dual-name display.
          contact: { select: { id: true, fullName: true, zaloDisplayName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
        },
      });
      if (existing) {
        return reply.status(200).send({ ...existing, messages: [] });
      }

      const created = await prisma.conversation.create({
        data: {
          id: randomUUID(),
          orgId: user.orgId,
          zaloAccountId: accountId,
          contactId: contact.id,
          threadType: 'user',
          externalThreadId: contact.zaloUid,
          lastMessageAt: null,
        },
        include: {
          // Feature 0024 — include zaloDisplayName for dual-name display.
          contact: { select: { id: true, fullName: true, zaloDisplayName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
        },
      });

      logger.info(
        `[chat] User ${user.id} created conversation ${created.id} with contact ${contact.id}`,
      );
      return reply.status(201).send({ ...created, messages: [] });
    },
  );
}
