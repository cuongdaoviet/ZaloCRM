/**
 * Feature 0050 — chat catch-up cursor.
 *
 * GET /api/v1/conversations/:id/messages?sinceMessageId=<uuid> returns
 * only messages newer than the cursor message. Used by the FE for
 * background reconciliation after a socket drop or tab unfocus.
 *
 * AC mapping:
 *   AC-0001: cursor returns only newer messages
 *   AC-0002: invalid cursor → 400
 *   AC-0003: cursor from a different conversation → 400 (no leak)
 *   (AC-0008 — backend coverage)
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
  authMiddleware: async () => {},
}));
vi.mock('../../src/modules/zalo/zalo-access-middleware.js', () => ({
  // Skip the ACL check; we test the cursor logic in isolation. Cross-org
  // protection is exercised by the existing chat-routes integration tests.
  requireZaloAccess: () => async () => {},
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
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

interface Seeded {
  orgId: string;
  userId: string;
  conv: { id: string };
  otherConv: { id: string };
  msgs: { id: string; sentAt: Date }[];
}

async function seedConversationWithMessages(): Promise<Seeded> {
  const org = await prisma.organization.create({ data: { name: 'Catchup Org' } });
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
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      threadType: 'user',
      externalThreadId: 'cust-1',
    },
  });
  // 5 messages spaced 1 minute apart so `sentAt > cursor` slicing is deterministic.
  const base = Date.now();
  const msgRows = await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      prisma.message.create({
        data: {
          conversationId: conv.id,
          senderType: 'contact',
          senderUid: 'cust-1',
          content: `msg-${i}`,
          contentType: 'text',
          sentAt: new Date(base + i * 60_000),
        },
        select: { id: true, sentAt: true },
      }),
    ),
  );
  // Separate conversation in the SAME org — used to test cross-conv cursor leak.
  const otherConv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      threadType: 'user',
      externalThreadId: 'cust-2',
    },
  });
  return { orgId: org.id, userId: owner.id, conv, otherConv, msgs: msgRows };
}

describe('GET /conversations/:id/messages?sinceMessageId=… — feature 0050', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: returns only messages newer than the cursor', async () => {
    const { orgId, userId, conv, msgs } = await seedConversationWithMessages();
    const app = await buildApp({ id: userId, orgId, role: 'owner' });

    // Cursor at the 3rd message → expect msgs[3] and msgs[4] (2 newer).
    const cursor = msgs[2].id;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/messages?sinceMessageId=${cursor}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.messages).toHaveLength(2);
    // Messages are returned ascending by sentAt (the route .reverse()s the desc order)
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['msg-3', 'msg-4']);
    expect(body.sinceCursor).toBe(cursor);
    expect(body.truncated).toBe(false);
    await app.close();
  });

  it('AC-0001: empty result when cursor is the last message', async () => {
    const { orgId, userId, conv, msgs } = await seedConversationWithMessages();
    const app = await buildApp({ id: userId, orgId, role: 'owner' });
    const cursor = msgs[4].id; // newest
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/messages?sinceMessageId=${cursor}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.messages).toHaveLength(0);
    expect(body.truncated).toBe(false);
    await app.close();
  });

  it('AC-0002: nonexistent cursor → 400 INVALID_CURSOR', async () => {
    const { orgId, userId, conv } = await seedConversationWithMessages();
    const app = await buildApp({ id: userId, orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/messages?sinceMessageId=00000000-0000-0000-0000-000000000000`,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('INVALID_CURSOR');
    await app.close();
  });

  it('AC-0003: cursor from a different conversation → 400 (no leak)', async () => {
    const { orgId, userId, conv, otherConv, msgs } = await seedConversationWithMessages();
    const app = await buildApp({ id: userId, orgId, role: 'owner' });
    // Pass a cursor id that exists but belongs to `conv`, while requesting
    // `otherConv`'s messages. Must 400, not return a slice of `conv`'s
    // messages on the wrong conversation route.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${otherConv.id}/messages?sinceMessageId=${msgs[0].id}`,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('INVALID_CURSOR');
    await app.close();
  });

  it('without sinceMessageId behaves like the original paginated endpoint', async () => {
    const { orgId, userId, conv } = await seedConversationWithMessages();
    const app = await buildApp({ id: userId, orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/messages?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.messages).toHaveLength(5);
    // No catch-up meta fields when not in catch-up mode
    expect(body.sinceCursor).toBeUndefined();
    expect(body.truncated).toBeUndefined();
    await app.close();
  });
});
