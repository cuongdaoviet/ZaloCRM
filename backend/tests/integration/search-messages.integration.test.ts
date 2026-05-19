/**
 * Integration test: GET /api/v1/search/messages — feature 0006.
 * Real Postgres + Fastify inject for the HTTP boundary.
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
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'admin' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seedOrgWithMessages() {
  const org = await prisma.organization.create({ data: { name: 'S Org' } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
  });
  const contact = await prisma.contact.create({
    data: { orgId: org.id, zaloUid: 'kh-uid', fullName: 'Khách A' },
  });
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contact.id,
      threadType: 'user',
      externalThreadId: 'kh-uid',
    },
  });
  // Three messages, varied senderType + content + sentAt
  await prisma.message.createMany({
    data: [
      {
        conversationId: conv.id,
        senderType: 'contact',
        senderUid: 'kh-uid',
        senderName: 'Khách A',
        content: 'Cho em hỏi bảng giá sản phẩm A',
        contentType: 'text',
        sentAt: new Date('2026-01-10T10:00:00Z'),
      },
      {
        conversationId: conv.id,
        senderType: 'self',
        senderUid: 'self-uid',
        senderName: 'Owner',
        content: 'Em gửi bảng giá ạ',
        contentType: 'text',
        sentAt: new Date('2026-01-10T10:05:00Z'),
      },
      {
        conversationId: conv.id,
        senderType: 'contact',
        senderUid: 'kh-uid',
        senderName: 'Khách A',
        content: 'Cảm ơn em',
        contentType: 'text',
        sentAt: new Date('2026-02-15T14:00:00Z'),
      },
    ],
  });
  return { org, owner, account, contact, conv };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { searchRoutes } = await import('../../src/modules/search/search-routes.js');
  await app.register(searchRoutes);
  return app;
}

describe('GET /api/v1/search/messages', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001 + AC-0009: returns matched messages with snippet', async () => {
    const { org, owner } = await seedOrgWithMessages();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(2);
    expect(body.messages).toHaveLength(2);
    for (const m of body.messages) {
      expect(m.snippet).toContain('**');
    }
    await app.close();
  });

  it('AC-0002: q with 1 char → 400', async () => {
    const { org, owner } = await seedOrgWithMessages();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=a',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0003: senderType=contact filters out self messages', async () => {
    const { org, owner } = await seedOrgWithMessages();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá&senderType=contact',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(body.messages[0].senderType).toBe('contact');
    await app.close();
  });

  it('AC-0004: date range narrows the result set', async () => {
    const { org, owner } = await seedOrgWithMessages();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá&from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(2);
    await app.close();
  });

  it('AC-0005: from > to → 400', async () => {
    const { org, owner } = await seedOrgWithMessages();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=hello&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0006: pagination — page=2 returns the next batch', async () => {
    const { org, owner, conv } = await seedOrgWithMessages();
    // Insert 5 more matching messages
    for (let i = 0; i < 5; i++) {
      await prisma.message.create({
        data: {
          conversationId: conv.id,
          senderType: 'contact',
          senderUid: 'kh-uid',
          content: `Em hỏi bảng giá item ${i}`,
          contentType: 'text',
          sentAt: new Date(`2026-03-01T10:0${i}:00Z`),
        },
      });
    }
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá&limit=3&page=1',
    });
    const page2 = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá&limit=3&page=2',
    });
    const body1 = JSON.parse(page1.payload);
    const body2 = JSON.parse(page2.payload);
    expect(body1.total).toBe(7); // 2 original + 5 new
    expect(body1.messages).toHaveLength(3);
    expect(body2.messages).toHaveLength(3);
    expect(body1.totalPages).toBe(3);
    // Ensure no overlap between pages
    const idsP1 = body1.messages.map((m: any) => m.id);
    const idsP2 = body2.messages.map((m: any) => m.id);
    expect(idsP1.some((id: string) => idsP2.includes(id))).toBe(false);
    await app.close();
  });

  it('AC-0007: member without access returns empty', async () => {
    const { org } = await seedOrgWithMessages();
    const member = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'M',
        role: 'member',
      },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).total).toBe(0);
    await app.close();
  });

  it('AC-0007 cont.: member WITH access sees their accounts', async () => {
    const { org, account } = await seedOrgWithMessages();
    const member = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'M',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).total).toBe(2);
    await app.close();
  });

  it('AC-0008: cross-org isolation', async () => {
    // Org A with our matching messages
    const { org: orgA, owner: ownerA } = await seedOrgWithMessages();
    // Org B with its own matching messages
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
    const accountB = await prisma.zaloAccount.create({
      data: { orgId: orgB.id, ownerUserId: ownerB.id, status: 'connected' },
    });
    const convB = await prisma.conversation.create({
      data: {
        orgId: orgB.id,
        zaloAccountId: accountB.id,
        threadType: 'user',
        externalThreadId: 'b-uid',
      },
    });
    await prisma.message.create({
      data: {
        conversationId: convB.id,
        senderType: 'contact',
        senderUid: 'b-uid',
        content: 'tin org B chứa bảng giá',
        contentType: 'text',
        sentAt: new Date(),
      },
    });
    const app = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(2); // only org A's matches
    await app.close();
  });

  it('filters by contentType', async () => {
    const { org, owner, conv } = await seedOrgWithMessages();
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        senderType: 'self',
        senderUid: 'self-uid',
        content: 'bảng giá.pdf',
        contentType: 'file',
        sentAt: new Date(),
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá&contentType=file',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(body.messages[0].contentType).toBe('file');
    await app.close();
  });

  it('excludes deleted messages', async () => {
    const { org, owner, conv } = await seedOrgWithMessages();
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        senderType: 'contact',
        senderUid: 'kh-uid',
        content: 'tin bảng giá đã xoá',
        contentType: 'text',
        sentAt: new Date(),
        isDeleted: true,
        deletedAt: new Date(),
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search/messages?q=bảng giá',
    });
    const body = JSON.parse(res.payload);
    // Still 2, not 3 — deleted row excluded
    expect(body.total).toBe(2);
    await app.close();
  });
});
