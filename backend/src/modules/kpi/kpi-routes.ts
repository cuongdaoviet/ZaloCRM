/**
 * KPI endpoints — feature 0007.
 *
 *   GET /api/v1/kpi/summary       — totals + previous-period deltas
 *   GET /api/v1/kpi/leaderboard   — top-N users by metric
 *
 * Both require owner/admin; members get 403.
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import {
  resolveDateRange,
  percentDelta,
  VALID_METRICS,
} from './kpi-helpers.js';
import { getMetricsForRange, getLeaderboard, type LeaderboardMetric } from './kpi-service.js';

export async function kpiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get(
    '/api/v1/kpi/summary',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      const resolved = resolveDateRange(
        { period: q.period, from: q.from, to: q.to },
        new Date(),
      );
      if (!resolved.ok) return reply.status(400).send({ error: resolved.error });
      const { from, to, label, previous } = resolved.value;

      const [current, prev] = await Promise.all([
        getMetricsForRange(user.orgId, from, to),
        getMetricsForRange(user.orgId, previous.from, previous.to),
      ]);

      const summary: Record<string, { current: number; previous: number; delta: number | null }> = {};
      for (const key of Object.keys(current) as (keyof typeof current)[]) {
        summary[key] = {
          current: current[key],
          previous: prev[key],
          delta: percentDelta(current[key], prev[key]),
        };
      }

      return {
        range: { from: from.toISOString(), to: to.toISOString(), label },
        previousRange: {
          from: previous.from.toISOString(),
          to: previous.to.toISOString(),
        },
        summary,
      };
    },
  );

  app.get(
    '/api/v1/kpi/leaderboard',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;

      const metric = q.metric ?? 'revenue';
      if (!VALID_METRICS.has(metric)) {
        return reply.status(400).send({ error: `metric không hợp lệ: ${metric}` });
      }

      const limitRaw = q.limit ? Number(q.limit) : 10;
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50) {
        return reply.status(400).send({ error: 'limit phải là 1-50' });
      }

      const resolved = resolveDateRange(
        { period: q.period, from: q.from, to: q.to },
        new Date(),
      );
      if (!resolved.ok) return reply.status(400).send({ error: resolved.error });
      const { from, to } = resolved.value;

      const rows = await getLeaderboard(
        user.orgId,
        metric as LeaderboardMetric,
        from,
        to,
        limitRaw,
      );

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        metric,
        rows,
      };
    },
  );
}
