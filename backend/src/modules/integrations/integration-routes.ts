/**
 * Integration Hub routes — Feature 0038.
 *
 * Endpoint surface (all under /api/v1/integrations):
 *   GET    /                       — list (no decrypted config in response)
 *   POST   /                       — create + test connection + encrypt
 *   PATCH  /:id                    — partial update (name/enabled/config)
 *   DELETE /:id                    — soft delete (clear cipher + disable)
 *   POST   /:id/sync               — manual sync (async, returns runId)
 *   GET    /:id/runs               — recent IntegrationRun rows
 *   GET    /oauth/google/url       — start Google OAuth (returns redirect URL)
 *   GET    /oauth/google/callback  — receive code + return tokens for FE to POST back
 *
 * RBAC: BR-0017 — admin/owner only across the board (no member access).
 *
 * Why OAuth callback returns to the FE instead of creating the row directly:
 * the row also needs spreadsheetId/sheetName/eventTypes which are user
 * choices. Returning the refresh token to the FE in the OAuth `state`
 * pickup means the FE composes the full config and POSTs back to /.
 * State CSRF: signed JWT keeps it tamper-resistant.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID, createHmac } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { config } from '../../config/index.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { trackBackground } from '../../shared/utils/background-tasks.js';
import {
  createIntegration,
  updateIntegration,
  softDeleteIntegration,
  openSyncRun,
  executeSyncRun,
  toSummary,
} from './integration-service.js';
import {
  buildAuthUrl,
  exchangeCode,
} from './connectors/google-sheets.js';

const ADMIN_ROLES = ['owner', 'admin'] as const;

interface CreateBody {
  type?: string;
  name?: string;
  config?: unknown;
}

interface PatchBody {
  name?: string;
  enabled?: boolean;
  config?: unknown;
}

/**
 * Build a short-lived signed OAuth state. Encodes orgId + nonce + expiry.
 * Verified on callback so an attacker can't forge a `state` parameter.
 *
 * We use the same JWT secret as the rest of the app for symmetric HMAC —
 * the integration callback path doesn't need its own secret rotation.
 */
function signOAuthState(orgId: string, secret: string): string {
  const exp = Date.now() + 10 * 60_000; // 10 minutes
  const nonce = randomUUID();
  const payload = `${orgId}.${nonce}.${exp}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

function verifyOAuthState(state: string, secret: string): { ok: true; orgId: string } | { ok: false; error: string } {
  const parts = state.split('.');
  if (parts.length !== 4) return { ok: false, error: 'Malformed state' };
  const [orgId, nonce, expStr, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${orgId}.${nonce}.${expStr}`).digest('hex').slice(0, 32);
  if (expected !== sig) return { ok: false, error: 'State signature mismatch' };
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) {
    return { ok: false, error: 'State expired' };
  }
  return { ok: true, orgId };
}

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  // ── Public OAuth callback ────────────────────────────────────────────
  // Google redirects the admin's browser here. The signed `state` is the
  // CSRF guard — we never trust the query at face value. Encapsulated in
  // its own register() so the JWT auth hook below does NOT apply to it.
  await app.register(async (publicApp) => {
    publicApp.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      '/api/v1/integrations/oauth/google/callback',
      async (request, reply) => {
        const { code, state, error } = request.query;
        if (error) {
          return reply.status(400).send({ error: `OAuth provider error: ${error}` });
        }
        if (!code || !state) {
          return reply.status(400).send({ error: 'Missing code or state' });
        }
        const verified = verifyOAuthState(state, config.jwtSecret);
        if (!verified.ok) {
          return reply.status(400).send({ error: verified.error });
        }
        try {
          const { refreshToken } = await exchangeCode(code);
          // We don't have a session here — return the token (+ orgId for sanity
          // check) to the FE so it can compose the full config and POST to /.
          return reply.send({ orgId: verified.orgId, refreshToken });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[integrations] OAuth exchange failed: ${msg}`);
          return reply.status(400).send({ error: msg.slice(0, 200) });
        }
      },
    );
  });

  // ── Authenticated CRUD routes ────────────────────────────────────────
  app.addHook('preHandler', authMiddleware);

  // List integrations for the user's org.
  app.get(
    '/api/v1/integrations',
    { preHandler: requireRole(...ADMIN_ROLES) },
    async (request) => {
      const { orgId } = request.user!;
      const rows = await prisma.integration.findMany({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
      });
      return { integrations: rows.map((r) => toSummary(r as never)) };
    },
  );

  // Generate an OAuth URL for the Google Sheets flow. The FE opens this in
  // a popup; Google bounces back to /oauth/google/callback with a `code`.
  app.get(
    '/api/v1/integrations/oauth/google/url',
    { preHandler: requireRole(...ADMIN_ROLES) },
    async (request, reply) => {
      const { orgId } = request.user!;
      const jwtSecret = config.jwtSecret;
      if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
        return reply
          .status(503)
          .send({ error: 'Google OAuth not configured on server' });
      }
      const state = signOAuthState(orgId, jwtSecret);
      const url = buildAuthUrl(state);
      return { url };
    },
  );

  // Create.
  app.post<{ Body: CreateBody }>(
    '/api/v1/integrations',
    { preHandler: requireRole(...ADMIN_ROLES) },
    async (request, reply) => {
      const { orgId } = request.user!;
      const { type, name, config } = request.body ?? {};
      if (!type || !name || config === undefined) {
        return reply.status(400).send({ error: 'type, name, config are required' });
      }
      const result = await createIntegration({ orgId, type, name, config });
      if (!result.ok) {
        return reply.status(400).send({ error: result.error });
      }
      logger.info(
        `[integrations] created ${result.integration!.type} (${result.integration!.id}) for org ${orgId}`,
      );
      return reply.status(201).send(result.integration);
    },
  );

  // Partial update.
  app.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/api/v1/integrations/:id',
    { preHandler: requireRole(...ADMIN_ROLES) },
    async (request, reply) => {
      const { orgId } = request.user!;
      const { id } = request.params;
      const body = request.body ?? {};
      const result = await updateIntegration({ orgId, id, ...body });
      if (!result.ok) {
        const status = result.error === 'Integration not found' ? 404 : 400;
        return reply.status(status).send({ error: result.error });
      }
      return result.integration;
    },
  );

  // Soft delete.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/integrations/:id',
    { preHandler: requireRole(...ADMIN_ROLES) },
    async (request, reply) => {
      const { orgId } = request.user!;
      const ok = await softDeleteIntegration(orgId, request.params.id);
      if (!ok) return reply.status(404).send({ error: 'Integration not found' });
      return reply.status(204).send();
    },
  );

  // Manual sync trigger. 202 + runId; sync runs async via trackBackground().
  app.post<{ Params: { id: string } }>(
    '/api/v1/integrations/:id/sync',
    { preHandler: requireRole(...ADMIN_ROLES) },
    async (request, reply) => {
      const { orgId } = request.user!;
      const existing = await prisma.integration.findFirst({
        where: { id: request.params.id, orgId },
        select: { id: true, enabled: true, configCipher: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Integration not found' });
      if (!existing.enabled) return reply.status(409).send({ error: 'Integration is disabled' });
      if (existing.configCipher.length === 0) {
        return reply.status(409).send({ error: 'Integration has no config' });
      }
      try {
        const { runId, row } = await openSyncRun(existing.id);
        // Fire-and-forget the actual work. trackBackground() ensures tests
        // can drain in-flight runs before truncating tables.
        trackBackground(executeSyncRun(runId, row));
        return reply.status(202).send({ runId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: msg.slice(0, 300) });
      }
    },
  );

  // Recent runs.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/v1/integrations/:id/runs',
    { preHandler: requireRole(...ADMIN_ROLES) },
    async (request, reply) => {
      const { orgId } = request.user!;
      const existing = await prisma.integration.findFirst({
        where: { id: request.params.id, orgId },
        select: { id: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Integration not found' });

      const rawLimit = Number(request.query.limit ?? '20');
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
      const runs = await prisma.integrationRun.findMany({
        where: { integrationId: existing.id },
        orderBy: { startedAt: 'desc' },
        take: limit,
      });
      return { runs };
    },
  );
}
