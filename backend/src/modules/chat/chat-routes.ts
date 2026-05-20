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
import { randomUUID } from 'node:crypto';
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
    } = request.query as QueryParams;

    const where: any = { orgId: user.orgId };
    if (accountId) where.zaloAccountId = accountId;

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
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true, zaloUid: true } },
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

    const [unread, unreplied, total] = await Promise.all([
      prisma.conversation.count({ where: { ...baseWhere, unreadCount: { gt: 0 } } }),
      prisma.conversation.count({ where: { ...baseWhere, isReplied: false } }),
      prisma.conversation.count({ where: baseWhere }),
    ]);

    return reply.send({ unread, unreplied, total });
  });

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

      // Build the AttachmentSource buffer payload for zca-js
      const attachmentSource = {
        data: buffer,
        filename: safeFilename as `${string}.${string}`,
        metadata: { totalSize: buffer.length },
      };

      try {
        zaloRateLimiter.recordSend(conversation.zaloAccountId);
        const threadId = conversation.externalThreadId || '';
        const threadType = conversation.threadType === 'group' ? 1 : 0;
        const sendResult = await instance.api.sendMessage(
          { msg: '', attachments: [attachmentSource] },
          threadId,
          threadType,
        );

        const zaloMsgId =
          sendResult?.attachment?.[0]?.msgId !== undefined
            ? String(sendResult.attachment[0].msgId)
            : null;

        const message = await prisma.message.create({
          data: {
            id: randomUUID(),
            conversationId: id,
            zaloMsgId,
            senderType: 'self',
            senderUid: conversation.zaloAccount.zaloUid || '',
            senderName: 'Staff',
            content: safeFilename,
            contentType: isImage ? 'image' : 'file',
            attachments: [
              {
                filename: safeFilename,
                size: buffer.length,
                mimeType,
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
        logger.error('[chat] Send attachment error:', err);
        return reply.status(502).send({ error: 'Gửi file qua Zalo thất bại' });
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
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true, zaloUid: true } },
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
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true, zaloUid: true } },
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
