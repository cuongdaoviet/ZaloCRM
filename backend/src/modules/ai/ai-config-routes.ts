/**
 * AI configuration routes — Feature 0036.
 *
 *   GET    /api/v1/settings/ai-config   admin/owner → current config (no key)
 *   PUT    /api/v1/settings/ai-config   admin/owner → upsert; key encrypted
 *   DELETE /api/v1/settings/ai-config   admin/owner → soft-delete (disable + clear)
 *   GET    /api/v1/settings/ai-providers any auth     → provider menu (for FE dropdown)
 *
 * The PUT handler optionally runs a 1-token test request to verify the key
 * before persisting (BR-0012). On failure we return 400 with the upstream
 * error.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import {
  encryptForOrg,
  maskApiKey,
} from '../../shared/crypto/encrypt-config.js';
import {
  getProviderById,
  isKnownProvider,
  listProviders,
} from './provider-registry.js';

interface PutBody {
  provider?: string;
  apiKey?: string | null;
  apiEndpoint?: string | null;
  model?: string;
  systemPrompt?: string | null;
  enabled?: boolean;
  maxSuggestionsPerDay?: number;
  /** When true, skip the live test request (used by automated migrations). */
  skipTest?: boolean;
}

interface ConfigResponse {
  id: string | null;
  provider: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  apiEndpoint: string | null;
  model: string;
  systemPrompt: string | null;
  enabled: boolean;
  maxSuggestionsPerDay: number;
  updatedAt: string | null;
}

function serialize(row: {
  id: string;
  provider: string;
  apiKeyCipher: string;
  apiEndpoint: string | null;
  model: string;
  systemPrompt: string | null;
  enabled: boolean;
  maxSuggestionsPerDay: number;
  updatedAt: Date;
}): ConfigResponse {
  return {
    id: row.id,
    provider: row.provider,
    apiKeyConfigured: row.apiKeyCipher.length > 0,
    // We never echo the key, even partially decrypted. Hint is just whether
    // it's set or not — the FE shows "Đã cấu hình" rather than the value.
    apiKeyHint: row.apiKeyCipher ? '***' : null,
    apiEndpoint: row.apiEndpoint,
    model: row.model,
    systemPrompt: row.systemPrompt,
    enabled: row.enabled,
    maxSuggestionsPerDay: row.maxSuggestionsPerDay,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** BR-0012 — make a 1-token test request to verify the key works. */
async function testConnection(opts: {
  provider: string;
  apiKey: string;
  apiEndpoint: string | null;
  model: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = getProviderById(opts.provider);
  if (!def) return { ok: false, error: `Unknown provider: ${opts.provider}` };
  try {
    await def.adapter.generate({
      apiKey: opts.apiKey,
      apiEndpoint: opts.apiEndpoint ?? undefined,
      model: opts.model,
      messages: [
        { role: 'system', content: 'Reply with exactly the word: ok' },
        { role: 'user', content: 'ping' },
      ],
      maxTokens: 8,
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Mask any key fragments from the upstream error before bubbling.
    const safe = msg.replace(/sk-[A-Za-z0-9_\-]{6,}/g, '***');
    return { ok: false, error: safe };
  }
}

export async function aiConfigRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ── Provider catalog (any authenticated user, used to populate dropdowns) ─
  app.get('/api/v1/settings/ai-providers', async () => {
    return { providers: listProviders() };
  });

  // ── Read current config ──────────────────────────────────────────────────
  app.get(
    '/api/v1/settings/ai-config',
    { preHandler: requireRole('owner', 'admin') },
    async (request: FastifyRequest) => {
      const user = request.user!;
      const row = await prisma.aiConfig.findUnique({ where: { orgId: user.orgId } });
      if (!row) {
        // Return empty defaults — FE renders an empty form ready for first save.
        return {
          id: null,
          provider: 'anthropic',
          apiKeyConfigured: false,
          apiKeyHint: null,
          apiEndpoint: null,
          model: 'claude-haiku-4-5',
          systemPrompt: null,
          enabled: false,
          maxSuggestionsPerDay: 1000,
          updatedAt: null,
        } satisfies ConfigResponse;
      }
      return serialize(row);
    },
  );

  // ── Upsert config ────────────────────────────────────────────────────────
  app.put(
    '/api/v1/settings/ai-config',
    { preHandler: requireRole('owner', 'admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const body = (request.body ?? {}) as PutBody;

      // Validate provider + model
      const provider = body.provider ?? 'anthropic';
      if (!isKnownProvider(provider)) {
        return reply.status(400).send({ error: `Unknown provider: ${provider}` });
      }
      const def = getProviderById(provider)!;

      const model = body.model ?? def.models[0]?.value ?? '';
      if (!model) {
        return reply.status(400).send({ error: 'Model is required' });
      }

      const maxPerDay = body.maxSuggestionsPerDay ?? 1000;
      if (!Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 1_000_000) {
        return reply.status(400).send({ error: 'maxSuggestionsPerDay must be an integer in [1, 1_000_000]' });
      }
      if (body.systemPrompt && body.systemPrompt.length > 2000) {
        return reply.status(400).send({ error: 'systemPrompt must be ≤ 2000 characters' });
      }

      const existing = await prisma.aiConfig.findUnique({
        where: { orgId: user.orgId },
      });

      // Resolve incoming key:
      //  - undefined → keep existing cipher (no change).
      //  - null      → clear cipher (revoke key, force disabled).
      //  - string    → encrypt + persist + (optionally) test.
      let nextCipher = existing?.apiKeyCipher ?? '';
      let nextIv = existing?.apiKeyIv ?? '';
      let nextTag = existing?.apiKeyTag ?? '';
      let forceDisable = false;

      if (body.apiKey === null) {
        nextCipher = '';
        nextIv = '';
        nextTag = '';
        forceDisable = true;
      } else if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
        // BR-0012 — test before persisting.
        if (!body.skipTest) {
          const test = await testConnection({
            provider,
            apiKey: body.apiKey,
            apiEndpoint: body.apiEndpoint ?? existing?.apiEndpoint ?? null,
            model,
          });
          if (!test.ok) {
            return reply.status(400).send({ error: `Provider test failed: ${test.error}` });
          }
        }
        const blob = encryptForOrg(user.orgId, body.apiKey);
        nextCipher = blob.cipher;
        nextIv = blob.iv;
        nextTag = blob.tag;
        logger.info(`[ai-config] org=${user.orgId} key updated ${maskApiKey(body.apiKey)}`);
      } else if (
        def.requiresApiKey &&
        !existing?.apiKeyCipher &&
        body.enabled === true
      ) {
        return reply.status(400).send({ error: 'API key required to enable this provider' });
      }

      const enabled = forceDisable ? false : body.enabled ?? existing?.enabled ?? false;

      const upserted = await prisma.aiConfig.upsert({
        where: { orgId: user.orgId },
        create: {
          orgId: user.orgId,
          provider,
          apiKeyCipher: nextCipher,
          apiKeyIv: nextIv,
          apiKeyTag: nextTag,
          apiEndpoint: body.apiEndpoint ?? null,
          model,
          systemPrompt: body.systemPrompt ?? null,
          enabled,
          maxSuggestionsPerDay: maxPerDay,
        },
        update: {
          provider,
          apiKeyCipher: nextCipher,
          apiKeyIv: nextIv,
          apiKeyTag: nextTag,
          apiEndpoint: body.apiEndpoint === undefined ? undefined : body.apiEndpoint,
          model,
          systemPrompt: body.systemPrompt === undefined ? undefined : body.systemPrompt,
          enabled,
          maxSuggestionsPerDay: maxPerDay,
        },
      });
      return serialize(upserted);
    },
  );

  // ── Soft delete: disable + clear key ─────────────────────────────────────
  app.delete(
    '/api/v1/settings/ai-config',
    { preHandler: requireRole('owner', 'admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const existing = await prisma.aiConfig.findUnique({
        where: { orgId: user.orgId },
      });
      if (!existing) {
        return reply.status(204).send();
      }
      await prisma.aiConfig.update({
        where: { orgId: user.orgId },
        data: {
          enabled: false,
          apiKeyCipher: '',
          apiKeyIv: '',
          apiKeyTag: '',
        },
      });
      logger.info(`[ai-config] org=${user.orgId} config cleared`);
      return reply.status(204).send();
    },
  );
}
