/**
 * Integration tests for feature 0015 — pinned conversations.
 *
 * Covers:
 *   - Pin / unpin idempotency
 *   - Access gating (chat permission required for pin/unpin)
 *   - Cross-org isolation (404 leak prevention)
 *   - GET /pinned ordering + member filtering
 *   - FK cascade on conversation delete
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
  const { pinConversationRoutes } = await import(
    '../../src/modules/conversations/pin-routes.js'
  );
  await app.register(pinConversationRoutes);
  return app;
}

async function seedConversation() {
  const org = await prisma.organization.create({ data: { name: 'Pin Org' } });
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
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
  });
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      threadType: 'user',
      externalThreadId: `uid-${Date.now()}-${Math.random()}`,
    },
  });
  return { org, owner, member, account, conv };
}

describe('Pinned conversations', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('owner pins a conversation', async () => {
    const { org, owner, conv } = await seedConversation();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.conversationId).toBe(conv.id);
    expect(body.orgId).toBe(org.id);
    await app.close();
  });

  it('AC: pin idempotency — calling pin twice returns 200 with same row', async () => {
    const { org, owner, conv } = await seedConversation();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.payload);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.payload);
    expect(secondBody.id).toBe(firstBody.id);

    // Only one row in the DB
    expect(await prisma.pinnedConversation.count()).toBe(1);
    await app.close();
  });

  it('AC: unpin then re-pin works', async () => {
    const { org, owner, conv } = await seedConversation();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    await app.inject({ method: 'POST', url: `/api/v1/conversations/${conv.id}/pin` });
    expect(await prisma.pinnedConversation.count()).toBe(1);

    const unpin = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(unpin.statusCode).toBe(204);
    expect(await prisma.pinnedConversation.count()).toBe(0);

    const repin = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(repin.statusCode).toBe(201);
    expect(await prisma.pinnedConversation.count()).toBe(1);
    await app.close();
  });

  it('AC: unpin is idempotent — DELETE on unpinned conv returns 204', async () => {
    const { org, owner, conv } = await seedConversation();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('AC: cross-org isolation — owner of org B cannot pin a conv in org A', async () => {
    const { conv: convA } = await seedConversation();
    const { org: orgB, owner: ownerB } = await seedConversation();
    const app = await buildApp({ id: ownerB.id, orgId: orgB.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convA.id}/pin`,
    });
    expect(res.statusCode).toBe(404);
    expect(await prisma.pinnedConversation.count()).toBe(0);
    await app.close();
  });

  it('AC: cross-org isolation on unpin → 404', async () => {
    const { conv: convA, org: orgA, owner: ownerA } = await seedConversation();
    // Pin in org A first
    const appA = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });
    await appA.inject({ method: 'POST', url: `/api/v1/conversations/${convA.id}/pin` });
    await appA.close();

    // Owner of org B tries to unpin
    const { org: orgB, owner: ownerB } = await seedConversation();
    const appB = await buildApp({ id: ownerB.id, orgId: orgB.id, role: 'owner' });
    const res = await appB.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${convA.id}/pin`,
    });
    expect(res.statusCode).toBe(404);
    // Pin should still be there
    expect(await prisma.pinnedConversation.count()).toBe(1);
    await appB.close();
  });

  it('AC: member without chat access on the account → 403', async () => {
    const { org, member, account, conv } = await seedConversation();
    // Grant only `read` access — pin needs `chat`
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC: member with no access at all → 403', async () => {
    const { org, member, conv } = await seedConversation();
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC: member with chat access CAN pin', async () => {
    const { org, member, account, conv } = await seedConversation();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'chat' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/pin`,
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('AC: GET /pinned returns only own-org pins, sorted by pinnedAt DESC', async () => {
    const { org: orgA, owner: ownerA, account: accountA, conv: convA1 } = await seedConversation();
    // Create a second conv in org A so we have 2 pins
    const convA2 = await prisma.conversation.create({
      data: {
        orgId: orgA.id,
        zaloAccountId: accountA.id,
        threadType: 'user',
        externalThreadId: `uid-${Date.now()}-extra`,
      },
    });
    // Org B with its own pin — must be excluded
    const { org: orgB, conv: convB } = await seedConversation();

    await prisma.pinnedConversation.create({
      data: {
        orgId: orgA.id,
        zaloAccountId: accountA.id,
        conversationId: convA1.id,
        pinnedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.pinnedConversation.create({
      data: {
        orgId: orgA.id,
        zaloAccountId: accountA.id,
        conversationId: convA2.id,
        pinnedAt: new Date('2026-01-02T00:00:00Z'),
      },
    });
    await prisma.pinnedConversation.create({
      data: {
        orgId: orgB.id,
        zaloAccountId: convB.zaloAccountId,
        conversationId: convB.id,
        pinnedAt: new Date('2026-01-03T00:00:00Z'),
      },
    });

    const app = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/pinned' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.conversations).toHaveLength(2);
    expect(body.conversations[0].id).toBe(convA2.id); // newest pin first
    expect(body.conversations[1].id).toBe(convA1.id);
    // Both should belong to org A — no leak from org B
    for (const c of body.conversations) {
      expect(c.orgId).toBe(orgA.id);
    }
    await app.close();
  });

  it('AC: GET /pinned for member filters to accessible accounts', async () => {
    const { org, member, conv } = await seedConversation();
    // Pin the conv — but member has NO access to its account
    await prisma.pinnedConversation.create({
      data: { orgId: org.id, zaloAccountId: conv.zaloAccountId, conversationId: conv.id },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/pinned' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).conversations).toHaveLength(0);
    await app.close();
  });

  it('AC: GET /pinned for member with read access includes the pin', async () => {
    const { org, member, account, conv } = await seedConversation();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    await prisma.pinnedConversation.create({
      data: { orgId: org.id, zaloAccountId: account.id, conversationId: conv.id },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations/pinned' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).conversations).toHaveLength(1);
    await app.close();
  });

  it('AC: FK cascade — deleting the conversation removes its pin', async () => {
    const { org, conv } = await seedConversation();
    await prisma.pinnedConversation.create({
      data: { orgId: org.id, zaloAccountId: conv.zaloAccountId, conversationId: conv.id },
    });
    expect(await prisma.pinnedConversation.count()).toBe(1);

    await prisma.conversation.delete({ where: { id: conv.id } });
    expect(await prisma.pinnedConversation.count()).toBe(0);
  });
});
