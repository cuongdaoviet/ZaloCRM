/**
 * Conversation notes — feature 0010. Internal sales notes pinned to a
 * conversation. Customers never see these.
 *
 * - GET requires read access on the underlying Zalo account
 * - POST requires chat access (creating notes is an authoring action)
 * - PUT / DELETE: author OR org admin/owner
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { logActivityAsync } from '../activity/activity-service.js';

const CONTENT_MAX = 2000;

function validateContent(body: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body không hợp lệ' };
  }
  const content = typeof (body as any).content === 'string' ? (body as any).content.trim() : '';
  if (content.length < 1 || content.length > CONTENT_MAX) {
    return { ok: false, error: `content phải dài 1-${CONTENT_MAX} ký tự` };
  }
  return { ok: true, value: content };
}

function isPrivileged(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function conversationNoteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List notes for a conversation
  app.get<{ Params: { id: string } }>(
    '/api/v1/conversations/:id/notes',
    { preHandler: requireZaloAccess('read') },
    async (request, reply) => {
      const user = request.user!;
      const conv = await prisma.conversation.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
        select: { id: true },
      });
      if (!conv) return reply.status(404).send({ error: 'Không tồn tại' });

      const notes = await prisma.conversationNote.findMany({
        where: { conversationId: conv.id },
        include: { author: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return { notes };
    },
  );

  // Create note
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    '/api/v1/conversations/:id/notes',
    { preHandler: requireZaloAccess('chat') },
    async (request, reply) => {
      const user = request.user!;
      const conv = await prisma.conversation.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
        select: { id: true },
      });
      if (!conv) return reply.status(404).send({ error: 'Không tồn tại' });

      const validated = validateContent(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });

      const note = await prisma.conversationNote.create({
        data: {
          id: randomUUID(),
          conversationId: conv.id,
          authorId: user.id,
          content: validated.value,
        },
        include: { author: { select: { id: true, fullName: true } } },
      });
      logger.info(`[conversation-notes] user ${user.id} created note on ${conv.id}`);
      logActivityAsync({
        orgId: user.orgId,
        userId: user.id,
        action: 'note.created',
        entityType: 'conversation_note',
        entityId: note.id,
        details: { conversationId: conv.id },
      });
      return reply.status(201).send(note);
    },
  );

  // Update — only author or admin/owner
  app.put<{ Params: { noteId: string }; Body: { content: string } }>(
    '/api/v1/conversations/notes/:noteId',
    async (request, reply) => {
      const user = request.user!;
      const note = await prisma.conversationNote.findFirst({
        where: { id: request.params.noteId },
        include: { conversation: { select: { orgId: true } } },
      });
      if (!note || note.conversation.orgId !== user.orgId) {
        return reply.status(404).send({ error: 'Không tồn tại' });
      }
      if (note.authorId !== user.id && !isPrivileged(user.role)) {
        return reply.status(403).send({ error: 'Không có quyền sửa note này' });
      }

      const validated = validateContent(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });

      const updated = await prisma.conversationNote.update({
        where: { id: note.id },
        data: { content: validated.value },
        include: { author: { select: { id: true, fullName: true } } },
      });
      logActivityAsync({
        orgId: user.orgId,
        userId: user.id,
        action: 'note.updated',
        entityType: 'conversation_note',
        entityId: note.id,
        details: { conversationId: note.conversationId },
      });
      return updated;
    },
  );

  // Delete — same gating
  app.delete<{ Params: { noteId: string } }>(
    '/api/v1/conversations/notes/:noteId',
    async (request, reply) => {
      const user = request.user!;
      const note = await prisma.conversationNote.findFirst({
        where: { id: request.params.noteId },
        include: { conversation: { select: { orgId: true } } },
      });
      if (!note || note.conversation.orgId !== user.orgId) {
        return reply.status(404).send({ error: 'Không tồn tại' });
      }
      if (note.authorId !== user.id && !isPrivileged(user.role)) {
        return reply.status(403).send({ error: 'Không có quyền xoá note này' });
      }
      await prisma.conversationNote.delete({ where: { id: note.id } });
      logActivityAsync({
        orgId: user.orgId,
        userId: user.id,
        action: 'note.deleted',
        entityType: 'conversation_note',
        entityId: note.id,
        details: { conversationId: note.conversationId },
      });
      return reply.status(204).send();
    },
  );
}
