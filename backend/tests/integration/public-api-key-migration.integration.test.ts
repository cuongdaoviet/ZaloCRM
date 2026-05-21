/**
 * Integration tests for Feature 0046 — public API key hashing + lazy migration.
 *
 * Covers SPEC §6:
 *   - AC-0006: new key is stored hashed (64 hex chars in value_plain).
 *   - AC-0007: legacy plaintext key still authenticates on first request;
 *              the row is rewritten with the hash after that request.
 *
 * Plus BR-0014 — invalid keys are rejected; BR-0016 — newly minted keys
 * never land plaintext in the DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';
import { hashApiKey } from '../../src/shared/crypto/hash-api-key.js';

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

async function buildPublicApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const { publicApiRoutes } = await import(
    '../../src/modules/api/public-api-routes.js'
  );
  await app.register(publicApiRoutes);
  return app;
}

async function buildMgmtApp(
  user: { id: string; orgId: string; role: string },
): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { webhookSettingsRoutes } = await import(
    '../../src/modules/api/webhook-settings-routes.js'
  );
  await app.register(webhookSettingsRoutes);
  return app;
}

async function seedOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `${label}-${Date.now()}` },
  });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: `User ${label}`,
      role: 'owner',
    },
  });
  return { org, user };
}

describe('Public API key hashing + lazy migration (Feature 0046)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.restoreAllMocks();
  });

  it('AC-0006: generated key is stored as a 64-char SHA-256 hash', async () => {
    const { org, user } = await seedOrg('hash');
    const mgmt = await buildMgmtApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await mgmt.inject({
      method: 'POST',
      url: '/api/v1/settings/api-key/generate',
    });
    expect(res.statusCode).toBe(200);
    const { key } = res.json() as { key: string };
    expect(key).toMatch(/^zcrm_[0-9a-f]{48}$/);

    const row = await prisma.appSetting.findFirst({
      where: { orgId: org.id, settingKey: 'public_api_key' },
    });
    expect(row).not.toBeNull();
    // Stored value must be the SHA-256 hash, never the plaintext.
    expect(row!.valuePlain).not.toBe(key);
    expect(row!.valuePlain).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.valuePlain).toBe(hashApiKey(key));

    await mgmt.close();
  });

  it('AC-0007: legacy plaintext key authenticates AND triggers lazy hash migration', async () => {
    const { org } = await seedOrg('legacy');

    // Seed a legacy plaintext row — simulates a pre-0046 deployment.
    const legacyKey = `zcrm_${'a'.repeat(48)}`;
    await prisma.appSetting.create({
      data: { orgId: org.id, settingKey: 'public_api_key', valuePlain: legacyKey },
    });

    const app = await buildPublicApp();

    // First request — legacy plaintext match path.
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/public/contacts',
      headers: { 'x-api-key': legacyKey },
    });
    expect(res1.statusCode).toBe(200);

    // Drain fire-and-forget migration write.
    const { flushBackgroundTasks } = await import(
      '../../src/shared/utils/background-tasks.js'
    );
    await flushBackgroundTasks();

    // Row should now hold the hash, not the plaintext.
    const row = await prisma.appSetting.findFirst({
      where: { orgId: org.id, settingKey: 'public_api_key' },
    });
    expect(row!.valuePlain).toBe(hashApiKey(legacyKey));
    expect(row!.valuePlain).not.toBe(legacyKey);

    // Second request — same key, now via hashed path.
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/public/contacts',
      headers: { 'x-api-key': legacyKey },
    });
    expect(res2.statusCode).toBe(200);

    await app.close();
  });

  it('rejects a wrong key (length match) with 401', async () => {
    const { org } = await seedOrg('wrong');
    const realKey = `zcrm_${'a'.repeat(48)}`;
    await prisma.appSetting.create({
      data: {
        orgId: org.id,
        settingKey: 'public_api_key',
        valuePlain: hashApiKey(realKey),
      },
    });

    const app = await buildPublicApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/public/contacts',
      headers: { 'x-api-key': `zcrm_${'b'.repeat(48)}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects missing X-Api-Key with 401', async () => {
    const app = await buildPublicApp();
    const res = await app.inject({ method: 'GET', url: '/api/public/contacts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
