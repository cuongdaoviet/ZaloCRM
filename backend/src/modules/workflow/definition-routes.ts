/**
 * Workflow definition CRUD routes — Feature 0037.
 *
 * BR-0008: only owners/admins can create/update/delete. Listing is
 * admin-only too in phase 1 since workflows are an admin-managed config
 * — members see executions per contact via Customer 360 (separate route).
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { validateWorkflowInput } from './workflow-helpers.js';

export async function workflowDefinitionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List — admins only (phase 1)
  app.get(
    '/api/v1/workflows',
    { preHandler: requireRole('owner', 'admin') },
    async (request) => {
      const user = request.user!;
      const workflows = await prisma.workflowDefinition.findMany({
        where: { orgId: user.orgId },
        include: { _count: { select: { executions: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return { workflows };
    },
  );

  // Detail
  app.get<{ Params: { id: string } }>(
    '/api/v1/workflows/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const wf = await prisma.workflowDefinition.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
      });
      if (!wf) return reply.status(404).send({ error: 'Không tồn tại' });
      return wf;
    },
  );

  // Create
  app.post(
    '/api/v1/workflows',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const validated = validateWorkflowInput(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });
      const v = validated.value;

      // Validate `assign_user` step userIds exist within the org. We do
      // this here (not in the helper) since it requires a DB lookup.
      for (const step of v.steps) {
        if (step.type === 'assign_user') {
          const target = await prisma.user.findFirst({
            where: { id: step.userId, orgId: user.orgId },
            select: { id: true },
          });
          if (!target) {
            return reply
              .status(400)
              .send({ error: `assign_user.userId không thuộc tổ chức: ${step.userId}` });
          }
        }
      }

      const wf = await prisma.workflowDefinition.create({
        data: {
          id: randomUUID(),
          orgId: user.orgId,
          name: v.name,
          description: v.description,
          isActive: v.isActive,
          trigger: v.trigger as unknown as object,
          steps: v.steps as unknown as object,
        },
      });
      logger.info(`[workflow] user ${user.id} created workflow ${wf.id}`);
      return reply.status(201).send(wf);
    },
  );

  // Update
  app.put<{ Params: { id: string } }>(
    '/api/v1/workflows/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const existing = await prisma.workflowDefinition.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tồn tại' });

      const validated = validateWorkflowInput(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });
      const v = validated.value;

      for (const step of v.steps) {
        if (step.type === 'assign_user') {
          const target = await prisma.user.findFirst({
            where: { id: step.userId, orgId: user.orgId },
            select: { id: true },
          });
          if (!target) {
            return reply
              .status(400)
              .send({ error: `assign_user.userId không thuộc tổ chức: ${step.userId}` });
          }
        }
      }

      const updated = await prisma.workflowDefinition.update({
        where: { id: request.params.id },
        data: {
          name: v.name,
          description: v.description,
          isActive: v.isActive,
          trigger: v.trigger as unknown as object,
          steps: v.steps as unknown as object,
        },
      });
      return updated;
    },
  );

  // Delete (cascade removes executions per schema FK)
  app.delete<{ Params: { id: string } }>(
    '/api/v1/workflows/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const existing = await prisma.workflowDefinition.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tồn tại' });

      await prisma.workflowDefinition.delete({ where: { id: existing.id } });
      return reply.status(204).send();
    },
  );
}
