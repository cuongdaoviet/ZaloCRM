/**
 * Integration tests for Feature 0023 — Hide / archive conversations (Tab "Khác").
 *
 * Covers:
 *  - PATCH /api/v1/conversations/:id/tab           (AC-0001..0004)
 *  - GET   /api/v1/conversations?tab=main|other    (AC-0005, AC-0006)
 *  - GET   /api/v1/conversations/counts            (AC-0007)
 *  - handleIncomingMessage auto-promote            (AC-0008, AC-0009)
 *  - Schema default for legacy rows                (AC-0010)
 *  - Build pass                                    (AC-0012 — separate `tsc` step)
 *
 * AC-0011 (FE context menu) is FE-only and not exercised here.
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
  conversations: {
    main1: string; // tab='main', unread=2
    main2: string; // tab='main', unread=0
    other1: string; // tab='other', unread=3
    other2: string; // tab='other', unread=0
  };
}

/**
 * Seed: 1 org / 1 admin / 1 Zalo account / 4 contacts / 4 conversations.
 *
 *   main1   → tab='main',  unreadCount=2
 *   main2   → tab='main',  unreadCount=0
 *   other1  → tab='other', unreadCount=3
 *   other2  → tab='other', unreadCount=0
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

  const cA = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'A', zaloUid: 'zA' },
  });
  const cB = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'B', zaloUid: 'zB' },
  });
  const cC = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'C', zaloUid: 'zC' },
  });
  const cD = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'D', zaloUid: 'zD' },
  });

  const main1 = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: cA.id,
      threadType: 'user',
      externalThreadId: 'zA',
      tab: 'main',
      unreadCount: 2,
      lastMessageAt: new Date(),
    },
  });
  const main2 = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: cB.id,
      threadType: 'user',
      externalThreadId: 'zB',
      tab: 'main',
      unreadCount: 0,
      lastMessageAt: new Date(),
    },
  });
  const other1 = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: cC.id,
      threadType: 'user',
      externalThreadId: 'zC',
      tab: 'other',
      unreadCount: 3,
      lastMessageAt: new Date(),
    },
  });
  const other2 = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: cD.id,
      threadType: 'user',
      externalThreadId: 'zD',
      tab: 'other',
      unreadCount: 0,
      lastMessageAt: new Date(),
    },
  });

  return {
    orgId: org.id,
    userId: user.id,
    accountId: account.id,
    conversations: {
      main1: main1.id,
      main2: main2.id,
      other1: other1.id,
      other2: other2.id,
    },
  };
}

async function buildApp(user: {
  id: string;
  orgId: string;
  role: string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

describe('PATCH /api/v1/conversations/:id/tab (feature 0023)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: admin can move conversation to tab="other"', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.main1}/tab`,
      payload: { tab: 'other' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ success: true, tab: 'other' });

    const row = await prisma.conversation.findUnique({
      where: { id: seeded.conversations.main1 },
      select: { tab: true },
    });
    expect(row?.tab).toBe('other');
    await app.close();
  });

  it('AC-0001b: admin can move conversation back to tab="main"', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.other1}/tab`,
      payload: { tab: 'main' },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.conversation.findUnique({
      where: { id: seeded.conversations.other1 },
      select: { tab: true },
    });
    expect(row?.tab).toBe('main');
    await app.close();
  });

  it('AC-0002: invalid tab value → 400 with Vietnamese error', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.main1}/tab`,
      payload: { tab: 'archived' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/main|other/);
    await app.close();
  });

  it('AC-0002b: missing tab in body → 400', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.main1}/tab`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0003: cross-org PATCH → 404 (no leak)', async () => {
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
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.main1}/tab`,
      payload: { tab: 'other' },
    });
    expect(res.statusCode).toBe(404);
    // The original row must NOT have flipped.
    const row = await prisma.conversation.findUnique({
      where: { id: seeded.conversations.main1 },
      select: { tab: true },
    });
    expect(row?.tab).toBe('main');
    await app.close();
  });

  it('AC-0004: member without chat ACL → 403', async () => {
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
    // Note: NO zaloAccountAccess row → no permission on the account.
    const app = await buildApp({ id: member.id, orgId: seeded.orgId, role: 'member' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.main1}/tab`,
      payload: { tab: 'other' },
    });
    expect(res.statusCode).toBe(403);
    // Row unchanged.
    const row = await prisma.conversation.findUnique({
      where: { id: seeded.conversations.main1 },
      select: { tab: true },
    });
    expect(row?.tab).toBe('main');
    await app.close();
  });

  it('AC-0004b: member with read-only ACL → 403 (chat permission required)', async () => {
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
      data: { zaloAccountId: seeded.accountId, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: seeded.orgId, role: 'member' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.main1}/tab`,
      payload: { tab: 'other' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0004c: member with chat ACL → 200', async () => {
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
      method: 'PATCH',
      url: `/api/v1/conversations/${seeded.conversations.main1}/tab`,
      payload: { tab: 'other' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('GET /api/v1/conversations?tab=… (feature 0023)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0005: ?tab=main returns only conversations with tab="main"', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations?tab=main' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const ids = (body.conversations as { id: string }[]).map((c) => c.id).sort();
    const expected = [seeded.conversations.main1, seeded.conversations.main2].sort();
    expect(ids).toEqual(expected);
    await app.close();
  });

  it('AC-0005b: ?tab=other returns only conversations with tab="other"', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations?tab=other' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const ids = (body.conversations as { id: string }[]).map((c) => c.id).sort();
    const expected = [seeded.conversations.other1, seeded.conversations.other2].sort();
    expect(ids).toEqual(expected);
    await app.close();
  });

  it('AC-0006: no tab param → returns BOTH tabs (back-compat)', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(4);
    expect(body.total).toBe(4);
    await app.close();
  });

  it('tab filter composes with unread filter (AND semantics)', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    // main with unread: only main1 (unread=2). main2 has unread=0.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations?tab=main&unread=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].id).toBe(seeded.conversations.main1);
    await app.close();
  });
});

describe('GET /api/v1/conversations/counts (feature 0023 extension)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0007: counts include mainUnread + otherUnread; total unread = sum', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/counts' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    // Seed: main1 unread=2, other1 unread=3 → mainUnread=1, otherUnread=1, unread=2 (counts by row, not by message count)
    expect(body).toHaveProperty('mainUnread');
    expect(body).toHaveProperty('otherUnread');
    expect(body.mainUnread).toBe(1);
    expect(body.otherUnread).toBe(1);
    // Back-compat — existing total unread is sum across both tabs.
    expect(body.unread).toBe(body.mainUnread + body.otherUnread);
    expect(body.total).toBe(4);
    await app.close();

    // Reference: in case downstream readers want them.
    expect(seeded.conversations.main1).toBeTruthy();
  });

  it('counts shape stays back-compat — unread/unreplied/total fields preserved', async () => {
    const seeded = await seed();
    const app = await buildApp({ id: seeded.userId, orgId: seeded.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/counts' });
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('unread');
    expect(body).toHaveProperty('unreplied');
    expect(body).toHaveProperty('total');
    await app.close();
  });
});

describe('handleIncomingMessage auto-promote (feature 0023, BR-0005)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0008: inbound contact message on tab="other" → auto-flip to tab="main"', async () => {
    const seeded = await seed();
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );

    const result = await handleIncomingMessage({
      accountId: seeded.accountId,
      senderUid: 'zC',
      senderName: 'C',
      content: 'KH gửi lại',
      contentType: 'text',
      msgId: 'msg-promote-1',
      timestamp: Date.now(),
      isSelf: false, // contact-sent
      threadId: 'zC',
      threadType: 'user',
      attachments: [],
    });

    expect(result).not.toBeNull();
    expect(result?.tabPromoted).toBe(true);

    const row = await prisma.conversation.findUnique({
      where: { id: seeded.conversations.other1 },
      select: { tab: true },
    });
    expect(row?.tab).toBe('main');
  });

  it('AC-0009: self-sent message on tab="other" → tab stays "other"', async () => {
    const seeded = await seed();
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );

    const result = await handleIncomingMessage({
      accountId: seeded.accountId,
      senderUid: 'self-uid',
      senderName: 'Staff',
      content: 'Rep gửi trong tab Khác',
      contentType: 'text',
      msgId: 'msg-self-1',
      timestamp: Date.now(),
      isSelf: true, // rep-sent
      threadId: 'zC',
      threadType: 'user',
      attachments: [],
    });

    expect(result).not.toBeNull();
    expect(result?.tabPromoted).toBe(false);

    const row = await prisma.conversation.findUnique({
      where: { id: seeded.conversations.other1 },
      select: { tab: true },
    });
    expect(row?.tab).toBe('other');
  });

  it('inbound on tab="main" → tab stays "main", tabPromoted=false', async () => {
    const seeded = await seed();
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );

    const result = await handleIncomingMessage({
      accountId: seeded.accountId,
      senderUid: 'zA',
      senderName: 'A',
      content: 'hi',
      contentType: 'text',
      msgId: 'msg-main-inbound',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'zA',
      threadType: 'user',
      attachments: [],
    });

    expect(result?.tabPromoted).toBe(false);
    const row = await prisma.conversation.findUnique({
      where: { id: seeded.conversations.main1 },
      select: { tab: true },
    });
    expect(row?.tab).toBe('main');
  });
});

describe('Schema default for tab (feature 0023)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0010: conversations created without specifying tab default to "main"', async () => {
    const org = await prisma.organization.create({ data: { name: 'Org' } });
    const user = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `u-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'A',
        role: 'admin',
      },
    });
    const account = await prisma.zaloAccount.create({
      data: { orgId: org.id, ownerUserId: user.id, status: 'connected' },
    });
    const contact = await prisma.contact.create({
      data: { orgId: org.id, fullName: 'No-tab', zaloUid: 'zX' },
    });

    // Insert WITHOUT setting `tab` — should fall back to DB default 'main'.
    const conv = await prisma.conversation.create({
      data: {
        orgId: org.id,
        zaloAccountId: account.id,
        contactId: contact.id,
        threadType: 'user',
        externalThreadId: 'zX',
      },
      select: { tab: true },
    });
    expect(conv.tab).toBe('main');
  });
});
