/**
 * Webhook debug routes — feature 0014.
 *
 * Admin-only endpoints to inspect persisted delivery attempts and replay them.
 * Members are blocked at the route level.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { deliverAndPersist } from './webhook-service.js';
import crypto from 'node:crypto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function requireAdmin(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function webhookDebugRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List deliveries with pagination + optional status filter
  app.get('/api/v1/settings/webhook/deliveries', async (request, reply) => {
    const user = request.user!;
    if (!requireAdmin(user.role)) {
      return reply.status(403).send({ error: 'Chỉ admin được xem webhook log' });
    }

    const q = request.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q.page) || 1);
    const limitRaw = Number(q.limit) || DEFAULT_LIMIT;
    if (!Number.isFinite(limitRaw) || limitRaw < 1) {
      return reply.status(400).send({ error: 'limit phải là số dương' });
    }
    const limit = Math.min(limitRaw, MAX_LIMIT);

    const where: any = { orgId: user.orgId };
    if (q.status === 'success') {
      where.responseStatus = { gte: 200, lt: 300 };
    } else if (q.status === 'failed') {
      where.OR = [
        { responseStatus: { gte: 400 } },
        { responseStatus: null },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, event: true, url: true,
          responseStatus: true, durationMs: true,
          errorMessage: true, createdAt: true,
        },
      }),
      prisma.webhookDelivery.count({ where }),
    ]);

    return {
      deliveries: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  });

  // Detail (includes full payload + signature for debugging on the partner side)
  app.get<{ Params: { id: string } }>(
    '/api/v1/settings/webhook/deliveries/:id',
    async (request, reply) => {
      const user = request.user!;
      if (!requireAdmin(user.role)) {
        return reply.status(403).send({ error: 'Chỉ admin được xem webhook log' });
      }
      const row = await prisma.webhookDelivery.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
      });
      if (!row) return reply.status(404).send({ error: 'Không tồn tại' });
      return row;
    },
  );

  // Replay — re-send the same payload to the current webhook URL. Re-signs
  // with the current secret since that's what the partner is verifying against.
  app.post<{ Params: { id: string } }>(
    '/api/v1/settings/webhook/deliveries/:id/replay',
    async (request, reply) => {
      const user = request.user!;
      if (!requireAdmin(user.role)) {
        return reply.status(403).send({ error: 'Chỉ admin được replay webhook' });
      }

      const row = await prisma.webhookDelivery.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
      });
      if (!row) return reply.status(404).send({ error: 'Không tồn tại' });

      const [urlConfig, secretConfig] = await Promise.all([
        prisma.appSetting.findFirst({
          where: { orgId: user.orgId, settingKey: 'webhook_url' },
        }),
        prisma.appSetting.findFirst({
          where: { orgId: user.orgId, settingKey: 'webhook_secret' },
        }),
      ]);
      if (!urlConfig?.valuePlain) {
        return reply.status(400).send({ error: 'Webhook URL chưa được cấu hình' });
      }

      const signature = secretConfig?.valuePlain
        ? crypto.createHmac('sha256', secretConfig.valuePlain).update(row.payload).digest('hex')
        : null;

      const deliveryId = await deliverAndPersist({
        orgId: user.orgId,
        event: row.event,
        url: urlConfig.valuePlain,
        payload: row.payload,
        signature,
      });

      // Read back the new row to return its status to the caller
      const fresh = await prisma.webhookDelivery.findUnique({
        where: { id: deliveryId },
        select: { id: true, responseStatus: true, durationMs: true, errorMessage: true },
      });
      return fresh ?? { id: deliveryId };
    },
  );
}
