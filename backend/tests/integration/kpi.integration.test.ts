/**
 * Integration tests for feature 0007 — /kpi/summary + /kpi/leaderboard.
 * Real Postgres + Fastify inject. Seeds a small but representative fixture
 * covering staff vs auto-reply messages, all order statuses, and multi-user
 * activity so the leaderboard ordering is verifiable.
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
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { kpiRoutes } = await import('../../src/modules/kpi/kpi-routes.js');
  await app.register(kpiRoutes);
  return app;
}

// Anchor "now" inside the seeded date range so default last7days catches everything.
const NOW = new Date();
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 86_400_000);

async function seedRich() {
  const org = await prisma.organization.create({ data: { name: 'KPI Org' } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Hương',
      role: 'owner',
    },
  });
  const sale1 = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `s1-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Lan',
      role: 'member',
    },
  });
  const sale2 = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `s2-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Bình',
      role: 'member',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
  });
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      threadType: 'user',
      externalThreadId: 'kh-1',
    },
  });
  // Contacts: 2 new in range, 1 converted in range
  const contactNew1 = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Khách 1', status: 'new', assignedUserId: sale1.id, createdAt: TWO_DAYS_AGO },
  });
  await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Khách 2', status: 'new', assignedUserId: sale1.id, createdAt: TWO_DAYS_AGO },
  });
  await prisma.contact.create({
    data: {
      orgId: org.id,
      fullName: 'Khách 3',
      status: 'converted',
      assignedUserId: sale2.id,
      createdAt: TWO_DAYS_AGO,
      updatedAt: TWO_DAYS_AGO,
    },
  });
  // Messages: 3 staff-sent by Lan, 1 by Bình, 2 auto-reply (repliedByUserId=null), 2 inbound
  await prisma.message.createMany({
    data: [
      { conversationId: conv.id, senderType: 'self', senderUid: 'self', content: 'a', contentType: 'text', sentAt: TWO_DAYS_AGO, repliedByUserId: sale1.id },
      { conversationId: conv.id, senderType: 'self', senderUid: 'self', content: 'b', contentType: 'text', sentAt: TWO_DAYS_AGO, repliedByUserId: sale1.id },
      { conversationId: conv.id, senderType: 'self', senderUid: 'self', content: 'c', contentType: 'text', sentAt: TWO_DAYS_AGO, repliedByUserId: sale1.id },
      { conversationId: conv.id, senderType: 'self', senderUid: 'self', content: 'd', contentType: 'text', sentAt: TWO_DAYS_AGO, repliedByUserId: sale2.id },
      // Auto-reply messages (no repliedByUserId) — must NOT count toward messagesSent
      { conversationId: conv.id, senderType: 'self', senderUid: 'self', content: 'auto1', contentType: 'text', sentAt: TWO_DAYS_AGO },
      { conversationId: conv.id, senderType: 'self', senderUid: 'self', content: 'auto2', contentType: 'text', sentAt: TWO_DAYS_AGO },
      // Inbound
      { conversationId: conv.id, senderType: 'contact', senderUid: 'kh-1', content: 'reply', contentType: 'text', sentAt: TWO_DAYS_AGO },
      { conversationId: conv.id, senderType: 'contact', senderUid: 'kh-1', content: 'reply2', contentType: 'text', sentAt: TWO_DAYS_AGO },
    ],
  });
  // Orders: Lan has 2 paid (10M, 20M = 30M revenue), Bình 1 completed (5M),
  // owner has 1 cancelled (50M — must NOT count), 1 new (100M — must NOT count)
  await prisma.order.createMany({
    data: [
      { orgId: org.id, contactId: contactNew1.id, createdByUserId: sale1.id, orderCode: 'A1', totalAmount: 10_000_000, status: 'paid', createdAt: TWO_DAYS_AGO },
      { orgId: org.id, contactId: contactNew1.id, createdByUserId: sale1.id, orderCode: 'A2', totalAmount: 20_000_000, status: 'paid', createdAt: TWO_DAYS_AGO },
      { orgId: org.id, contactId: contactNew1.id, createdByUserId: sale2.id, orderCode: 'B1', totalAmount: 5_000_000, status: 'completed', createdAt: TWO_DAYS_AGO },
      { orgId: org.id, contactId: contactNew1.id, createdByUserId: owner.id, orderCode: 'O1', totalAmount: 50_000_000, status: 'cancelled', createdAt: TWO_DAYS_AGO },
      { orgId: org.id, contactId: contactNew1.id, createdByUserId: owner.id, orderCode: 'O2', totalAmount: 100_000_000, status: 'new', createdAt: TWO_DAYS_AGO },
    ],
  });
  return { org, owner, sale1, sale2 };
}

describe('/kpi/summary', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001 + BR-0004 + BR-0005: counts staff messages only, only confirmed orders', async () => {
    const { org, owner } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/summary?period=last7days',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    // 4 staff messages with repliedByUserId; 2 auto-reply excluded
    expect(body.summary.messagesSent.current).toBe(4);
    expect(body.summary.messagesReceived.current).toBe(2);
    expect(body.summary.newContacts.current).toBe(3); // 2 new + 1 converted both created in range
    expect(body.summary.convertedContacts.current).toBe(1);
    // 3 counted orders (paid + paid + completed); cancelled + new excluded
    expect(body.summary.ordersCount.current).toBe(3);
    expect(body.summary.revenue.current).toBe(35_000_000);
    await app.close();
  });

  it('returns delta=null when previous period is empty', async () => {
    const { org, owner } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/summary?period=last7days',
    });
    const body = JSON.parse(res.payload);
    // Previous 7 days had nothing seeded
    expect(body.summary.revenue.previous).toBe(0);
    expect(body.summary.revenue.delta).toBeNull();
    await app.close();
  });

  it('AC-0004: member is rejected with 403', async () => {
    const { org, sale1 } = await seedRich();
    const app = await buildApp({ id: sale1.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/summary?period=last7days',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0003: custom range > 365 days → 400', async () => {
    const { org, owner } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/summary?period=custom&from=2024-01-01&to=2026-01-01',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0005: cross-org isolation', async () => {
    const { owner: ownerA } = await seedRich();
    // Seed org B with extra orders
    const orgB = await prisma.organization.create({ data: { name: 'B' } });
    const ownerB = await prisma.user.create({
      data: {
        orgId: orgB.id,
        email: `b-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'B',
        role: 'owner',
      },
    });
    const contactB = await prisma.contact.create({
      data: { orgId: orgB.id, fullName: 'BKhách' },
    });
    await prisma.order.create({
      data: {
        orgId: orgB.id,
        contactId: contactB.id,
        createdByUserId: ownerB.id,
        orderCode: 'BX',
        totalAmount: 999_999_999,
        status: 'paid',
        createdAt: TWO_DAYS_AGO,
      },
    });
    const app = await buildApp({ id: ownerA.id, orgId: (await prisma.user.findUnique({ where: { id: ownerA.id } }))!.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/summary?period=last7days',
    });
    const body = JSON.parse(res.payload);
    // Org A's revenue is 35M; org B's huge order must not leak
    expect(body.summary.revenue.current).toBe(35_000_000);
    await app.close();
  });

  it('rejects invalid period with 400', async () => {
    const { org, owner } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/summary?period=forever',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('/kpi/leaderboard', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0002: revenue leaderboard ranks Lan first (30M), Bình second (5M)', async () => {
    const { org, owner, sale1, sale2 } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?period=last7days&metric=revenue',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].userId).toBe(sale1.id);
    expect(body.rows[0].value).toBe(30_000_000);
    expect(body.rows[0].rank).toBe(1);
    expect(body.rows[1].userId).toBe(sale2.id);
    expect(body.rows[1].value).toBe(5_000_000);
    expect(body.rows[1].rank).toBe(2);
    await app.close();
  });

  it('messagesSent leaderboard: Lan 3 > Bình 1; auto-reply excluded', async () => {
    const { org, owner, sale1, sale2 } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?period=last7days&metric=messagesSent',
    });
    const body = JSON.parse(res.payload);
    expect(body.rows[0].userId).toBe(sale1.id);
    expect(body.rows[0].value).toBe(3);
    expect(body.rows[1].userId).toBe(sale2.id);
    expect(body.rows[1].value).toBe(1);
    await app.close();
  });

  it('newContacts leaderboard counts assignedUserId', async () => {
    const { org, owner, sale1, sale2 } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?period=last7days&metric=newContacts',
    });
    const body = JSON.parse(res.payload);
    expect(body.rows[0].userId).toBe(sale1.id); // 2 contacts
    expect(body.rows[0].value).toBe(2);
    expect(body.rows[1].userId).toBe(sale2.id); // 1 contact
    expect(body.rows[1].value).toBe(1);
    await app.close();
  });

  it('member access → 403', async () => {
    const { org, sale1 } = await seedRich();
    const app = await buildApp({ id: sale1.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?period=last7days&metric=revenue',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects invalid metric', async () => {
    const { org, owner } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?metric=karma',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects limit out of bounds', async () => {
    const { org, owner } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?metric=revenue&limit=0',
    });
    expect(res1.statusCode).toBe(400);
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?metric=revenue&limit=999',
    });
    expect(res2.statusCode).toBe(400);
    await app.close();
  });

  it('returns empty rows when nothing matched', async () => {
    const { org, owner } = await seedRich();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    // Custom range with no activity
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/kpi/leaderboard?period=custom&from=2020-01-01&to=2020-01-02&metric=revenue',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).rows).toEqual([]);
    await app.close();
  });
});
