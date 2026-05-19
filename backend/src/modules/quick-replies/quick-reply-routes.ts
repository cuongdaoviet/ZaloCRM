/**
 * Quick replies CRUD — feature 0004.
 *
 * Visibility model:
 * - scope="org" rows are visible to everyone in the org
 * - scope="user" rows are visible only to their creator
 * Members can only create/edit/delete their own user-scoped rows; admins and
 * owners can manage any row in their org.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { validatePayload } from './quick-reply-helpers.js';

function isPrivileged(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function quickReplyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List visible templates (org-shared + user's own)
  app.get('/api/v1/quick-replies', async (request) => {
    const user = request.user!;
    const replies = await prisma.quickReply.findMany({
      where: {
        orgId: user.orgId,
        OR: [{ scope: 'org' }, { scope: 'user', createdByUserId: user.id }],
      },
      include: {
        createdBy: { select: { id: true, fullName: true } },
      },
      orderBy: [{ scope: 'asc' }, { shortcut: 'asc' }],
    });
    return {
      replies: replies.map((r) => ({
        id: r.id,
        shortcut: r.shortcut,
        content: r.content,
        scope: r.scope,
        createdByUserId: r.createdByUserId,
        createdByName: r.createdBy.fullName,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  });

  // Create
  app.post('/api/v1/quick-replies', async (request, reply) => {
    const user = request.user!;
    const validated = validatePayload(request.body, user.role);
    if (!validated.ok) return reply.status(400).send({ error: validated.error });
    const { shortcut, content, scope } = validated.value;

    // Conflict detection — does the caller already see a template with this shortcut?
    const conflict = await prisma.quickReply.findFirst({
      where: {
        orgId: user.orgId,
        shortcut,
        OR: [{ scope: 'org' }, { scope: 'user', createdByUserId: user.id }],
      },
      select: { id: true },
    });
    if (conflict) {
      return reply.status(409).send({ error: `Shortcut "${shortcut}" đã tồn tại` });
    }

    const created = await prisma.quickReply.create({
      data: {
        id: randomUUID(),
        orgId: user.orgId,
        createdByUserId: user.id,
        shortcut,
        content,
        scope,
      },
    });
    logger.info(`[quick-replies] User ${user.id} created ${created.id} (${shortcut}, ${scope})`);
    return reply.status(201).send(created);
  });

  // Update
  app.put<{ Params: { id: string } }>('/api/v1/quick-replies/:id', async (request, reply) => {
    const user = request.user!;
    const { id } = request.params;

    const existing = await prisma.quickReply.findFirst({
      where: { id, orgId: user.orgId },
    });
    if (!existing) return reply.status(404).send({ error: 'Tin mẫu không tồn tại' });

    if (!isPrivileged(user.role) && existing.createdByUserId !== user.id) {
      return reply.status(403).send({ error: 'Không thể sửa tin mẫu của người khác' });
    }

    const validated = validatePayload(request.body, user.role);
    if (!validated.ok) return reply.status(400).send({ error: validated.error });
    const { shortcut, content, scope } = validated.value;

    // Conflict — but ignore the row we're updating itself
    if (shortcut !== existing.shortcut) {
      const conflict = await prisma.quickReply.findFirst({
        where: {
          orgId: user.orgId,
          shortcut,
          NOT: { id },
          OR: [{ scope: 'org' }, { scope: 'user', createdByUserId: user.id }],
        },
        select: { id: true },
      });
      if (conflict) {
        return reply.status(409).send({ error: `Shortcut "${shortcut}" đã tồn tại` });
      }
    }

    const updated = await prisma.quickReply.update({
      where: { id },
      data: { shortcut, content, scope },
    });
    return updated;
  });

  // Delete
  app.delete<{ Params: { id: string } }>(
    '/api/v1/quick-replies/:id',
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      const existing = await prisma.quickReply.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, createdByUserId: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Tin mẫu không tồn tại' });

      if (!isPrivileged(user.role) && existing.createdByUserId !== user.id) {
        return reply.status(403).send({ error: 'Không thể xoá tin mẫu của người khác' });
      }

      await prisma.quickReply.delete({ where: { id } });
      return reply.status(204).send();
    },
  );
}
