/**
 * Integration tests for webhook debug panel — feature 0014.
 * Covers AC-0001..AC-0009 from docs/features/0014-webhook-debug/SPEC.md.
 *
 * `fetch` is mocked globally so we control responseStatus + simulate timeouts
 * without spinning up an external HTTP server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'owner' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
  vi.restoreAllMocks();
});

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { webhookDebugRoutes } = await import('../../src/modules/api/webhook-debug-routes.js');
  await app.register(webhookDebugRoutes);
  return app;
}

async function seedOrg(label: string, role: 'owner' | 'admin' | 'member' = 'owner') {
  const org = await prisma.organization.create({ data: { name: `${label} Org` } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h', fullName: `User ${label}`, role,
    },
  });
  return { org, user };
}

async function configureWebhook(orgId: string, url: string, secret: string | null) {
  await prisma.appSetting.create({
    data: { orgId, settingKey: 'webhook_url', valuePlain: url },
  });
  if (secret) {
    await prisma.appSetting.create({
      data: { orgId, settingKey: 'webhook_secret', valuePlain: secret },
    });
  }
}

describe('Webhook debug', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.restoreAllMocks();
  });

  describe('emitWebhook persistence', () => {
    it('AC-0001/0002: persists delivery row with response status on success', async () => {
      const { org } = await seedOrg('A');
      await configureWebhook(org.id, 'https://partner.example/hook', 'topsecret');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
      const { emitWebhook } = await import('../../src/modules/api/webhook-service.js');

      await emitWebhook(org.id, 'contact.created', { id: 'c1' });
      // emitWebhook schedules deliverAndPersist; wait for it to land
      await new Promise((r) => setTimeout(r, 100));

      const rows = await prisma.webhookDelivery.findMany({ where: { orgId: org.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toBe('contact.created');
      expect(rows[0].responseStatus).toBe(200);
      expect(rows[0].errorMessage).toBeNull();
      expect(rows[0].signature).toMatch(/^[a-f0-9]{64}$/); // HMAC hex
      expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(rows[0].payload).toContain('"event":"contact.created"');
      expect(rows[0].payload).toContain('"id":"c1"');
    });

    it('AC-0003: persists row with null status + errorMessage on fetch error', async () => {
      const { org } = await seedOrg('B');
      await configureWebhook(org.id, 'https://partner.example/hook', null);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' })),
      );
      const { emitWebhook } = await import('../../src/modules/api/webhook-service.js');

      await emitWebhook(org.id, 'message.sent', { id: 'm1' });
      await new Promise((r) => setTimeout(r, 100));

      const rows = await prisma.webhookDelivery.findMany({ where: { orgId: org.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].responseStatus).toBeNull();
      expect(rows[0].errorMessage).toMatch(/AbortError/);
      expect(rows[0].signature).toBeNull();
    });

    it('skips persistence when no webhook URL configured', async () => {
      const { org } = await seedOrg('C');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
      const { emitWebhook } = await import('../../src/modules/api/webhook-service.js');

      await emitWebhook(org.id, 'contact.created', { id: 'c1' });
      await new Promise((r) => setTimeout(r, 50));

      const rows = await prisma.webhookDelivery.findMany({ where: { orgId: org.id } });
      expect(rows).toHaveLength(0);
    });
  });

  describe('GET /deliveries', () => {
    it('AC-0004: member → 403', async () => {
      const { org, user } = await seedOrg('D', 'member');
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'member' });
      const res = await app.inject({ method: 'GET', url: '/api/v1/settings/webhook/deliveries' });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('AC-0005: owner sees only their org', async () => {
      const { org: orgA, user: ownerA } = await seedOrg('E1');
      const { org: orgB } = await seedOrg('E2');
      await prisma.webhookDelivery.createMany({
        data: [
          { orgId: orgA.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
          { orgId: orgA.id, event: 'b', url: 'u', payload: '{}', responseStatus: 200, durationMs: 2 },
          { orgId: orgB.id, event: 'x', url: 'u', payload: '{}', responseStatus: 200, durationMs: 3 },
        ],
      });
      const app = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });
      const res = await app.inject({ method: 'GET', url: '/api/v1/settings/webhook/deliveries' });
      const body = JSON.parse(res.payload);
      expect(body.total).toBe(2);
      await app.close();
    });

    it('admin role also allowed', async () => {
      const { org, user } = await seedOrg('F', 'admin');
      await prisma.webhookDelivery.create({
        data: { orgId: org.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
      const res = await app.inject({ method: 'GET', url: '/api/v1/settings/webhook/deliveries' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('filters by status=success', async () => {
      const { org, user } = await seedOrg('G');
      await prisma.webhookDelivery.createMany({
        data: [
          { orgId: org.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
          { orgId: org.id, event: 'b', url: 'u', payload: '{}', responseStatus: 500, durationMs: 1 },
          { orgId: org.id, event: 'c', url: 'u', payload: '{}', responseStatus: null, errorMessage: 'fail', durationMs: 1 },
        ],
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/webhook/deliveries?status=success',
      });
      const body = JSON.parse(res.payload);
      expect(body.total).toBe(1);
      expect(body.deliveries[0].event).toBe('a');
      await app.close();
    });

    it('filters by status=failed (4xx/5xx + null)', async () => {
      const { org, user } = await seedOrg('H');
      await prisma.webhookDelivery.createMany({
        data: [
          { orgId: org.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
          { orgId: org.id, event: 'b', url: 'u', payload: '{}', responseStatus: 500, durationMs: 1 },
          { orgId: org.id, event: 'c', url: 'u', payload: '{}', responseStatus: null, errorMessage: 'x', durationMs: 1 },
        ],
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings/webhook/deliveries?status=failed',
      });
      const body = JSON.parse(res.payload);
      expect(body.total).toBe(2);
      await app.close();
    });

    it('list excludes payload + signature (heavy fields)', async () => {
      const { org, user } = await seedOrg('I');
      await prisma.webhookDelivery.create({
        data: {
          orgId: org.id, event: 'a', url: 'u',
          payload: '{"large":"data"}', signature: 'sig',
          responseStatus: 200, durationMs: 1,
        },
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
      const res = await app.inject({ method: 'GET', url: '/api/v1/settings/webhook/deliveries' });
      const body = JSON.parse(res.payload);
      expect(body.deliveries[0]).not.toHaveProperty('payload');
      expect(body.deliveries[0]).not.toHaveProperty('signature');
      await app.close();
    });
  });

  describe('GET /deliveries/:id', () => {
    it('detail includes payload + signature for admin', async () => {
      const { org, user } = await seedOrg('J');
      const row = await prisma.webhookDelivery.create({
        data: {
          orgId: org.id, event: 'a', url: 'https://u',
          payload: '{"k":"v"}', signature: 'sig',
          responseStatus: 200, durationMs: 1,
        },
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/settings/webhook/deliveries/${row.id}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.payload).toBe('{"k":"v"}');
      expect(body.signature).toBe('sig');
      await app.close();
    });

    it('AC-0006: cross-org → 404', async () => {
      const { org: orgA } = await seedOrg('K1');
      const { org: orgB, user: ownerB } = await seedOrg('K2');
      const row = await prisma.webhookDelivery.create({
        data: { orgId: orgA.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
      });
      const app = await buildApp({ id: ownerB.id, orgId: orgB.id, role: 'owner' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/settings/webhook/deliveries/${row.id}`,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('member → 403 on detail', async () => {
      const { org, user } = await seedOrg('L', 'member');
      const row = await prisma.webhookDelivery.create({
        data: { orgId: org.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'member' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/settings/webhook/deliveries/${row.id}`,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe('POST /deliveries/:id/replay', () => {
    it('AC-0007: creates a new delivery row, keeps the old one', async () => {
      const { org, user } = await seedOrg('M');
      await configureWebhook(org.id, 'https://partner.example/hook', 'secret');
      const original = await prisma.webhookDelivery.create({
        data: {
          orgId: org.id, event: 'contact.created', url: 'https://old',
          payload: '{"id":"c1"}', signature: 'oldsig',
          responseStatus: 500, durationMs: 100,
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));

      const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/settings/webhook/deliveries/${original.id}/replay`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.responseStatus).toBe(200);
      expect(body.id).not.toBe(original.id);

      const all = await prisma.webhookDelivery.findMany({ where: { orgId: org.id } });
      expect(all).toHaveLength(2);
      // Original row preserved
      const stillThere = all.find((r) => r.id === original.id);
      expect(stillThere?.responseStatus).toBe(500);
      await app.close();
    });

    it('AC-0008: replay when URL not configured → 400', async () => {
      const { org, user } = await seedOrg('N');
      const original = await prisma.webhookDelivery.create({
        data: { orgId: org.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/settings/webhook/deliveries/${original.id}/replay`,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('replay cross-org → 404', async () => {
      const { org: orgA } = await seedOrg('O1');
      const { org: orgB, user: ownerB } = await seedOrg('O2');
      await configureWebhook(orgB.id, 'https://partner', null);
      const original = await prisma.webhookDelivery.create({
        data: { orgId: orgA.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
      });
      const app = await buildApp({ id: ownerB.id, orgId: orgB.id, role: 'owner' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/settings/webhook/deliveries/${original.id}/replay`,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it('member → 403 on replay', async () => {
      const { org, user } = await seedOrg('P', 'member');
      await configureWebhook(org.id, 'https://partner', null);
      const original = await prisma.webhookDelivery.create({
        data: { orgId: org.id, event: 'a', url: 'u', payload: '{}', responseStatus: 200, durationMs: 1 },
      });
      const app = await buildApp({ id: user.id, orgId: org.id, role: 'member' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/settings/webhook/deliveries/${original.id}/replay`,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('replay re-signs with current secret (not the original)', async () => {
      const { org, user } = await seedOrg('Q');
      await configureWebhook(org.id, 'https://partner', 'newsecret');
      const original = await prisma.webhookDelivery.create({
        data: {
          orgId: org.id, event: 'a', url: 'old',
          payload: '{"k":"v"}', signature: 'OLD_SIG',
          responseStatus: 200, durationMs: 1,
        },
      });
      let capturedSig: string | null = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, opts: any) => {
        capturedSig = opts.headers['X-Webhook-Signature'];
        return Promise.resolve({ status: 200 });
      }));

      const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
      await app.inject({
        method: 'POST',
        url: `/api/v1/settings/webhook/deliveries/${original.id}/replay`,
      });
      expect(capturedSig).not.toBe('OLD_SIG');
      expect(capturedSig).toMatch(/^[a-f0-9]{64}$/);
      await app.close();
    });
  });
});
