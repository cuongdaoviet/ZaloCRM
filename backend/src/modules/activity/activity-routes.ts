/**
 * Activity log read API — feature 0012.
 *
 * Permission model:
 * - Owner / admin see everyone's activity in their org
 * - Member sees only their own activity (we force userId=req.user.id)
 *
 * No write endpoints — activity is immutable. Internal services call
 * logActivity() directly.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/activity', async (request, reply) => {
    const user = request.user!;
    const q = request.query as Record<string, string | undefined>;

    // Validate pagination
    const page = Math.max(1, Number(q.page) || 1);
    const limitRaw = Number(q.limit) || DEFAULT_LIMIT;
    if (!Number.isFinite(limitRaw) || limitRaw < 1) {
      return reply.status(400).send({ error: 'limit phải là số dương' });
    }
    const limit = Math.min(limitRaw, MAX_LIMIT);

    // Validate date range
    let from: Date | null = null;
    let to: Date | null = null;
    if (q.from) {
      from = new Date(q.from);
      if (Number.isNaN(from.getTime())) {
        return reply.status(400).send({ error: 'from không phải ISO date hợp lệ' });
      }
    }
    if (q.to) {
      to = new Date(q.to);
      if (Number.isNaN(to.getTime())) {
        return reply.status(400).send({ error: 'to không phải ISO date hợp lệ' });
      }
    }
    if (from && to && from.getTime() > to.getTime()) {
      return reply.status(400).send({ error: 'from phải <= to' });
    }

    const where: any = { orgId: user.orgId };

    // Permission: members are forced to their own activity regardless of
    // what `userId` they pass. Admin/owner can filter by any user
    if (user.role === 'member') {
      where.userId = user.id;
    } else if (q.userId) {
      where.userId = q.userId;
    }

    if (q.entityType) where.entityType = q.entityType;
    if (q.action) where.action = q.action;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const [activities, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        include: { user: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.activityLog.count({ where }),
    ]);

    return {
      activities,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  });
}
