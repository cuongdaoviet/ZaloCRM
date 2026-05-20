/**
 * Integration tests for feature 0016 — per-user preferences KV store.
 * Real Postgres via testcontainers + Fastify inject.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
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
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'owner', email: 't@t' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = { ...user, email: `${user.id}@t.local` };
  });
  const { userPreferenceRoutes } = await import(
    '../../src/modules/auth/user-preference-routes.js'
  );
  await app.register(userPreferenceRoutes);
  return app;
}

async function seedOrgAndUser(suffix = '') {
  const org = await prisma.organization.create({
    data: { name: `Pref Org ${suffix}${Date.now()}${Math.random()}` },
  });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u${suffix}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'User',
      role: 'owner',
    },
  });
  return { org, user };
}

describe('User preferences KV store (integration)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    // resetDb truncates the base tables CASCADE which clears user_preferences too.
  });

  it('GET map returns {} when no preferences exist', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({});
    await app.close();
  });

  it('PUT then GET round-trips a string value', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.theme',
      payload: { value: 'dark' },
    });
    expect(put.statusCode).toBe(200);
    expect(JSON.parse(put.payload).value).toBe('dark');

    const getMap = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences',
    });
    expect(JSON.parse(getMap.payload)).toEqual({ 'ui.theme': 'dark' });

    const getOne = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences/ui.theme',
    });
    expect(getOne.statusCode).toBe(200);
    expect(JSON.parse(getOne.payload)).toEqual({ key: 'ui.theme', value: 'dark' });
    await app.close();
  });

  it('PUT then GET round-trips a complex object', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const value = {
      status: ['new', 'contacted'],
      source: ['FB', 'TT'],
      assigned: null,
      pageSize: 50,
      nested: { a: 1, b: [true, false] },
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/contacts.last_filter',
      payload: { value },
    });
    expect(put.statusCode).toBe(200);

    const getOne = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences/contacts.last_filter',
    });
    expect(JSON.parse(getOne.payload).value).toEqual(value);
    await app.close();
  });

  it('PUT with key NOT in allowlist → 400', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.unknown_setting',
      payload: { value: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain('Key');
    await app.close();
  });

  it('PUT with malformed key (uppercase) → 400', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/UI.theme',
      payload: { value: 'dark' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PUT with malformed key (starts with digit) → 400', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/1ui.theme',
      payload: { value: 'dark' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PUT with value > 4096 chars → 400', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.theme',
      payload: { value: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/4096/);
    await app.close();
  });

  it('GET single value → 404 when not set', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences/ui.theme',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE removes the row, DELETE again is still 204', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.theme',
      payload: { value: 'dark' },
    });

    const del1 = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me/preferences/ui.theme',
    });
    expect(del1.statusCode).toBe(204);
    expect(await prisma.userPreference.count()).toBe(0);

    const del2 = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me/preferences/ui.theme',
    });
    expect(del2.statusCode).toBe(204);
    await app.close();
  });

  it("user A's PUT does not leak into user B's GET (cross-user isolation)", async () => {
    const { org: orgA, user: userA } = await seedOrgAndUser('a');
    const { org: orgB, user: userB } = await seedOrgAndUser('b');

    const appA = await buildApp({ id: userA.id, orgId: orgA.id, role: 'owner' });
    await appA.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.theme',
      payload: { value: 'dark' },
    });
    await appA.close();

    const appB = await buildApp({ id: userB.id, orgId: orgB.id, role: 'owner' });
    const mapB = await appB.inject({
      method: 'GET',
      url: '/api/v1/me/preferences',
    });
    expect(JSON.parse(mapB.payload)).toEqual({});

    const oneB = await appB.inject({
      method: 'GET',
      url: '/api/v1/me/preferences/ui.theme',
    });
    expect(oneB.statusCode).toBe(404);
    await appB.close();
  });

  it('updating an existing key changes value + updates updatedAt', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const first = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.theme',
      payload: { value: 'light' },
    });
    const firstRow = JSON.parse(first.payload);

    // Wait a touch so updatedAt definitely moves forward.
    await new Promise((r) => setTimeout(r, 25));

    const second = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.theme',
      payload: { value: 'dark' },
    });
    const secondRow = JSON.parse(second.payload);

    expect(secondRow.id).toBe(firstRow.id); // same row
    expect(secondRow.value).toBe('dark');
    expect(new Date(secondRow.updatedAt).getTime()).toBeGreaterThan(
      new Date(firstRow.updatedAt).getTime(),
    );
    // And only one row exists.
    expect(await prisma.userPreference.count()).toBe(1);
    await app.close();
  });

  it('PUT body missing the value field → 400', async () => {
    const { org, user } = await seedOrgAndUser();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences/ui.theme',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
