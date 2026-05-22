/**
 * Search routes:
 *   GET /api/v1/search           — quick cross-resource search (top 10 of each)
 *   GET /api/v1/search/messages  — paginated message search with filters (feature 0006)
 *
 * Org isolation comes from joining `conversation.orgId`. Members are further
 * restricted to Zalo accounts they have access to via `ZaloAccountAccess`.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { validateSearchInput, buildSnippet, stripJsonEnvelope } from './search-helpers.js';

export async function searchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/search', async (request) => {
    const user = request.user!;
    const { q = '' } = request.query as { q: string };
    if (!q || q.length < 2) return { contacts: [], messages: [], appointments: [] };

    const searchTerm = q.trim();

    const [contacts, messages, appointments] = await Promise.all([
      prisma.contact.findMany({
        where: {
          orgId: user.orgId,
          OR: [
            { fullName: { contains: searchTerm, mode: 'insensitive' } },
            { phone: { contains: searchTerm } },
            { notes: { contains: searchTerm, mode: 'insensitive' } },
          ],
        },
        select: { id: true, fullName: true, phone: true, email: true },
        take: 10,
      }),
      prisma.message.findMany({
        where: {
          conversation: { orgId: user.orgId },
          content: { contains: searchTerm, mode: 'insensitive' },
        },
        select: {
          id: true,
          content: true,
          // Include contentType so the FE preview formatter can short-circuit
          // attachment types ('image', 'sticker', 'voice', etc.) before
          // attempting to JSON-parse the body. Without this, the dropdown
          // would render the raw JSON / file metadata as a string.
          contentType: true,
          senderName: true,
          sentAt: true,
          conversation: { select: { id: true, contact: { select: { fullName: true } } } },
        },
        orderBy: { sentAt: 'desc' },
        take: 10,
      }),
      prisma.appointment.findMany({
        where: {
          orgId: user.orgId,
          OR: [
            { notes: { contains: searchTerm, mode: 'insensitive' } },
            { contact: { fullName: { contains: searchTerm, mode: 'insensitive' } } },
          ],
        },
        select: {
          id: true,
          appointmentDate: true,
          appointmentTime: true,
          notes: true,
          contact: { select: { fullName: true } },
        },
        take: 10,
      }),
    ]);

    return { contacts, messages, appointments };
  });

  // Paginated message search with filters — feature 0006
  app.get('/api/v1/search/messages', async (request, reply) => {
    const user = request.user!;
    const validated = validateSearchInput(request.query as Record<string, unknown>);
    if (!validated.ok) return reply.status(400).send({ error: validated.error });
    const f = validated.value;

    // ACL: members are restricted to Zalo accounts they have access to.
    // Owners/admins bypass this — they can search anything in their org.
    let zaloAccountFilter: Prisma.MessageWhereInput['conversation'] = { orgId: user.orgId };
    if (user.role === 'member') {
      const access = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      const ids = access.map((a) => a.zaloAccountId);
      // Empty result short-circuit — member with zero access never sees anything
      if (ids.length === 0) {
        return { messages: [], total: 0, page: f.page, limit: f.limit, totalPages: 0 };
      }
      zaloAccountFilter = { orgId: user.orgId, zaloAccountId: { in: ids } };
    }

    // Optionally narrow further when the caller passed accountId / conversationId / contactId
    if (f.accountId) {
      zaloAccountFilter = { ...zaloAccountFilter, zaloAccountId: f.accountId };
    }
    if (f.conversationId) {
      zaloAccountFilter = { ...zaloAccountFilter, id: f.conversationId };
    }
    if (f.contactId) {
      zaloAccountFilter = { ...zaloAccountFilter, contactId: f.contactId };
    }

    const where: Prisma.MessageWhereInput = {
      conversation: zaloAccountFilter,
      content: { contains: f.q, mode: 'insensitive' },
      isDeleted: false,
    };
    if (f.senderType) where.senderType = f.senderType;
    if (f.contentType) where.contentType = f.contentType;
    if (f.from || f.to) {
      where.sentAt = {};
      if (f.from) where.sentAt.gte = f.from;
      if (f.to) where.sentAt.lte = f.to;
    }

    const [rows, total] = await Promise.all([
      prisma.message.findMany({
        where,
        select: {
          id: true,
          content: true,
          contentType: true,
          senderType: true,
          senderName: true,
          sentAt: true,
          conversation: {
            select: {
              id: true,
              contact: { select: { id: true, fullName: true, avatarUrl: true } },
              zaloAccount: { select: { id: true, displayName: true } },
            },
          },
        },
        orderBy: { sentAt: 'desc' },
        skip: (f.page - 1) * f.limit,
        take: f.limit,
      }),
      prisma.message.count({ where }),
    ]);

    // Also strip the JSON envelope from `content` itself before returning,
    // so any FE consumer that displays raw content (not just snippet) sees
    // the human label too. Mirrors what `buildSnippet` does internally.
    const messages = rows.map((r) => ({
      ...r,
      content: stripJsonEnvelope(r.content),
      snippet: buildSnippet(r.content, f.q),
    }));

    return {
      messages,
      total,
      page: f.page,
      limit: f.limit,
      totalPages: Math.ceil(total / f.limit),
    };
  });
}
