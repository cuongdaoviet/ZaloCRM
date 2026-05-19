/**
 * Campaign CRUD + lifecycle routes — feature 0008.
 *
 * Permission: only owner/admin can create / start / pause / resume / cancel
 * (members can list their own and view detail). Cross-org access blocked
 * by always filtering on req.user.orgId.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import {
  validateCampaignInput,
  buildContactWhere,
  canTransition,
} from './campaign-helpers.js';
import { logActivityAsync } from '../activity/activity-service.js';

const TARGETS_PAGE_DEFAULT = 50;
const TARGETS_PAGE_MAX = 200;

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List campaigns (members see their own; admins see all in org)
  app.get('/api/v1/campaigns', async (request) => {
    const user = request.user!;
    const q = request.query as Record<string, string | undefined>;
    const status = q.status;
    const limit = Math.min(Number(q.limit) || 20, 100);

    const where: any = { orgId: user.orgId, isDeleted: false };
    if (status) where.status = status;
    if (user.role === 'member') where.createdByUserId = user.id;

    const rows = await prisma.campaign.findMany({
      where,
      include: {
        createdBy: { select: { id: true, fullName: true } },
        zaloAccount: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return { campaigns: rows };
  });

  // Detail
  app.get<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id',
    async (request, reply) => {
      const user = request.user!;
      const campaign = await prisma.campaign.findFirst({
        where: { id: request.params.id, orgId: user.orgId, isDeleted: false },
        include: {
          createdBy: { select: { id: true, fullName: true } },
          zaloAccount: { select: { id: true, displayName: true } },
        },
      });
      if (!campaign) return reply.status(404).send({ error: 'Không tồn tại' });
      return campaign;
    },
  );

  // Paginated targets
  app.get<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id/targets',
    async (request, reply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;

      const exists = await prisma.campaign.findFirst({
        where: { id: request.params.id, orgId: user.orgId, isDeleted: false },
        select: { id: true },
      });
      if (!exists) return reply.status(404).send({ error: 'Không tồn tại' });

      const where: any = { campaignId: request.params.id };
      if (q.status) where.status = q.status;

      const page = Math.max(1, Number(q.page) || 1);
      const limit = Math.min(Number(q.limit) || TARGETS_PAGE_DEFAULT, TARGETS_PAGE_MAX);

      const [rows, total] = await Promise.all([
        prisma.campaignTarget.findMany({
          where,
          include: {
            contact: {
              select: { id: true, fullName: true, phone: true, zaloUid: true, avatarUrl: true },
            },
          },
          orderBy: { createdAt: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.campaignTarget.count({ where }),
      ]);
      return { targets: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
    },
  );

  // Create — materializes targets from the filter snapshot. Default status='draft'.
  app.post(
    '/api/v1/campaigns',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const validated = validateCampaignInput(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });
      const v = validated.value;

      // Verify Zalo account belongs to caller's org
      const account = await prisma.zaloAccount.findFirst({
        where: { id: v.zaloAccountId, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Zalo account không tồn tại' });
      }

      // Materialize target list from the filter
      const contactWhere = buildContactWhere(user.orgId, v.filter);
      const contacts = await prisma.contact.findMany({
        where: contactWhere,
        select: { id: true },
      });
      if (contacts.length === 0) {
        return reply.status(400).send({ error: 'Không có khách hàng nào khớp filter' });
      }

      const campaignId = randomUUID();
      const campaign = await prisma.campaign.create({
        data: {
          id: campaignId,
          orgId: user.orgId,
          createdByUserId: user.id,
          zaloAccountId: v.zaloAccountId,
          name: v.name,
          message: v.message,
          status: 'draft',
          scheduledAt: v.scheduledAt,
          filterSnapshot: v.filter as any,
          totalTargets: contacts.length,
        },
      });
      await prisma.campaignTarget.createMany({
        data: contacts.map((c) => ({
          id: randomUUID(),
          campaignId,
          contactId: c.id,
          status: 'pending',
        })),
      });

      logger.info(
        `[campaigns] user ${user.id} created ${campaignId} with ${contacts.length} targets`,
      );
      logActivityAsync({
        orgId: user.orgId,
        userId: user.id,
        action: 'campaign.created',
        entityType: 'campaign',
        entityId: campaignId,
        details: { name: v.name, totalTargets: contacts.length, scheduledAt: v.scheduledAt },
      });
      return reply.status(201).send(campaign);
    },
  );

  // Lifecycle transitions
  app.post<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id/start',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      return transitionCampaign(request.params.id, request.user!.orgId, request.user!.id, 'start', reply);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id/pause',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      return transitionCampaign(request.params.id, request.user!.orgId, request.user!.id, 'pause', reply);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id/resume',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      return transitionCampaign(request.params.id, request.user!.orgId, request.user!.id, 'resume', reply);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id/cancel',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      return transitionCampaign(request.params.id, request.user!.orgId, request.user!.id, 'cancel', reply);
    },
  );

  // Retry failed targets
  app.post<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id/retry-failed',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const campaign = await prisma.campaign.findFirst({
        where: { id: request.params.id, orgId: user.orgId, isDeleted: false },
      });
      if (!campaign) return reply.status(404).send({ error: 'Không tồn tại' });

      const failed = await prisma.campaignTarget.findMany({
        where: { campaignId: campaign.id, status: 'failed' },
        select: { id: true },
      });
      if (failed.length === 0) {
        return reply.status(400).send({ error: 'Không có target failed nào để retry' });
      }

      await prisma.$transaction([
        prisma.campaignTarget.updateMany({
          where: { id: { in: failed.map((f) => f.id) } },
          data: { status: 'pending', errorMessage: null },
        }),
        prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            status: 'running',
            failedCount: { decrement: failed.length },
            startedAt: campaign.startedAt ?? new Date(),
            completedAt: null,
          },
        }),
      ]);

      logger.info(
        `[campaigns] user ${user.id} retried ${failed.length} failed targets on ${campaign.id}`,
      );
      return { success: true, retriedCount: failed.length };
    },
  );

  // Soft delete (only completed / cancelled)
  app.delete<{ Params: { id: string } }>(
    '/api/v1/campaigns/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const campaign = await prisma.campaign.findFirst({
        where: { id: request.params.id, orgId: user.orgId, isDeleted: false },
      });
      if (!campaign) return reply.status(404).send({ error: 'Không tồn tại' });
      if (campaign.status !== 'completed' && campaign.status !== 'cancelled') {
        return reply.status(400).send({
          error: 'Chỉ có thể xoá campaign đã completed hoặc cancelled',
        });
      }
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { isDeleted: true },
      });
      return reply.status(204).send();
    },
  );
}

/**
 * Apply a lifecycle transition: start/pause/resume/cancel. Centralizes the
 * status-machine check via canTransition() and returns the updated row.
 */
async function transitionCampaign(
  campaignId: string,
  orgId: string,
  userId: string,
  action: 'start' | 'pause' | 'resume' | 'cancel',
  reply: any,
): Promise<unknown> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, orgId, isDeleted: false },
  });
  if (!campaign) return reply.status(404).send({ error: 'Không tồn tại' });

  // Determine target status
  let newStatus: string;
  if (action === 'start') {
    // draft → scheduled (if scheduledAt set) or running (immediate)
    newStatus = campaign.scheduledAt ? 'scheduled' : 'running';
  } else if (action === 'pause') {
    newStatus = 'paused';
  } else if (action === 'resume') {
    newStatus = 'running';
  } else {
    newStatus = 'cancelled';
  }

  if (!canTransition(campaign.status, newStatus)) {
    return reply.status(400).send({
      error: `Không thể chuyển từ ${campaign.status} sang ${newStatus}`,
    });
  }

  const updated = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      status: newStatus,
      startedAt:
        newStatus === 'running' && !campaign.startedAt ? new Date() : campaign.startedAt,
      completedAt: newStatus === 'cancelled' ? new Date() : campaign.completedAt,
    },
  });
  logger.info(
    `[campaigns] ${campaignId} transition ${campaign.status} → ${newStatus} via ${action}`,
  );
  logActivityAsync({
    orgId,
    userId,
    action: `campaign.${action === 'start' ? 'started' : action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : 'resumed'}`,
    entityType: 'campaign',
    entityId: campaignId,
    details: { from: campaign.status, to: newStatus, name: campaign.name },
  });
  return updated;
}
