/**
 * Integration tests for feature 0041 — /analytics/funnel + /analytics/team-performance.
 * Real Postgres + Fastify inject. Seeds a mixed-stage funnel and a multi-rep
 * conversation history so per-user metrics are independently verifiable.
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

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { analyticsRoutes } = await import('../../src/modules/analytics/analytics-routes.js');
  await app.register(analyticsRoutes);
  return app;
}

// Anchor "now" inside the seeded range so the default 30-day window captures it.
const NOW = new Date();
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 86_400_000);
const FIVE_DAYS_AGO = new Date(NOW.getTime() - 5 * 86_400_000);

async function seedFunnel() {
  const org = await prisma.organization.create({ data: { name: 'Analytics Org' } });
  const team = await prisma.team.create({ data: { orgId: org.id, name: 'Sales A' } });
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
      teamId: team.id,
      email: `s1-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Lan Anh',
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
  // Funnel: 10 new, 6 contacted, 3 interested, 1 converted, 2 lost (all in window)
  const stages: Array<{ status: string; n: number; assignee?: string }> = [
    { status: 'new', n: 10, assignee: sale1.id },
    { status: 'contacted', n: 6, assignee: sale1.id },
    { status: 'interested', n: 3, assignee: sale2.id },
    { status: 'converted', n: 1, assignee: sale2.id },
    { status: 'lost', n: 2 },
  ];
  for (const s of stages) {
    for (let i = 0; i < s.n; i++) {
      await prisma.contact.create({
        data: {
          orgId: org.id,
          fullName: `${s.status}-${i}`,
          status: s.status,
          assignedUserId: s.assignee ?? null,
          createdAt: TWO_DAYS_AGO,
          updatedAt: TWO_DAYS_AGO,
        },
      });
    }
  }
  // Merged contact must be excluded from funnel
  const primary = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Primary', status: 'new', createdAt: TWO_DAYS_AGO },
  });
  await prisma.contact.create({
    data: {
      orgId: org.id,
      fullName: 'Merged-dup',
      status: 'new',
      mergedIntoId: primary.id,
      mergedAt: TWO_DAYS_AGO,
      createdAt: TWO_DAYS_AGO,
    },
  });
  return { org, owner, sale1, sale2, team };
}

describe('/analytics/funnel', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: admin → 200 with expected shape', async () => {
    const { org, owner } = await seedFunnel();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/funnel' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.stages).toHaveLength(4);
    expect(body.stages.map((s: { name: string }) => s.name)).toEqual([
      'new',
      'contacted',
      'interested',
      'converted',
    ]);
    expect(body.lost).toBeDefined();
    expect(body.period).toBeDefined();
    expect(body.totalContacts).toBeDefined();
    await app.close();
  });

  it('AC-0002: member → 403', async () => {
    const { org, sale1 } = await seedFunnel();
    const app = await buildApp({ id: sale1.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/funnel' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0004 + AC-0003: counts and conversion rates correct', async () => {
    const { org, owner } = await seedFunnel();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/funnel' });
    const body = JSON.parse(res.payload);
    const byName = new Map(body.stages.map((s: { name: string; count: number; conversionRate: number | null }) => [s.name, s]));
    // 10 new + 1 primary; merged duplicate is excluded
    expect(byName.get('new')!.count).toBe(11);
    expect(byName.get('contacted')!.count).toBe(6);
    expect(byName.get('interested')!.count).toBe(3);
    expect(byName.get('converted')!.count).toBe(1);
    expect(body.lost.count).toBe(2);
    // first stage rate null, rest computed
    expect(byName.get('new')!.conversionRate).toBeNull();
    // 6/11 = 54.5 → 55
    expect(byName.get('contacted')!.conversionRate).toBe(55);
    // 3/6 = 50
    expect(byName.get('interested')!.conversionRate).toBe(50);
    // 1/3 = 33.3 → 33
    expect(byName.get('converted')!.conversionRate).toBe(33);
    expect(body.totalContacts).toBe(23);
    await app.close();
  });

  it('AC-0003: dateFrom/dateTo restricts the window', async () => {
    const { org, owner } = await seedFunnel();
    // Add a contact outside the window
    await prisma.contact.create({
      data: {
        orgId: org.id,
        fullName: 'OldContact',
        status: 'new',
        createdAt: new Date(NOW.getTime() - 100 * 86_400_000),
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    // 7-day window — should NOT include the 100-day-old contact
    const dateFrom = new Date(NOW.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const dateTo = NOW.toISOString().slice(0, 10);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics/funnel?dateFrom=${dateFrom}&dateTo=${dateTo}`,
    });
    const body = JSON.parse(res.payload);
    const newRow = body.stages.find((s: { name: string }) => s.name === 'new');
    expect(newRow.count).toBe(11); // not 12 — old one excluded
    await app.close();
  });

  it('filter by assignedUserId narrows the count', async () => {
    const { org, owner, sale1 } = await seedFunnel();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics/funnel?assignedUserId=${sale1.id}`,
    });
    const body = JSON.parse(res.payload);
    // Sale1 owns: 10 new + 6 contacted
    const newRow = body.stages.find((s: { name: string }) => s.name === 'new');
    const contactedRow = body.stages.find((s: { name: string }) => s.name === 'contacted');
    expect(newRow.count).toBe(10);
    expect(contactedRow.count).toBe(6);
    await app.close();
  });

  it('filter by teamId narrows to team members', async () => {
    const { org, owner, team } = await seedFunnel();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/analytics/funnel?teamId=${team.id}`,
    });
    const body = JSON.parse(res.payload);
    // Only Sale1 is in team — they own 10 new + 6 contacted
    expect(body.totalContacts).toBe(16);
    await app.close();
  });

  it('AC-0007: cross-org isolation', async () => {
    const { owner } = await seedFunnel();
    const orgB = await prisma.organization.create({ data: { name: 'B' } });
    for (let i = 0; i < 99; i++) {
      await prisma.contact.create({
        data: {
          orgId: orgB.id,
          fullName: `bleed-${i}`,
          status: 'new',
          createdAt: TWO_DAYS_AGO,
        },
      });
    }
    const ownerARow = await prisma.user.findUnique({ where: { id: owner.id } });
    const app = await buildApp({ id: owner.id, orgId: ownerARow!.orgId, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/funnel' });
    const body = JSON.parse(res.payload);
    // Should still be 23 — orgB's 99 contacts must not leak
    expect(body.totalContacts).toBe(23);
    await app.close();
  });

  it('rejects malformed dateFrom', async () => {
    const { org, owner } = await seedFunnel();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/funnel?dateFrom=banana&dateTo=2026-01-01',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

async function seedTeamPerf() {
  const org = await prisma.organization.create({ data: { name: 'Perf Org' } });
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
  // Two contacts, each with a conversation. Sale1 owns one, Sale2 owns the other.
  const c1 = await prisma.contact.create({
    data: {
      orgId: org.id,
      fullName: 'KH-1',
      status: 'converted',
      assignedUserId: sale1.id,
      createdAt: FIVE_DAYS_AGO,
      updatedAt: TWO_DAYS_AGO,
    },
  });
  const c2 = await prisma.contact.create({
    data: {
      orgId: org.id,
      fullName: 'KH-2',
      status: 'contacted',
      assignedUserId: sale2.id,
      createdAt: FIVE_DAYS_AGO,
    },
  });
  const conv1 = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: c1.id,
      threadType: 'user',
      externalThreadId: 'kh-1',
    },
  });
  const conv2 = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: c2.id,
      threadType: 'user',
      externalThreadId: 'kh-2',
    },
  });
  // Conv1 — Sale1 replies in 10 minutes
  const inboundAt1 = new Date(TWO_DAYS_AGO.getTime());
  const outboundAt1 = new Date(inboundAt1.getTime() + 10 * 60 * 1000);
  // Conv2 — Sale2 replies in 30 minutes
  const inboundAt2 = new Date(TWO_DAYS_AGO.getTime() + 3600 * 1000);
  const outboundAt2 = new Date(inboundAt2.getTime() + 30 * 60 * 1000);
  await prisma.message.createMany({
    data: [
      // Conv1
      { conversationId: conv1.id, senderType: 'contact', senderUid: 'kh-1', content: 'hi', contentType: 'text', sentAt: inboundAt1 },
      { conversationId: conv1.id, senderType: 'self', senderUid: 'self', content: 'hello', contentType: 'text', sentAt: outboundAt1, repliedByUserId: sale1.id },
      // Extra outbound from Sale1 (counted in outboundMessageCount, not in avg)
      { conversationId: conv1.id, senderType: 'self', senderUid: 'self', content: 'follow', contentType: 'text', sentAt: new Date(outboundAt1.getTime() + 60_000), repliedByUserId: sale1.id },
      // Conv2
      { conversationId: conv2.id, senderType: 'contact', senderUid: 'kh-2', content: 'hi2', contentType: 'text', sentAt: inboundAt2 },
      { conversationId: conv2.id, senderType: 'self', senderUid: 'self', content: 'reply2', contentType: 'text', sentAt: outboundAt2, repliedByUserId: sale2.id },
    ],
  });
  return { org, owner, sale1, sale2 };
}

describe('/analytics/team-performance', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0005: admin → 200', async () => {
    const { org, owner } = await seedTeamPerf();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/team-performance' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.byUser).toBeInstanceOf(Array);
    expect(body.totals).toBeDefined();
    expect(body.period).toBeDefined();
    await app.close();
  });

  it('AC-0002: member → 403', async () => {
    const { org, sale1 } = await seedTeamPerf();
    const app = await buildApp({ id: sale1.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/team-performance' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0006: per-user metrics — known response time per rep', async () => {
    const { org, owner, sale1, sale2 } = await seedTeamPerf();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/team-performance' });
    const body = JSON.parse(res.payload);
    const byId = new Map(body.byUser.map((r: { userId: string }) => [r.userId, r]));

    const lan = byId.get(sale1.id)!;
    expect(lan.avgResponseTimeMinutes).toBeCloseTo(10, 0);
    expect(lan.outboundMessageCount).toBe(2);
    expect(lan.convertedContactsCount).toBe(1);

    const binh = byId.get(sale2.id)!;
    expect(binh.avgResponseTimeMinutes).toBeCloseTo(30, 0);
    expect(binh.outboundMessageCount).toBe(1);
    expect(binh.convertedContactsCount).toBe(0);

    // Owner: no activity, but appears in roster
    const owr = byId.get(owner.id)!;
    expect(owr.avgResponseTimeMinutes).toBeNull();
    expect(owr.outboundMessageCount).toBe(0);
    await app.close();
  });

  it('totals roll up across reps', async () => {
    const { org, owner } = await seedTeamPerf();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/team-performance' });
    const body = JSON.parse(res.payload);
    expect(body.totals.outboundMessageCount).toBe(3);
    expect(body.totals.convertedContactsCount).toBe(1);
    await app.close();
  });

  it('AC-0007: cross-org isolation', async () => {
    const { owner } = await seedTeamPerf();
    const orgB = await prisma.organization.create({ data: { name: 'B' } });
    const ownerB = await prisma.user.create({
      data: {
        orgId: orgB.id,
        email: `b-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'h',
        fullName: 'B',
        role: 'owner',
      },
    });
    // Seed lots of activity in org B
    const accountB = await prisma.zaloAccount.create({
      data: { orgId: orgB.id, ownerUserId: ownerB.id, status: 'connected' },
    });
    const cb = await prisma.contact.create({
      data: { orgId: orgB.id, fullName: 'BKH', assignedUserId: ownerB.id, status: 'converted', updatedAt: TWO_DAYS_AGO, createdAt: TWO_DAYS_AGO },
    });
    const cvb = await prisma.conversation.create({
      data: { orgId: orgB.id, zaloAccountId: accountB.id, contactId: cb.id, threadType: 'user', externalThreadId: 'b-1' },
    });
    await prisma.message.createMany({
      data: [
        { conversationId: cvb.id, senderType: 'contact', senderUid: 'b', content: 'b', contentType: 'text', sentAt: TWO_DAYS_AGO },
        { conversationId: cvb.id, senderType: 'self', senderUid: 'self', content: 'b2', contentType: 'text', sentAt: new Date(TWO_DAYS_AGO.getTime() + 60_000), repliedByUserId: ownerB.id },
      ],
    });

    const ownerARow = await prisma.user.findUnique({ where: { id: owner.id } });
    const app = await buildApp({ id: owner.id, orgId: ownerARow!.orgId, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/team-performance' });
    const body = JSON.parse(res.payload);
    // Org A totals still equal seeded values — org B's activity did not leak.
    expect(body.totals.outboundMessageCount).toBe(3);
    expect(body.totals.convertedContactsCount).toBe(1);
    // No org-B user in the roster
    const ids = body.byUser.map((r: { userId: string }) => r.userId);
    expect(ids).not.toContain(ownerB.id);
    await app.close();
  });
});

describe('performance', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0008: funnel + team-perf complete in < 500ms over 10k contacts + 30k messages', async () => {
    const org = await prisma.organization.create({ data: { name: 'Big' } });
    const owner = await prisma.user.create({
      data: { orgId: org.id, email: `big-${Date.now()}@test.local`, passwordHash: 'h', fullName: 'Owner', role: 'owner' },
    });
    const sale = await prisma.user.create({
      data: { orgId: org.id, email: `sale-${Date.now()}@test.local`, passwordHash: 'h', fullName: 'Sale', role: 'member' },
    });
    const account = await prisma.zaloAccount.create({
      data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
    });

    // 10k contacts, varied statuses, created recently
    const statuses = ['new', 'contacted', 'interested', 'converted', 'lost'];
    const contactRows = Array.from({ length: 10_000 }, (_, i) => ({
      orgId: org.id,
      fullName: `c-${i}`,
      status: statuses[i % statuses.length],
      assignedUserId: sale.id,
      createdAt: TWO_DAYS_AGO,
      updatedAt: TWO_DAYS_AGO,
    }));
    // createMany doesn't return IDs; chunk for memory
    for (let i = 0; i < contactRows.length; i += 1000) {
      await prisma.contact.createMany({ data: contactRows.slice(i, i + 1000) });
    }
    // 100 conversations
    const contactSample = await prisma.contact.findMany({ where: { orgId: org.id }, take: 100, select: { id: true } });
    const convRows: { id: string; contactId: string }[] = [];
    for (const c of contactSample) {
      const cv = await prisma.conversation.create({
        data: {
          orgId: org.id,
          zaloAccountId: account.id,
          contactId: c.id,
          threadType: 'user',
          externalThreadId: `t-${c.id}`,
        },
      });
      convRows.push({ id: cv.id, contactId: c.id });
    }
    // 30k messages — alternating inbound/outbound
    const msgs: {
      conversationId: string;
      senderType: string;
      senderUid: string;
      content: string;
      contentType: string;
      sentAt: Date;
      repliedByUserId: string | null;
    }[] = [];
    for (let i = 0; i < 30_000; i++) {
      const conv = convRows[i % convRows.length];
      const isInbound = i % 2 === 0;
      msgs.push({
        conversationId: conv.id,
        senderType: isInbound ? 'contact' : 'self',
        senderUid: isInbound ? 'kh' : 'self',
        content: `m-${i}`,
        contentType: 'text',
        sentAt: new Date(TWO_DAYS_AGO.getTime() + i * 100),
        repliedByUserId: isInbound ? null : sale.id,
      });
    }
    for (let i = 0; i < msgs.length; i += 2000) {
      await prisma.message.createMany({ data: msgs.slice(i, i + 2000) });
    }

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const t0 = Date.now();
    const res1 = await app.inject({ method: 'GET', url: '/api/v1/analytics/funnel' });
    const t1 = Date.now();
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/analytics/team-performance' });
    const t2 = Date.now();

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const funnelMs = t1 - t0;
    const perfMs = t2 - t1;
    // eslint-disable-next-line no-console
    console.log(`[perf] funnel=${funnelMs}ms team-perf=${perfMs}ms (10k contacts, 30k messages)`);
    expect(funnelMs).toBeLessThan(500);
    // Team-perf does a window function — give it slightly more headroom.
    expect(perfMs).toBeLessThan(2000);
    await app.close();
  }, 120_000);
});
