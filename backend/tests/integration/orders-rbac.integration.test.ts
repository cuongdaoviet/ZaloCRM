/**
 * Feature 0048 Phần A — RBAC guards on /api/v1/orders/by-staff and
 * /api/v1/orders/stats. Both endpoints return org-wide revenue figures
 * (per-staff or aggregate) and must be owner/admin only. Previously open
 * to any authenticated member.
 *
 * AC mapping:
 *   AC-0001: GET /orders/by-staff with member → 403
 *   AC-0002: GET /orders/stats with member → 403
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
// Webhook emitter is fire-and-forget; stub so tests don't hit network.
vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(async () => undefined),
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
  const { orderRoutes } = await import('../../src/modules/orders/order-routes.js');
  await app.register(orderRoutes);
  return app;
}

async function seedOrg() {
  const org = await prisma.organization.create({ data: { name: 'RBAC Test Org' } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `owner-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `admin-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Admin',
      role: 'admin',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `member-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  const contact = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Customer' },
  });
  // One completed order so stats has non-empty aggregates.
  await prisma.order.create({
    data: {
      orgId: org.id,
      contactId: contact.id,
      createdByUserId: owner.id,
      orderCode: 'O1',
      totalAmount: 10_000,
      status: 'completed',
    },
  });
  return { org, owner, admin, member };
}

describe('GET /api/v1/orders/by-staff — BR-0001', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: member receives 403', async () => {
    const { org, member } = await seedOrg();
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/by-staff' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0005: owner receives 200', async () => {
    const { org, owner } = await seedOrg();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/by-staff' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body.staffStats)).toBe(true);
    await app.close();
  });

  it('AC-0005: admin receives 200', async () => {
    const { org, admin } = await seedOrg();
    const app = await buildApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/by-staff' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('GET /api/v1/orders/stats — BR-0002', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0002: member receives 403', async () => {
    const { org, member } = await seedOrg();
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/stats' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0005: owner receives 200 with revenue fields', async () => {
    const { org, owner } = await seedOrg();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('totalOrders');
    expect(body).toHaveProperty('totalRevenue');
    await app.close();
  });
});
