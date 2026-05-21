/**
 * Analytics endpoints — feature 0041.
 *
 *   GET /api/v1/analytics/funnel             — funnel + next-stage conversion
 *   GET /api/v1/analytics/team-performance   — per-rep response time + counts
 *
 * Both require owner/admin (BR-0006). Cross-org isolation is enforced by
 * filtering every query on `request.user.orgId`.
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { parseDateRange } from './analytics-helpers.js';
import { getFunnel, getTeamPerformance } from './analytics-service.js';

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get(
    '/api/v1/analytics/funnel',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;

      const resolved = parseDateRange(
        { dateFrom: q.dateFrom, dateTo: q.dateTo },
        new Date(),
      );
      if (!resolved.ok) return reply.status(400).send({ error: resolved.error });
      const { from, to } = resolved.value;

      const result = await getFunnel({
        orgId: user.orgId,
        from,
        to,
        teamId: q.teamId,
        assignedUserId: q.assignedUserId,
      });

      return {
        ...result,
        period: { dateFrom: from.toISOString(), dateTo: to.toISOString() },
      };
    },
  );

  app.get(
    '/api/v1/analytics/team-performance',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;

      const resolved = parseDateRange(
        { dateFrom: q.dateFrom, dateTo: q.dateTo },
        new Date(),
      );
      if (!resolved.ok) return reply.status(400).send({ error: resolved.error });
      const { from, to } = resolved.value;

      const result = await getTeamPerformance({
        orgId: user.orgId,
        from,
        to,
        teamId: q.teamId,
      });

      return {
        ...result,
        period: { dateFrom: from.toISOString(), dateTo: to.toISOString() },
      };
    },
  );
}
