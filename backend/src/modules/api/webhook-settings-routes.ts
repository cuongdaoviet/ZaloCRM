/**
 * webhook-settings-routes.ts — Manage webhook URL/secret and public API key generation.
 * All routes require JWT auth and are scoped to user's org.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { emitWebhook } from './webhook-service.js';
import { hashApiKey } from '../../shared/crypto/hash-api-key.js';
import crypto from 'node:crypto';

export async function webhookSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/settings/webhook — retrieve current webhook config
  app.get('/api/v1/settings/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;

      const [urlSetting, secretSetting] = await Promise.all([
        prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_url' } }),
        prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_secret' } }),
      ]);

      return {
        url: urlSetting?.valuePlain ?? null,
        // Mask secret — show only last 4 chars
        secret: secretSetting?.valuePlain
          ? `${'*'.repeat(Math.max(0, secretSetting.valuePlain.length - 4))}${secretSetting.valuePlain.slice(-4)}`
          : null,
      };
    } catch (err) {
      logger.error('[webhook-settings] GET error:', err);
      return reply.status(500).send({ error: 'Failed to fetch webhook settings' });
    }
  });

  // PUT /api/v1/settings/webhook — save webhook URL and secret
  app.put('/api/v1/settings/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;
      const { url, secret } = request.body as { url?: string; secret?: string };

      await Promise.all([
        upsertSetting(orgId, 'webhook_url', url ?? ''),
        secret !== undefined ? upsertSetting(orgId, 'webhook_secret', secret) : Promise.resolve(),
      ]);

      return { success: true };
    } catch (err) {
      logger.error('[webhook-settings] PUT error:', err);
      return reply.status(500).send({ error: 'Failed to save webhook settings' });
    }
  });

  // POST /api/v1/settings/webhook/test — deliver a test event to configured URL
  app.post('/api/v1/settings/webhook/test', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;

      const config = await prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_url' } });
      if (!config?.valuePlain) {
        return reply.status(400).send({ error: 'No webhook URL configured' });
      }

      await emitWebhook(orgId, 'webhook.test', { message: 'Test event from Zalo CRM', orgId });
      return { success: true, sentTo: config.valuePlain };
    } catch (err) {
      logger.error('[webhook-settings] Test error:', err);
      return reply.status(500).send({ error: 'Failed to send test webhook' });
    }
  });

  // POST /api/v1/settings/api-key/generate — generate new public API key
  //
  // Feature 0046 BR-0016: the plaintext key is returned to the caller
  // ONCE (here, in the response). The DB row stores only its SHA-256
  // hash so a future leak of `app_settings.value_plain` yields no
  // working credentials.
  app.post('/api/v1/settings/api-key/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;

      const newKey = `zcrm_${crypto.randomBytes(24).toString('hex')}`;
      // Store the hash, NEVER the plaintext.
      await upsertSetting(orgId, 'public_api_key', hashApiKey(newKey));

      // Return the plaintext to the caller — this is their only chance
      // to see it. Caller is expected to copy it to their own secret store.
      return { key: newKey };
    } catch (err) {
      logger.error('[webhook-settings] Generate API key error:', err);
      return reply.status(500).send({ error: 'Failed to generate API key' });
    }
  });

  // GET /api/v1/settings/api-key — retrieve masked API key indicator
  //
  // Feature 0046: the row now stores a SHA-256 hash (or legacy plaintext
  // during the migration window). We can't reconstruct the original key
  // from the hash, so the FE just gets a presence indicator + last 4
  // hash chars to help operators see when the key has been rotated.
  app.get('/api/v1/settings/api-key', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;

      const setting = await prisma.appSetting.findFirst({ where: { orgId, settingKey: 'public_api_key' } });
      if (!setting?.valuePlain) return { key: null };

      const k = setting.valuePlain;
      // Show prefix + mask + last 4 chars. Works for both hashed (64
      // hex) and legacy-plaintext (~53 char) values until migration
      // completes lazily on next use.
      const masked = k.length > 12 ? `${k.slice(0, 12)}${'*'.repeat(k.length - 16)}${k.slice(-4)}` : `${k.slice(0, 4)}****`;
      return { key: masked };
    } catch (err) {
      logger.error('[webhook-settings] GET API key error:', err);
      return reply.status(500).send({ error: 'Failed to fetch API key' });
    }
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function upsertSetting(orgId: string, settingKey: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { orgId_settingKey: { orgId, settingKey } },
    create: { orgId, settingKey, valuePlain: value },
    update: { valuePlain: value },
  });
}
