/**
 * Pinned conversations — feature 0015. Per-org "pinned to top" flag for a
 * conversation. Every user in the org who has access to the underlying Zalo
 * account sees the same pinned state (pins are NOT per-user).
 *
 * - POST /api/v1/conversations/:id/pin    — requires `chat` access (idempotent)
 * - DELETE /api/v1/conversations/:id/pin  — requires `chat` access (idempotent)
 * - GET /api/v1/conversations/pinned      — auth only; members are filtered
 *   to pinned conversations on accounts they have read access to.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { logger } from '../../shared/utils/logger.js';

export async function pinConversationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── List pinned conversations for the caller's org ─────────────────────────
  // Placed BEFORE the /:id route family so the literal `pinned` segment doesn't
  // get parsed as an `:id` param. Fastify routes the more specific path first
  // anyway, but ordering keeps intent clear.
  app.get('/api/v1/conversations/pinned', async (request, reply) => {
    const user = request.user!;

    // Members are filtered to Zalo accounts they have ACL on. Owners/admins
    // see every pin in their org.
    const where: { orgId: string; zaloAccountId?: { in: string[] } } = {
      orgId: user.orgId,
    };
    if (user.role === 'member') {
      const accessible = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      where.zaloAccountId = { in: accessible.map((a) => a.zaloAccountId) };
    }

    const pins = await prisma.pinnedConversation.findMany({
      where,
      orderBy: { pinnedAt: 'desc' },
      include: {
        conversation: {
          include: {
            contact: {
              select: { id: true, fullName: true, phone: true, avatarUrl: true, zaloUid: true },
            },
            zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
            messages: {
              take: 1,
              orderBy: { sentAt: 'desc' },
              select: {
                content: true,
                contentType: true,
                senderType: true,
                sentAt: true,
                isDeleted: true,
              },
            },
          },
        },
      },
    });

    // Flatten the response so the frontend gets a Conversation-shaped object
    // with `pinnedAt` attached — matching the list-conversations endpoint
    // shape so the FE can render both lists with the same component.
    const conversations = pins.map((pin) => ({
      ...pin.conversation,
      pinnedAt: pin.pinnedAt,
    }));

    return reply.send({ conversations });
  });

  // ── Pin a conversation ─────────────────────────────────────────────────────
  // Idempotent: if the conversation is already pinned, returns 200 with the
  // existing row instead of failing on the unique constraint.
  app.post<{ Params: { id: string } }>(
    '/api/v1/conversations/:id/pin',
    { preHandler: requireZaloAccess('chat') },
    async (request, reply) => {
      const user = request.user!;
      const conv = await prisma.conversation.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
        select: { id: true, zaloAccountId: true },
      });
      if (!conv) return reply.status(404).send({ error: 'Không tồn tại' });

      const existing = await prisma.pinnedConversation.findUnique({
        where: { conversationId: conv.id },
      });
      if (existing) {
        return reply.status(200).send(existing);
      }

      const pin = await prisma.pinnedConversation.create({
        data: {
          id: randomUUID(),
          orgId: user.orgId,
          zaloAccountId: conv.zaloAccountId,
          conversationId: conv.id,
        },
      });
      logger.info(`[pinned-conversations] user ${user.id} pinned ${conv.id}`);
      return reply.status(201).send(pin);
    },
  );

  // ── Unpin a conversation ───────────────────────────────────────────────────
  // Idempotent: returns 204 whether or not the row existed.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/conversations/:id/pin',
    { preHandler: requireZaloAccess('chat') },
    async (request, reply) => {
      const user = request.user!;
      const conv = await prisma.conversation.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
        select: { id: true },
      });
      if (!conv) return reply.status(404).send({ error: 'Không tồn tại' });

      // deleteMany never throws on "not found" — perfect for idempotent DELETE
      await prisma.pinnedConversation.deleteMany({
        where: { conversationId: conv.id },
      });
      return reply.status(204).send();
    },
  );
}
