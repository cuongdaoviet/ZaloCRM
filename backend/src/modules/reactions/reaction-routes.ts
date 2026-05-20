/**
 * Reaction routes — feature 0021.
 *
 * Three endpoints:
 *   POST   /api/v1/messages/:id/reactions     — add or toggle a reaction
 *   DELETE /api/v1/messages/:id/reactions     — remove caller's reaction
 *   GET    /api/v1/messages/:id/reactions     — list reactions on a message
 *
 * ACL: the standard `requireZaloAccess` middleware reads `params.id` /
 * `params.zaloAccountId` and looks up Zalo-account access. Our route param
 * is a MESSAGE id, so we resolve message → conversation → zaloAccount
 * inline before calling the middleware-equivalent permission check. This
 * mirrors the contact-overview endpoint pattern.
 *
 * POST / DELETE require `chat` permission (the user is causing an outbound
 * `addReaction` call to Zalo). GET requires `read`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import type { Server } from 'socket.io';
import {
  addOrToggleReaction,
  listReactions,
  removeReaction,
  type ReactionCaller,
} from './reaction-service.js';

type Permission = 'read' | 'chat' | 'admin';
const PERMISSION_LEVEL: Record<Permission, number> = { read: 1, chat: 2, admin: 3 };

/**
 * Resolve message → Zalo account + verify the caller has ≥ `min` permission.
 * Returns `{ ok: true, zaloAccountId, conversationId }` on success, or a
 * Fastify-style error tuple. Cross-org → 404 (existence not leaked).
 */
async function resolveAccess(
  messageId: string,
  user: { id: string; orgId: string; role: string },
  min: Permission,
): Promise<
  | { ok: true; zaloAccountId: string; conversationId: string }
  | { ok: false; status: number; body: { error: string } }
> {
  const msg = await prisma.message.findFirst({
    where: { id: messageId, conversation: { orgId: user.orgId } },
    select: { conversationId: true, conversation: { select: { zaloAccountId: true } } },
  });
  if (!msg || !msg.conversation) {
    return { ok: false, status: 404, body: { error: 'Tin nhắn không tồn tại' } };
  }
  const zaloAccountId = msg.conversation.zaloAccountId;

  // Owner / admin bypass the per-account ACL.
  if (user.role === 'owner' || user.role === 'admin') {
    return { ok: true, zaloAccountId, conversationId: msg.conversationId };
  }
  const access = await prisma.zaloAccountAccess.findFirst({
    where: { zaloAccountId, userId: user.id },
    select: { permission: true },
  });
  if (!access) {
    return { ok: false, status: 403, body: { error: 'Không có quyền truy cập tài khoản Zalo này' } };
  }
  const level = PERMISSION_LEVEL[access.permission as Permission] ?? 0;
  if (level < PERMISSION_LEVEL[min]) {
    return { ok: false, status: 403, body: { error: 'Không đủ quyền' } };
  }
  return { ok: true, zaloAccountId, conversationId: msg.conversationId };
}

/** Hydrate caller-shaped object for the service layer (needs fullName for `reactorName`). */
async function loadCaller(userId: string, orgId: string): Promise<ReactionCaller | null> {
  const row = await prisma.user.findFirst({
    where: { id: userId, orgId },
    select: { id: true, orgId: true, fullName: true },
  });
  return row;
}

export async function reactionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/v1/messages/:id/reactions ─────────────────────────────────
  app.post<{ Params: { id: string }; Body: { emoji?: string } }>(
    '/api/v1/messages/:id/reactions',
    async (request: FastifyRequest<{ Params: { id: string }; Body: { emoji?: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      const messageId = request.params.id;
      const emoji = (request.body?.emoji ?? '').toString();

      const access = await resolveAccess(messageId, user, 'chat');
      if (!access.ok) return reply.status(access.status).send(access.body);

      const caller = await loadCaller(user.id, user.orgId);
      if (!caller) return reply.status(401).send({ error: 'Unauthorized' });

      const result = await addOrToggleReaction({ messageId, emoji, user: caller });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error, code: result.code });
      }

      const io = (app as unknown as { io?: Server }).io;
      if (result.kind === 'toggled_off') {
        // Broadcast removal — FE clears the chip for this (messageId, reactorId).
        io?.emit('chat:reaction', {
          accountId: access.zaloAccountId,
          conversationId: access.conversationId,
          messageId,
          reaction: null,
          // Help FE locate WHICH row was removed (without needing GET round-trip)
          removed: { reactorSource: 'crm', reactorId: caller.id },
        });
        return reply.status(200).send({ toggledOff: true, messageId, emoji: result.emoji });
      }
      io?.emit('chat:reaction', {
        accountId: access.zaloAccountId,
        conversationId: access.conversationId,
        messageId,
        reaction: result.reaction,
      });
      return reply.status(201).send(result.reaction);
    },
  );

  // ── DELETE /api/v1/messages/:id/reactions ───────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/messages/:id/reactions',
    async (request, reply) => {
      const user = request.user!;
      const messageId = request.params.id;

      const access = await resolveAccess(messageId, user, 'chat');
      if (!access.ok) return reply.status(access.status).send(access.body);

      const caller = await loadCaller(user.id, user.orgId);
      if (!caller) return reply.status(401).send({ error: 'Unauthorized' });

      const result = await removeReaction({ messageId, user: caller });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error, code: result.code });
      }
      const io = (app as unknown as { io?: Server }).io;
      io?.emit('chat:reaction', {
        accountId: access.zaloAccountId,
        conversationId: access.conversationId,
        messageId,
        reaction: null,
        removed: { reactorSource: 'crm', reactorId: caller.id },
      });
      return reply.status(204).send();
    },
  );

  // ── GET /api/v1/messages/:id/reactions ──────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/messages/:id/reactions',
    async (request, reply) => {
      const user = request.user!;
      const messageId = request.params.id;

      const access = await resolveAccess(messageId, user, 'read');
      if (!access.ok) return reply.status(access.status).send(access.body);

      const caller = await loadCaller(user.id, user.orgId);
      if (!caller) return reply.status(401).send({ error: 'Unauthorized' });

      const result = await listReactions({ messageId, user: caller });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error, code: result.code });
      }
      return reply.send({ reactions: result.reactions });
    },
  );

  logger.debug('[reactions] routes registered');
}
