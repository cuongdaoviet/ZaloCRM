/**
 * Aggregated usage stats for the Settings → AI Config page.
 * Reads from AiSuggestionLog only — content is never stored, so this is
 * privacy-safe by construction.
 *
 *   GET /api/v1/settings/ai-usage?from=ISO&to=ISO
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { getUsageAggregate } from './ai-suggestion-service.js';

interface QueryParams {
  from?: string;
  to?: string;
}

function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function aiUsageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get(
    '/api/v1/settings/ai-usage',
    { preHandler: requireRole('owner', 'admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const query = (request.query ?? {}) as QueryParams;
      const from = parseIsoDate(query.from);
      const to = parseIsoDate(query.to);
      try {
        return await getUsageAggregate(user.orgId, from, to);
      } catch (err) {
        logger.error('[ai-usage] aggregate failed:', err);
        return reply.status(500).send({ error: 'Failed to compute usage' });
      }
    },
  );
}
