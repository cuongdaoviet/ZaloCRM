/**
 * Friendship lifecycle routes — feature 0020.
 *
 * Five endpoints:
 *   POST   /api/v1/contacts/:id/friendship           — enqueue (single)
 *   POST   /api/v1/friendship-attempts/bulk          — enqueue (bulk, partial-OK)
 *   GET    /api/v1/friendship-attempts               — list w/ filters
 *   GET    /api/v1/friendship-attempts/:id           — detail
 *   POST   /api/v1/friendship-attempts/:id/cancel    — cancel queued/looking_up
 *
 * All routes require auth + org-scoped. Members only see their own; owners
 * and admins see the whole org (BR-0003).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import {
  bulkEnqueue,
  cancelAttempt,
  enqueueAttempt,
} from './friendship-service.js';

const LIST_PAGE_DEFAULT = 20;
const LIST_PAGE_MAX = 100;

const VALID_STATES = new Set([
  'queued', 'looking_up', 'sent', 'accepted',
  'declined', 'timeout', 'error', 'cancelled',
]);

export async function friendshipRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/v1/contacts/:id/friendship — single enqueue ─────────────────
  app.post<{ Params: { id: string }; Body: { zaloAccountId?: string; message?: string | null } }>(
    '/api/v1/contacts/:id/friendship',
    async (request, reply) => {
      const user = request.user!;
      const body = request.body ?? {};
      const zaloAccountId = typeof body.zaloAccountId === 'string' ? body.zaloAccountId : '';
      if (!zaloAccountId) {
        return reply.status(400).send({ error: 'Thiếu zaloAccountId' });
      }
      const result = await enqueueAttempt({
        orgId: user.orgId,
        contactId: request.params.id,
        zaloAccountId,
        message: body.message ?? null,
        userId: user.id,
        userRole: user.role,
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error, code: result.code });
      }
      return reply.status(201).send(result.attempt);
    },
  );

  // ── POST /api/v1/friendship-attempts/bulk ─────────────────────────────────
  app.post<{ Body: { zaloAccountId?: string; contactIds?: string[]; message?: string | null } }>(
    '/api/v1/friendship-attempts/bulk',
    async (request, reply) => {
      const user = request.user!;
      const body = request.body ?? {};
      const zaloAccountId = typeof body.zaloAccountId === 'string' ? body.zaloAccountId : '';
      if (!zaloAccountId) {
        return reply.status(400).send({ error: 'Thiếu zaloAccountId' });
      }
      const contactIds = Array.isArray(body.contactIds) ? body.contactIds.filter((c) => typeof c === 'string') : [];
      if (contactIds.length === 0) {
        return reply.status(400).send({ error: 'contactIds phải là mảng không rỗng' });
      }
      const result = await bulkEnqueue({
        orgId: user.orgId,
        zaloAccountId,
        contactIds,
        message: body.message ?? null,
        userId: user.id,
        userRole: user.role,
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error, code: result.code });
      }
      return reply.status(201).send(result.result);
    },
  );

  // ── GET /api/v1/friendship-attempts ───────────────────────────────────────
  app.get('/api/v1/friendship-attempts', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const q = request.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = { orgId: user.orgId };

    // state (CSV)
    if (q.state) {
      const states = q.state.split(',').map((s) => s.trim()).filter((s) => VALID_STATES.has(s));
      if (states.length > 0) where.state = { in: states };
    }
    if (q.zaloAccountId) where.zaloAccountId = q.zaloAccountId;
    if (q.contactId) where.contactId = q.contactId;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      if (q.from) {
        const d = new Date(q.from);
        if (!Number.isNaN(d.getTime())) range.gte = d;
      }
      if (q.to) {
        const d = new Date(q.to);
        if (!Number.isNaN(d.getTime())) range.lte = d;
      }
      if (Object.keys(range).length > 0) where.queuedAt = range;
    }
    // BR-0003 — member sees only their own
    if (user.role === 'member') where.createdByUserId = user.id;

    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(Number(q.limit) || LIST_PAGE_DEFAULT, LIST_PAGE_MAX);

    const [rows, total] = await Promise.all([
      prisma.friendshipAttempt.findMany({
        where: where as never,
        include: {
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true } },
          zaloAccount: { select: { id: true, displayName: true } },
          createdBy: { select: { id: true, fullName: true } },
        },
        orderBy: { queuedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.friendshipAttempt.count({ where: where as never }),
    ]);

    return reply.send({
      attempts: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  });

  // ── GET /api/v1/friendship-attempts/:id ───────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/friendship-attempts/:id',
    async (request, reply) => {
      const user = request.user!;
      const where: Record<string, unknown> = { id: request.params.id, orgId: user.orgId };
      if (user.role === 'member') where.createdByUserId = user.id;
      const attempt = await prisma.friendshipAttempt.findFirst({
        where: where as never,
        include: {
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true } },
          zaloAccount: { select: { id: true, displayName: true } },
          createdBy: { select: { id: true, fullName: true } },
        },
      });
      if (!attempt) return reply.status(404).send({ error: 'Không tồn tại' });
      return reply.send(attempt);
    },
  );

  // ── POST /api/v1/friendship-attempts/:id/cancel ───────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/friendship-attempts/:id/cancel',
    async (request, reply) => {
      const user = request.user!;
      const result = await cancelAttempt(user.orgId, request.params.id, {
        id: user.id,
        role: user.role,
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error, code: result.code });
      }
      return reply.send(result.attempt);
    },
  );
}
