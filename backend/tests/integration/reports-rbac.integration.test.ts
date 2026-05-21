/**
 * Feature 0048 Phần A — RBAC guards on /api/v1/reports/*.
 * Four endpoints expose org-wide message/contact/appointment data plus
 * Excel export. Sibling features (/kpi, /analytics) were already
 * admin-only; this closes the inconsistency.
 *
 * AC mapping:
 *   AC-0003: GET /reports/{messages,contacts,appointments,export} with
 *            member → 403
 *   AC-0005: owner/admin still get 200
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
});

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app: FastifyInstance = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { reportRoutes } = await import('../../src/modules/dashboard/report-routes.js');
  await app.register(reportRoutes);
  return app;
}

async function seedOrg() {
  const org = await prisma.organization.create({ data: { name: 'Reports RBAC Org' } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  return { org, owner, member };
}

describe('GET /api/v1/reports/* — BR-0003', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  // Each row drives one test: endpoint name + URL.
  const endpoints = [
    { name: 'messages', url: '/api/v1/reports/messages' },
    { name: 'contacts', url: '/api/v1/reports/contacts' },
    { name: 'appointments', url: '/api/v1/reports/appointments' },
    { name: 'export (Excel)', url: '/api/v1/reports/export?type=messages' },
  ];

  for (const ep of endpoints) {
    it(`AC-0003: ${ep.name} returns 403 for member`, async () => {
      const { org, member } = await seedOrg();
      const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
      const res = await app.inject({ method: 'GET', url: ep.url });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  }

  it('AC-0005: owner still gets 200 on /reports/messages', async () => {
    const { org, owner } = await seedOrg();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/messages' });
    // 200 with empty data set is acceptable; what we care about is the
    // route is not blocked by the new guard.
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('AC-0005: admin still gets 200 on /reports/contacts', async () => {
    const { org } = await seedOrg();
    const admin = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `a-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'h',
        fullName: 'Admin',
        role: 'admin',
      },
    });
    const app = await buildApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/contacts' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
