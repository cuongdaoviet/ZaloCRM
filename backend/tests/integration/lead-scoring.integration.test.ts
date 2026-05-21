/**
 * Integration tests for feature 0040 — lead scoring (rules-based, phase 1).
 * Covers AC-0001..AC-0010 from docs/features/0040-lead-scoring/SPEC.md.
 *
 * Boots an ephemeral Postgres via testcontainers, exercises the real
 * contact-routes handler against real Prisma queries.
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
  const { contactRoutes } = await import(
    '../../src/modules/contacts/contact-routes.js'
  );
  await app.register(contactRoutes);
  return app;
}

interface Seed {
  orgId: string;
  ownerId: string;
  memberId: string;
  zaloAccountId: string;
}

async function seedOrg(label: string): Promise<Seed> {
  const org = await prisma.organization.create({ data: { name: `${label} Org` } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: `Owner ${label}`,
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: `Member ${label}`,
      role: 'member',
    },
  });
  const zaloAccount = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
  });
  return {
    orgId: org.id,
    ownerId: owner.id,
    memberId: member.id,
    zaloAccountId: zaloAccount.id,
  };
}

async function seedContactWithConversation(
  seed: Seed,
  opts: {
    fullName?: string;
    status?: string | null;
    inboundAges?: Array<{ hoursAgo: number }>;
    appointmentDaysAhead?: number | null;
  } = {},
): Promise<{ contactId: string; conversationId: string }> {
  const contact = await prisma.contact.create({
    data: {
      orgId: seed.orgId,
      fullName: opts.fullName ?? 'Test Contact',
      status: opts.status === undefined ? 'new' : opts.status,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      orgId: seed.orgId,
      zaloAccountId: seed.zaloAccountId,
      contactId: contact.id,
      externalThreadId: `t-${contact.id}`,
    },
  });
  const now = Date.now();
  for (const m of opts.inboundAges ?? []) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'contact',
        content: 'hi',
        sentAt: new Date(now - m.hoursAgo * 60 * 60 * 1000),
      },
    });
  }
  if (opts.appointmentDaysAhead != null) {
    await prisma.appointment.create({
      data: {
        orgId: seed.orgId,
        contactId: contact.id,
        appointmentDate: new Date(now + opts.appointmentDaysAhead * 24 * 60 * 60 * 1000),
        status: 'scheduled',
      },
    });
  }
  return { contactId: contact.id, conversationId: conversation.id };
}

describe('Lead scoring (feature 0040)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0002: GET /contacts items include leadScore 0-100', async () => {
    const seed = await seedOrg('A');
    await seedContactWithConversation(seed, { status: 'new' });
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.contacts).toHaveLength(1);
    const c = body.contacts[0];
    expect(c).toHaveProperty('leadScore');
    expect(typeof c.leadScore).toBe('number');
    expect(c.leadScore).toBeGreaterThanOrEqual(0);
    expect(c.leadScore).toBeLessThanOrEqual(100);
    expect(c).toHaveProperty('leadScoreBreakdown');
    await app.close();
  });

  it('AC-0003: GET /contacts/:id includes leadScoreBreakdown object', async () => {
    const seed = await seedOrg('B');
    const { contactId } = await seedContactWithConversation(seed, { status: 'interested' });
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts/${contactId}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.leadScoreBreakdown).toEqual({
      recency: 0,
      engagement: 0,
      status: 20,
      appointment: 0,
    });
    expect(body.leadScore).toBe(20);
    await app.close();
  });

  it('AC-0004: 30min inbound + 5 inbound msgs + interested + 3d appt → score 75', async () => {
    const seed = await seedOrg('C');
    const { contactId } = await seedContactWithConversation(seed, {
      status: 'interested',
      inboundAges: [
        { hoursAgo: 0.5 }, // last inbound 30 min ago → 40
        { hoursAgo: 1 },
        { hoursAgo: 2 },
        { hoursAgo: 3 },
        { hoursAgo: 4 },
      ], // 5 inbound in last 30d → 5
      appointmentDaysAhead: 3, // → 10
    });
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts/${contactId}` });
    const body = JSON.parse(res.payload);
    expect(body.leadScoreBreakdown).toEqual({
      recency: 40,
      engagement: 5,
      status: 20,
      appointment: 10,
    });
    expect(body.leadScore).toBe(75);
    await app.close();
  });

  it('AC-0005: converted contact scores 0 on status regardless of other components', async () => {
    const seed = await seedOrg('D');
    const { contactId } = await seedContactWithConversation(seed, {
      status: 'converted',
      inboundAges: [{ hoursAgo: 0.5 }, { hoursAgo: 1 }],
      appointmentDaysAhead: 2,
    });
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts/${contactId}` });
    const body = JSON.parse(res.payload);
    expect(body.leadScoreBreakdown.status).toBe(0);
    // Other components still count.
    expect(body.leadScoreBreakdown.recency).toBe(40);
    expect(body.leadScoreBreakdown.appointment).toBe(10);
    await app.close();
  });

  it('AC-0006: sort by leadScore desc orders hottest first', async () => {
    const seed = await seedOrg('E');
    // Cold contact: no inbound, status=new (=5)
    const cold = await seedContactWithConversation(seed, {
      fullName: 'Cold',
      status: 'new',
    });
    // Hot contact: recent inbound + interested + appointment (=75)
    const hot = await seedContactWithConversation(seed, {
      fullName: 'Hot',
      status: 'interested',
      inboundAges: [{ hoursAgo: 0.5 }],
      appointmentDaysAhead: 3,
    });
    // Warm: contacted + appointment 10 days out
    const warm = await seedContactWithConversation(seed, {
      fullName: 'Warm',
      status: 'contacted',
      inboundAges: [{ hoursAgo: 5 }],
      appointmentDaysAhead: 10,
    });

    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts?sort=leadScore&order=desc',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const ids = body.contacts.map((c: { id: string }) => c.id);
    expect(ids[0]).toBe(hot.contactId);
    expect(ids[2]).toBe(cold.contactId);
    // warm in between
    expect(ids[1]).toBe(warm.contactId);
    await app.close();
  });

  it('AC-0007: PUT /settings/lead-score-config (admin) persists config', async () => {
    const seed = await seedOrg('F');
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'admin' });
    const newConfig = {
      recencyBuckets: [
        { hours: 1, points: 50 },
        { hours: 24, points: 25 },
      ],
      engagementCap: 20,
      statusPoints: { interested: 30, new: 10 },
      appointmentBuckets: [{ daysWindow: 7, points: 15 }],
    };

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/lead-score-config',
      payload: newConfig,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.isCustom).toBe(true);
    expect(body.config.engagementCap).toBe(20);

    // Verify the GET returns the same shape after persistence.
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/lead-score-config',
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.payload);
    expect(getBody.isCustom).toBe(true);
    expect(getBody.config.engagementCap).toBe(20);
    expect(getBody.config.recencyBuckets[0].points).toBe(50);
    await app.close();
  });

  it('AC-0008: PUT /settings/lead-score-config as member → 403', async () => {
    const seed = await seedOrg('G');
    const app = await buildApp({ id: seed.memberId, orgId: seed.orgId, role: 'member' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/lead-score-config',
      payload: { engagementCap: 10 },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0009: PUT /settings/lead-score-config invalid (negative weight) → 400', async () => {
    const seed = await seedOrg('H');
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/lead-score-config',
      payload: {
        recencyBuckets: [{ hours: 1, points: -10 }],
        engagementCap: 30,
        statusPoints: { interested: 20 },
        appointmentBuckets: [{ daysWindow: 7, points: 10 }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toMatch(/âm|negative/i);
    await app.close();
  });

  it('GET /settings/lead-score-config returns defaults when org has no custom config', async () => {
    const seed = await seedOrg('I');
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/lead-score-config',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.isCustom).toBe(false);
    expect(body.config.engagementCap).toBe(30);
    expect(body.defaults).toBeDefined();
    await app.close();
  });

  it('AC-0010: batch compute 100 contacts < 200ms (BR-0010)', async () => {
    const seed = await seedOrg('J');
    // Seed 100 contacts with ~10 inbound messages each (1000 messages total).
    // Use a single big insert via createMany to keep setup fast.
    const contactRows = Array.from({ length: 100 }, (_, i) => ({
      orgId: seed.orgId,
      fullName: `C${i}`,
      status: i % 5 === 0 ? 'interested' : i % 5 === 1 ? 'contacted' : 'new',
    }));
    await prisma.contact.createMany({ data: contactRows });
    const contacts = await prisma.contact.findMany({ where: { orgId: seed.orgId } });
    expect(contacts).toHaveLength(100);

    // One conversation per contact.
    const conversationRows = contacts.map((c, i) => ({
      orgId: seed.orgId,
      zaloAccountId: seed.zaloAccountId,
      contactId: c.id,
      externalThreadId: `perf-${i}`,
    }));
    await prisma.conversation.createMany({ data: conversationRows });
    const conversations = await prisma.conversation.findMany({
      where: { orgId: seed.orgId },
    });

    // 10 inbound messages per conversation = 1000 messages total.
    const now = Date.now();
    const messageRows = [];
    for (const conv of conversations) {
      for (let j = 0; j < 10; j++) {
        messageRows.push({
          conversationId: conv.id,
          senderType: 'contact',
          content: 'm',
          sentAt: new Date(now - j * 60 * 60 * 1000),
        });
      }
    }
    await prisma.message.createMany({ data: messageRows });

    const { computeLeadScoresBatch, DEFAULT_LEAD_SCORE_CONFIG } = await import(
      '../../src/modules/contacts/lead-score-service.js'
    );
    const ids = contacts.map((c) => c.id);
    // Warm-up — the very first $queryRaw on a fresh pool pays one-time costs
    // (prepared statement creation, JIT, etc.) that aren't representative of
    // steady-state list-endpoint latency.
    await computeLeadScoresBatch(ids, DEFAULT_LEAD_SCORE_CONFIG);
    const t0 = Date.now();
    const scores = await computeLeadScoresBatch(ids, DEFAULT_LEAD_SCORE_CONFIG);
    const elapsed = Date.now() - t0;
    expect(scores.size).toBe(100);
    // BR-0010 perf target. Log even when we pass so the PR has evidence.
    console.log(`[perf] batch compute 100 contacts / 1000 msgs: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(200);
  });

  it('EC-0001: contact with no inbound + status=new → score=5', async () => {
    const seed = await seedOrg('K');
    const { contactId } = await seedContactWithConversation(seed, {
      status: 'new',
      inboundAges: [],
    });
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: `/api/v1/contacts/${contactId}` });
    const body = JSON.parse(res.payload);
    expect(body.leadScore).toBe(5);
    expect(body.leadScoreBreakdown).toEqual({
      recency: 0,
      engagement: 0,
      status: 5,
      appointment: 0,
    });
    await app.close();
  });

  it('EC-0002: merged contact excluded from list (and not scored)', async () => {
    const seed = await seedOrg('L');
    const primary = await seedContactWithConversation(seed, {
      fullName: 'Primary',
      status: 'interested',
    });
    const merged = await prisma.contact.create({
      data: {
        orgId: seed.orgId,
        fullName: 'Merged',
        status: 'new',
        mergedIntoId: primary.contactId,
        mergedAt: new Date(),
      },
    });

    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
    const body = JSON.parse(res.payload);
    const ids = body.contacts.map((c: { id: string }) => c.id);
    expect(ids).toContain(primary.contactId);
    expect(ids).not.toContain(merged.id);
    await app.close();
  });

  it('DELETE /settings/lead-score-config resets to default', async () => {
    const seed = await seedOrg('M');
    const app = await buildApp({ id: seed.ownerId, orgId: seed.orgId, role: 'owner' });

    // Set a custom config first.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/lead-score-config',
      payload: {
        recencyBuckets: [{ hours: 1, points: 50 }],
        engagementCap: 10,
        statusPoints: { interested: 25 },
        appointmentBuckets: [{ daysWindow: 7, points: 5 }],
      },
    });

    const delRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/settings/lead-score-config',
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.payload).isCustom).toBe(false);

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/lead-score-config',
    });
    expect(JSON.parse(getRes.payload).isCustom).toBe(false);
    await app.close();
  });
});
