/**
 * Workflow execution read routes — Feature 0037.
 *
 *  - `GET /api/v1/workflows/:id/executions` — admin: list executions of
 *    one workflow with pagination.
 *  - `GET /api/v1/contacts/:id/workflow-executions` — any org member
 *    with access to the contact: list executions touching this contact.
 *
 * Execution rows are read-only via these routes. Cancel/retry is phase 2.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';

export async function workflowExecutionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // List executions of a single workflow (admin-only)
  app.get<{ Params: { id: string }; Querystring: { page?: string; perPage?: string } }>(
    '/api/v1/workflows/:id/executions',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const wf = await prisma.workflowDefinition.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
        select: { id: true },
      });
      if (!wf) return reply.status(404).send({ error: 'Không tồn tại' });

      const page = Math.max(1, Number(request.query.page) || 1);
      const perPage = Math.min(100, Math.max(1, Number(request.query.perPage) || 20));
      const skip = (page - 1) * perPage;

      const [executions, total] = await Promise.all([
        prisma.workflowExecution.findMany({
          where: { workflowId: wf.id },
          include: {
            contact: { select: { id: true, fullName: true, zaloUid: true } },
          },
          orderBy: { startedAt: 'desc' },
          skip,
          take: perPage,
        }),
        prisma.workflowExecution.count({ where: { workflowId: wf.id } }),
      ]);
      return {
        executions,
        pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
      };
    },
  );

  // List executions for a single contact (any org member). Cross-org
  // isolation enforced via the contact's orgId.
  app.get<{ Params: { id: string } }>(
    '/api/v1/contacts/:id/workflow-executions',
    async (request, reply) => {
      const user = request.user!;
      const contact = await prisma.contact.findFirst({
        where: { id: request.params.id, orgId: user.orgId },
        select: { id: true },
      });
      if (!contact) return reply.status(404).send({ error: 'Không tồn tại' });

      const executions = await prisma.workflowExecution.findMany({
        where: { contactId: contact.id },
        include: {
          workflow: { select: { id: true, name: true } },
        },
        orderBy: { startedAt: 'desc' },
        take: 50,
      });
      return { executions };
    },
  );
}
