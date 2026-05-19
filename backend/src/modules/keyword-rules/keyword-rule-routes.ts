/**
 * Keyword rule CRUD routes — feature 0009.
 *
 * All members can list (so they know what auto-tagging is happening on
 * their conversations). Only owners/admins can create/update/delete.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { validateRuleInput } from './keyword-rule-helpers.js';

export async function keywordRuleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List (all members)
  app.get('/api/v1/keyword-rules', async (request) => {
    const user = request.user!;
    const rules = await prisma.keywordRule.findMany({
      where: { orgId: user.orgId },
      include: {
        assignToUser: { select: { id: true, fullName: true } },
        _count: { select: { triggers: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { rules };
  });

  // Create (admin/owner)
  app.post(
    '/api/v1/keyword-rules',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const validated = validateRuleInput(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });
      const v = validated.value;

      // Verify assignToUser exists in same org if provided
      if (v.assignToUserId) {
        const target = await prisma.user.findFirst({
          where: { id: v.assignToUserId, orgId: user.orgId },
          select: { id: true },
        });
        if (!target) {
          return reply.status(400).send({ error: 'assignToUserId không thuộc tổ chức' });
        }
      }

      const rule = await prisma.keywordRule.create({
        data: {
          id: randomUUID(),
          orgId: user.orgId,
          name: v.name,
          enabled: v.enabled,
          keywords: v.keywords,
          addTag: v.addTag,
          setStatus: v.setStatus,
          assignToUserId: v.assignToUserId,
        },
      });
      logger.info(`[keyword-rules] user ${user.id} created rule ${rule.id}`);
      return reply.status(201).send(rule);
    },
  );

  // Update (admin/owner)
  app.put<{ Params: { id: string } }>(
    '/api/v1/keyword-rules/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const existing = await prisma.keywordRule.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tồn tại' });

      const validated = validateRuleInput(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });
      const v = validated.value;

      if (v.assignToUserId) {
        const target = await prisma.user.findFirst({
          where: { id: v.assignToUserId, orgId: user.orgId },
          select: { id: true },
        });
        if (!target) {
          return reply.status(400).send({ error: 'assignToUserId không thuộc tổ chức' });
        }
      }

      const updated = await prisma.keywordRule.update({
        where: { id: request.params.id },
        data: {
          name: v.name,
          enabled: v.enabled,
          keywords: v.keywords,
          addTag: v.addTag,
          setStatus: v.setStatus,
          assignToUserId: v.assignToUserId,
        },
      });
      return updated;
    },
  );

  // Delete (admin/owner)
  app.delete<{ Params: { id: string } }>(
    '/api/v1/keyword-rules/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const existing = await prisma.keywordRule.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tồn tại' });

      await prisma.keywordRule.delete({ where: { id: existing.id } });
      return reply.status(204).send();
    },
  );
}
