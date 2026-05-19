/**
 * Integration test: quick-replies CRUD — feature 0004.
 * Real Postgres + Fastify inject.
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
    if (!req.user) req.user = { id: 'test', orgId: 'org', role: 'admin' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seed() {
  const org = await prisma.organization.create({ data: { name: 'QR Org' } });
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
  return { org, owner, member };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { quickReplyRoutes } = await import(
    '../../src/modules/quick-replies/quick-reply-routes.js'
  );
  await app.register(quickReplyRoutes);
  return app;
}

describe('Quick replies CRUD (integration)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: owner creates an org-shared template', async () => {
    const { org, owner } = await seed();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quick-replies',
      payload: { shortcut: 'chao', content: 'Chào {{contactName}}', scope: 'org' },
    });
    expect(res.statusCode).toBe(201);
    const row = JSON.parse(res.payload);
    expect(row.shortcut).toBe('chao');
    expect(row.scope).toBe('org');

    const dbRow = await prisma.quickReply.findFirst();
    expect(dbRow?.shortcut).toBe('chao');
    await app.close();
  });

  it('lists org-shared + own templates, hides other members private templates', async () => {
    const { org, owner, member } = await seed();
    const member2 = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m2-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'M2',
        role: 'member',
      },
    });
    // Owner creates org-shared
    await prisma.quickReply.create({
      data: {
        orgId: org.id,
        createdByUserId: owner.id,
        shortcut: 'org_template',
        content: 'shared',
        scope: 'org',
      },
    });
    // Member creates private
    await prisma.quickReply.create({
      data: {
        orgId: org.id,
        createdByUserId: member.id,
        shortcut: 'my_template',
        content: 'private',
        scope: 'user',
      },
    });
    // Member 2 creates private
    await prisma.quickReply.create({
      data: {
        orgId: org.id,
        createdByUserId: member2.id,
        shortcut: 'm2_only',
        content: 'm2 private',
        scope: 'user',
      },
    });

    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/quick-replies' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const shortcuts = body.replies.map((r: any) => r.shortcut).sort();
    expect(shortcuts).toEqual(['my_template', 'org_template']);
    await app.close();
  });

  it('AC-0003: rejects duplicate shortcut with 409', async () => {
    const { org, owner } = await seed();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    await app.inject({
      method: 'POST',
      url: '/api/v1/quick-replies',
      payload: { shortcut: 'chao', content: 'a', scope: 'org' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quick-replies',
      payload: { shortcut: 'chao', content: 'b', scope: 'org' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('AC-0004: member scope=org is coerced to scope=user', async () => {
    const { org, member } = await seed();
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quick-replies',
      payload: { shortcut: 'mine', content: 'x', scope: 'org' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).scope).toBe('user');
    await app.close();
  });

  it('AC-0005: member cannot edit another members template (403)', async () => {
    const { org, owner, member } = await seed();
    const ownersTemplate = await prisma.quickReply.create({
      data: {
        orgId: org.id,
        createdByUserId: owner.id,
        shortcut: 'priv',
        content: 'priv',
        scope: 'user',
      },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/quick-replies/${ownersTemplate.id}`,
      payload: { shortcut: 'priv', content: 'changed', scope: 'user' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('admin can edit a members template', async () => {
    const { org, owner, member } = await seed();
    const memberTemplate = await prisma.quickReply.create({
      data: {
        orgId: org.id,
        createdByUserId: member.id,
        shortcut: 'mine',
        content: 'old',
        scope: 'user',
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/quick-replies/${memberTemplate.id}`,
      payload: { shortcut: 'mine', content: 'new content', scope: 'user' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).content).toBe('new content');
    await app.close();
  });

  it('AC-0006: rejects invalid shortcut format with 400', async () => {
    const { org, owner } = await seed();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quick-replies',
      payload: { shortcut: 'Chào!', content: 'x', scope: 'user' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('DELETE removes the row', async () => {
    const { org, owner } = await seed();
    const tpl = await prisma.quickReply.create({
      data: {
        orgId: org.id,
        createdByUserId: owner.id,
        shortcut: 'gone',
        content: 'x',
        scope: 'user',
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/quick-replies/${tpl.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.quickReply.count()).toBe(0);
    await app.close();
  });

  it('returns 404 when template belongs to another org', async () => {
    const { org, owner } = await seed();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other' } });
    const otherOwner = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `oo-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'OO',
        role: 'owner',
      },
    });
    const otherTpl = await prisma.quickReply.create({
      data: {
        orgId: otherOrg.id,
        createdByUserId: otherOwner.id,
        shortcut: 'other',
        content: 'x',
        scope: 'org',
      },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/quick-replies/${otherTpl.id}`,
      payload: { shortcut: 'other', content: 'y', scope: 'org' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('two members can have the same shortcut (both scope=user, different owner)', async () => {
    const { org, member } = await seed();
    const member2 = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m2-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'M2',
        role: 'member',
      },
    });
    // Member 1 creates "chao"
    const app1 = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const r1 = await app1.inject({
      method: 'POST',
      url: '/api/v1/quick-replies',
      payload: { shortcut: 'chao', content: 'a', scope: 'user' },
    });
    expect(r1.statusCode).toBe(201);
    await app1.close();

    // Member 2 creates "chao" — should NOT conflict (visibility scopes differ)
    const app2 = await buildApp({ id: member2.id, orgId: org.id, role: 'member' });
    const r2 = await app2.inject({
      method: 'POST',
      url: '/api/v1/quick-replies',
      payload: { shortcut: 'chao', content: 'b', scope: 'user' },
    });
    expect(r2.statusCode).toBe(201);
    expect(await prisma.quickReply.count()).toBe(2);
    await app2.close();
  });
});
