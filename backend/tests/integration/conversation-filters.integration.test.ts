/**
 * Integration tests for Feature 0022 — Conversation filters.
 *
 * Covers GET /api/v1/conversations filter params (unread, unreplied,
 * dateFrom/dateTo, tags) and the new /counts aggregate endpoint. Tests
 * member ACL, cross-org isolation, and tag filter via the ContactTag
 * junction (Phase 0019-C).
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
vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 'test-user', orgId: 'org-stub', role: 'admin' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

interface SeedResult {
  orgId: string;
  userId: string;
  accountId: string;
  contacts: { id: string; name: string }[];
  conversations: {
    id: string;
    name: string;
    unreadCount: number;
    isReplied: boolean;
    lastMessageAt: Date;
  }[];
  tags: { id: string; name: string }[];
}

/**
 * Seed a single org / account / user with 4 contacts + 4 conversations and
 * two tags. Each conversation has distinct flags so each filter can be
 * verified independently:
 *
 *   conv-A → unreadCount=3, isReplied=true,  lastMsg=today      (Khách A, tagged "vip")
 *   conv-B → unreadCount=0, isReplied=false, lastMsg=10 days ago (Khách B, tagged "hot")
 *   conv-C → unreadCount=2, isReplied=false, lastMsg=today      (Khách C, no tags)
 *   conv-D → unreadCount=0, isReplied=true,  lastMsg=60 days ago (Khách D, no tags)
 */
async function seed(): Promise<SeedResult> {
  const org = await prisma.organization.create({ data: { name: 'Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Admin',
      role: 'admin',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: user.id, status: 'connected' },
  });

  const tagVip = await prisma.crmTag.create({
    data: { orgId: org.id, name: 'VIP', normalizedName: 'vip', color: '#FFD700' },
  });
  const tagHot = await prisma.crmTag.create({
    data: { orgId: org.id, name: 'Hot', normalizedName: 'hot', color: '#FF5722' },
  });

  const contactA = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Khách A', phone: '0900000001', zaloUid: 'zA' },
  });
  const contactB = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Khách B', phone: '0900000002', zaloUid: 'zB' },
  });
  const contactC = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Khách C', phone: '0900000003', zaloUid: 'zC' },
  });
  const contactD = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Khách D', phone: '0900000004', zaloUid: 'zD' },
  });

  await prisma.contactTag.createMany({
    data: [
      { contactId: contactA.id, tagId: tagVip.id },
      { contactId: contactB.id, tagId: tagHot.id },
    ],
  });

  const today = new Date();
  const tenDaysAgo = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);

  const convA = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contactA.id,
      threadType: 'user',
      externalThreadId: 'zA',
      unreadCount: 3,
      isReplied: true,
      lastMessageAt: today,
    },
  });
  const convB = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contactB.id,
      threadType: 'user',
      externalThreadId: 'zB',
      unreadCount: 0,
      isReplied: false,
      lastMessageAt: tenDaysAgo,
    },
  });
  const convC = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contactC.id,
      threadType: 'user',
      externalThreadId: 'zC',
      unreadCount: 2,
      isReplied: false,
      lastMessageAt: today,
    },
  });
  const convD = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contactD.id,
      threadType: 'user',
      externalThreadId: 'zD',
      unreadCount: 0,
      isReplied: true,
      lastMessageAt: sixtyDaysAgo,
    },
  });

  return {
    orgId: org.id,
    userId: user.id,
    accountId: account.id,
    contacts: [
      { id: contactA.id, name: 'Khách A' },
      { id: contactB.id, name: 'Khách B' },
      { id: contactC.id, name: 'Khách C' },
      { id: contactD.id, name: 'Khách D' },
    ],
    conversations: [
      { id: convA.id, name: 'A', unreadCount: 3, isReplied: true, lastMessageAt: today },
      { id: convB.id, name: 'B', unreadCount: 0, isReplied: false, lastMessageAt: tenDaysAgo },
      { id: convC.id, name: 'C', unreadCount: 2, isReplied: false, lastMessageAt: today },
      { id: convD.id, name: 'D', unreadCount: 0, isReplied: true, lastMessageAt: sixtyDaysAgo },
    ],
    tags: [
      { id: tagVip.id, name: 'VIP' },
      { id: tagHot.id, name: 'Hot' },
    ],
  };
}

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

function idsOf(payload: string): string[] {
  const body = JSON.parse(payload);
  return (body.conversations as Array<{ id: string }>).map((c) => c.id).sort();
}

function ymd(date: Date): string {
  // Format YYYY-MM-DD for use as a date-only query param.
  return date.toISOString().slice(0, 10);
}

describe('GET /api/v1/conversations — filter params (feature 0022)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: ?unread=1 returns only conversations with unreadCount > 0', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations?unread=1' });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    const expected = [seeded.conversations[0].id, seeded.conversations[2].id].sort();
    expect(ids).toEqual(expected);
    await app.close();
  });

  it('AC-0001: ?unread=true accepted as alias for "1"', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations?unread=true' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(2);
    await app.close();
  });

  it('AC-0002: ?unreplied=1 returns only convs where isReplied = false', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations?unreplied=1' });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    const expected = [seeded.conversations[1].id, seeded.conversations[2].id].sort();
    expect(ids).toEqual(expected);
    await app.close();
  });

  it('AC-0003: combined ?unread=1&unreplied=1 narrows AND-style', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations?unread=1&unreplied=1',
    });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    expect(ids).toEqual([seeded.conversations[2].id]);
    await app.close();
  });

  it('AC-0004: ?dateFrom + ?dateTo bounds lastMessageAt inclusively', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations?dateFrom=${ymd(sevenDaysAgo)}&dateTo=${ymd(today)}`,
    });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    // Only A and C are inside the last 7 days; B (10d), D (60d) excluded.
    const expected = [seeded.conversations[0].id, seeded.conversations[2].id].sort();
    expect(ids).toEqual(expected);
    await app.close();
  });

  it('AC-0004: legacy ?from / ?to aliases work the same as dateFrom/dateTo', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations?from=${ymd(sevenDaysAgo)}&to=${ymd(today)}`,
    });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    expect(ids).toHaveLength(2);
    await app.close();
  });

  it('AC-0005: invalid dateFrom → 400', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations?dateFrom=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/dateFrom/);
    await app.close();
  });

  it('AC-0006: ?tags=<id> filters by ContactTag junction (single tag)', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations?tags=${seeded.tags[0].id}`,
    });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    // Tag VIP is attached to contact A → conv A only
    expect(ids).toEqual([seeded.conversations[0].id]);
    await app.close();
  });

  it('AC-0006: ?tags=<id1>,<id2> CSV form (OR semantics within tags)', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const csv = `${seeded.tags[0].id},${seeded.tags[1].id}`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations?tags=${csv}`,
    });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    const expected = [seeded.conversations[0].id, seeded.conversations[1].id].sort();
    expect(ids).toEqual(expected);
    await app.close();
  });

  it('AC-0007: filters compose with existing `search` param', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    // unreplied=1 narrows to {B, C}; search="Khách C" further narrows to {C}.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations?unreplied=1&search=${encodeURIComponent('Khách C')}`,
    });
    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.payload);
    expect(ids).toEqual([seeded.conversations[2].id]);
    await app.close();
  });

  it('AC-0008: member ACL still applies — filters do not bypass it', async () => {
    const seeded = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: seeded.orgId,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    // Member has NO access to the seeded account → should see no conversations
    // even though ?unread=1 would match.
    const app = await buildApp({ id: member.id, orgId: seeded.orgId, role: 'member' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations?unread=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(0);
    expect(body.total).toBe(0);
    await app.close();
  });

  it('AC-0008b: member with access still gets filtered list', async () => {
    const seeded = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: seeded.orgId,
        email: `m-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: seeded.accountId, userId: member.id, permission: 'chat' },
    });
    const app = await buildApp({ id: member.id, orgId: seeded.orgId, role: 'member' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations?unread=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(2);
    await app.close();
  });

  it('AC-0009: cross-org isolation — another org never sees these convs', async () => {
    const seeded = await seed();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other' } });
    const otherUser = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `o-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'Other Admin',
        role: 'admin',
      },
    });
    const app = await buildApp({ id: otherUser.id, orgId: otherOrg.id, role: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations?unread=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(0);
    // Seeded conversations belong to a different org — must not leak.
    expect(seeded.conversations.length).toBeGreaterThan(0);
    await app.close();
  });

  it('AC-0010: no filter params → returns all conversations (back-compat)', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(4);
    expect(body.total).toBe(4);
    await app.close();
  });
});

describe('GET /api/v1/conversations/counts (feature 0022)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0011: returns { unread, unreplied, total } for the org', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/counts' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // Feature 0023 added `mainUnread` / `otherUnread` to the counts shape.
    // All four seeded conversations default to tab='main', so mainUnread = unread.
    expect(body).toEqual({
      unread: 2, unreplied: 2, total: 4,
      mainUnread: 2, otherUnread: 0,
    });
    await app.close();
  });

  it('AC-0011b: counts route does NOT collide with /:id', async () => {
    // If route ordering breaks, /counts would be parsed as :id and 404.
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/counts' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toHaveProperty('unread');
    await app.close();
  });

  it('AC-0011c: accountId filter scopes counts', async () => {
    const seeded = await seed();
    // A second Zalo account with one extra conversation
    const account2 = await prisma.zaloAccount.create({
      data: { orgId: seeded.orgId, ownerUserId: seeded.userId, status: 'connected' },
    });
    const extraContact = await prisma.contact.create({
      data: { orgId: seeded.orgId, fullName: 'Khách E', zaloUid: 'zE' },
    });
    await prisma.conversation.create({
      data: {
        orgId: seeded.orgId,
        zaloAccountId: account2.id,
        contactId: extraContact.id,
        threadType: 'user',
        externalThreadId: 'zE',
        unreadCount: 5,
        isReplied: false,
        lastMessageAt: new Date(),
      },
    });
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/counts?accountId=${account2.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      unread: 1, unreplied: 1, total: 1,
      mainUnread: 1, otherUnread: 0,
    });
    await app.close();
  });

  it('AC-0012: counts respect member ACL', async () => {
    const seeded = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: seeded.orgId,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    // No ZaloAccountAccess row → member sees nothing.
    const app = await buildApp({ id: member.id, orgId: seeded.orgId, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/counts' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      unread: 0, unreplied: 0, total: 0,
      mainUnread: 0, otherUnread: 0,
    });
    await app.close();
  });

  it('AC-0013: counts respect cross-org isolation', async () => {
    await seed();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other' } });
    const otherUser = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `o-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'Other Admin',
        role: 'admin',
      },
    });
    const app = await buildApp({ id: otherUser.id, orgId: otherOrg.id, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/counts' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      unread: 0, unreplied: 0, total: 0,
      mainUnread: 0, otherUnread: 0,
    });
    await app.close();
  });
});
