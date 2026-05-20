/**
 * appointment-parse-routes.ts — Pure compute endpoint for parsing appointment
 * intent out of free-form Vietnamese text. No DB writes, no FK lookups.
 *
 * Feature 0017.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { parseAppointmentFromText } from './appointment-parser.js';

const MAX_TEXT_LENGTH = 5000;

export async function appointmentParseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/v1/appointments/parse — parse free-form text ─────────────
  app.post('/api/v1/appointments/parse', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (request.body ?? {}) as { text?: unknown };
      if (typeof body.text !== 'string') {
        return reply.status(400).send({ error: 'text (string) is required' });
      }
      if (body.text.length > MAX_TEXT_LENGTH) {
        return reply.status(400).send({ error: `text too long (max ${MAX_TEXT_LENGTH} chars)` });
      }

      const parsed = parseAppointmentFromText(body.text);
      if (!parsed) return { result: null };
      return parsed;
    } catch (err) {
      logger.error('[appointment-parse] Error:', err);
      return reply.status(500).send({ error: 'Failed to parse appointment text' });
    }
  });
}
