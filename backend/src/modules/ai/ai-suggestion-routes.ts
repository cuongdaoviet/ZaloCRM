/**
 * POST /api/v1/conversations/:id/ai-suggestions — Feature 0036.
 *
 * Auth: requires `chat` permission on the Zalo account that owns the
 * conversation (BR-0003).
 *
 * Error translation:
 *   ai_disabled          → 412
 *   no_context | no_inbound → 400
 *   rate_limit_org | rate_limit_user → 429 + Retry-After
 *   provider_401         → 502 (key bad; auto-disabled in service)
 *   provider_5xx | provider_timeout | provider_other → 503
 *   unknown_provider | provider_unconfigured → 412
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import {
  generateSuggestions,
  AiServiceError,
} from './ai-suggestion-service.js';

interface Params {
  id: string;
}

function mapErrorToHttp(err: AiServiceError): { status: number; body: Record<string, unknown>; headers?: Record<string, string> } {
  switch (err.code) {
    case 'ai_disabled':
    case 'provider_unconfigured':
    case 'unknown_provider':
      return { status: 412, body: { error: err.code, message: err.message } };
    case 'no_context':
    case 'no_inbound':
      return { status: 400, body: { error: err.code, message: err.message } };
    case 'rate_limit_org':
    case 'rate_limit_user':
      return {
        status: 429,
        body: { error: err.code, message: err.message, retryAfter: err.retryAfterSec },
        headers: err.retryAfterSec ? { 'retry-after': String(err.retryAfterSec) } : undefined,
      };
    case 'provider_401':
      return { status: 502, body: { error: err.code, message: 'Provider rejected the API key' } };
    case 'provider_5xx':
    case 'provider_timeout':
    case 'provider_other':
      return { status: 503, body: { error: err.code, message: 'AI provider unavailable' } };
    default:
      return { status: 500, body: { error: 'unknown', message: err.message } };
  }
}

export async function aiSuggestionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.post<{ Params: Params }>(
    '/api/v1/conversations/:id/ai-suggestions',
    { preHandler: requireZaloAccess('chat') },
    async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params;

      try {
        const result = await generateSuggestions({
          orgId: user.orgId,
          userId: user.id,
          conversationId: id,
        });
        return result;
      } catch (err) {
        if (err instanceof AiServiceError) {
          const mapped = mapErrorToHttp(err);
          if (mapped.headers) {
            for (const [k, v] of Object.entries(mapped.headers)) reply.header(k, v);
          }
          return reply.status(mapped.status).send(mapped.body);
        }
        logger.error('[ai-suggestion] unexpected error', err);
        return reply.status(500).send({ error: 'internal_error' });
      }
    },
  );
}
