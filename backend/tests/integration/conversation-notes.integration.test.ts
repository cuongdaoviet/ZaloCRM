/**
 * Integration tests for feature 0010 — conversation notes CRUD.
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
  const { conversationNoteRoutes } = await import(
    '../../src/modules/conversation-notes/conversation-note-routes.js'
  );
  await app.register(conversationNoteRoutes);
  return app;
}

async function seedConversation() {
  const org = await prisma.organization.create({ data: { name: 'N Org' } });
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
      externalThreadId: 'uid-1',
    },
  });
  return { org, owner, member, account, conv };
}

describe('Conversation notes', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('owner creates a note', async () => {
    const { org, owner, conv } = await seedConversation();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/notes`,
      payload: { content: 'Khách thích chào 7h sáng' },
    });
    expect(res.statusCode).toBe(201);
    const note = JSON.parse(res.payload);
    expect(note.content).toBe('Khách thích chào 7h sáng');
    expect(note.author.id).toBe(owner.id);
    await app.close();
  });

  it('AC-0005: rejects content > 2000 chars', async () => {
    const { org, owner, conv } = await seedConversation();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/notes`,
      payload: { content: 'x'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects empty content', async () => {
    const { org, owner, conv } = await seedConversation();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/notes`,
      payload: { content: '   ' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0002: member without zalo access → 403 on GET', async () => {
    const { org, member, conv } = await seedConversation();
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/notes`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('member with read access can GET', async () => {
    const { org, member, account, conv } = await seedConversation();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/notes`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('member with read-only access cannot POST (needs chat)', async () => {
    const { org, member, account, conv } = await seedConversation();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/notes`,
      payload: { content: 'test' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0007: notes sorted by createdAt DESC', async () => {
    const { org, owner, conv } = await seedConversation();
    // Create 3 notes with small delays
    await prisma.conversationNote.create({
      data: {
        conversationId: conv.id, authorId: owner.id, content: 'A',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.conversationNote.create({
      data: {
        conversationId: conv.id, authorId: owner.id, content: 'B',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    });
    await prisma.conversationNote.create({
      data: {
        conversationId: conv.id, authorId: owner.id, content: 'C',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conv.id}/notes`,
    });
    const notes = JSON.parse(res.payload).notes;
    expect(notes.map((n: any) => n.content)).toEqual(['C', 'B', 'A']);
    await app.close();
  });

  it('AC-0003: another member cannot edit my note', async () => {
    const { org, owner, member, account, conv } = await seedConversation();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'chat' },
    });
    const note = await prisma.conversationNote.create({
      data: { conversationId: conv.id, authorId: owner.id, content: 'owner note' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/conversations/notes/${note.id}`,
      payload: { content: 'hacked' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0004: admin can edit anyone else note', async () => {
    const { org, owner, member, conv } = await seedConversation();
    const note = await prisma.conversationNote.create({
      data: { conversationId: conv.id, authorId: member.id, content: 'member note' },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/conversations/notes/${note.id}`,
      payload: { content: 'edited by owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).content).toBe('edited by owner');
    await app.close();
  });

  it('author can delete own note', async () => {
    const { org, owner, conv } = await seedConversation();
    const note = await prisma.conversationNote.create({
      data: { conversationId: conv.id, authorId: owner.id, content: 'own' },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/notes/${note.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.conversationNote.count()).toBe(0);
    await app.close();
  });

  it('AC-0006: cross-org isolation on edit', async () => {
    const { org: orgA, owner: ownerA, conv: convA } = await seedConversation();
    const { conv: convB } = await seedConversation();
    const noteB = await prisma.conversationNote.create({
      data: { conversationId: convB.id, authorId: ownerA.id, content: 'foo' },
    });
    const app = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/conversations/notes/${noteB.id}`,
      payload: { content: 'bar' },
    });
    expect(res.statusCode).toBe(404); // can't even see it
    await app.close();
  });
});
