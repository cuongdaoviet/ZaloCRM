/**
 * Feature 0051 — chat empty-state copy for member with no Zalo access.
 *
 * The conversations list endpoint surfaces a new optional field
 * `accessibleAccountCount` for `role=member` users so the FE can render
 * the right empty-state copy ("not granted" vs. "no chats yet"). For
 * owner/admin the field is omitted entirely — they bypass the ACL and
 * the count carries no meaning for them.
 *
 * AC mapping:
 *   AC-0001: member with 0 ACL rows → accessibleAccountCount=0, list empty
 *   AC-0002: member with 1 ACL row but 0 conversations → count=1, list empty
 *   AC-0003: member with 1 ACL row and 1 conversation → count=1, list has 1
 *   AC-0004: owner bypass → no `accessibleAccountCount` key in response
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

interface SeedBase {
  orgId: string;
  ownerId: string;
  accountId: string;
}

/**
 * Seed an org + owner + 1 Zalo account. No conversations are created here;
 * tests add their own (or not) so each case can be exercised in isolation.
 */
async function seedBase(): Promise<SeedBase> {
  const org = await prisma.organization.create({ data: { name: 'Empty-State Org' } });
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
  return { orgId: org.id, ownerId: owner.id, accountId: account.id };
}

async function createMember(orgId: string): Promise<{ id: string }> {
  const member = await prisma.user.create({
    data: {
      orgId,
      email: `m-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  return { id: member.id };
}

describe('GET /api/v1/conversations — accessibleAccountCount (feature 0051)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: member with 0 ACL rows → accessibleAccountCount=0, empty list', async () => {
    const { orgId, accountId } = await seedBase();
    // Seed a conversation in the org so we can prove the ACL filter (not
    // emptiness of the org) is what produces `conversations: []`.
    await prisma.conversation.create({
      data: {
        orgId,
        zaloAccountId: accountId,
        threadType: 'user',
        externalThreadId: 'cust-1',
      },
    });
    const member = await createMember(orgId);
    const app = await buildApp({ id: member.id, orgId, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accessibleAccountCount).toBe(0);
    expect(body.conversations).toEqual([]);
    expect(body.total).toBe(0);
    await app.close();
  });

  it('AC-0002: member with 1 ACL row but 0 conversations → count=1, list empty', async () => {
    const { orgId, accountId } = await seedBase();
    const member = await createMember(orgId);
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: accountId, userId: member.id, permission: 'chat' },
    });
    const app = await buildApp({ id: member.id, orgId, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accessibleAccountCount).toBe(1);
    expect(body.conversations).toEqual([]);
    expect(body.total).toBe(0);
    await app.close();
  });

  it('AC-0003: member with 1 ACL row + 1 conversation → count=1, list has 1', async () => {
    const { orgId, accountId } = await seedBase();
    await prisma.conversation.create({
      data: {
        orgId,
        zaloAccountId: accountId,
        threadType: 'user',
        externalThreadId: 'cust-1',
      },
    });
    const member = await createMember(orgId);
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: accountId, userId: member.id, permission: 'chat' },
    });
    const app = await buildApp({ id: member.id, orgId, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accessibleAccountCount).toBe(1);
    expect(body.conversations).toHaveLength(1);
    expect(body.total).toBe(1);
    await app.close();
  });

  it('AC-0004: owner bypass → response has no `accessibleAccountCount` key', async () => {
    const { orgId, ownerId } = await seedBase();
    const app = await buildApp({ id: ownerId, orgId, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // BR-0002 — the key must be entirely omitted, not present with null.
    expect(Object.prototype.hasOwnProperty.call(body, 'accessibleAccountCount')).toBe(false);
    expect(body.accessibleAccountCount).toBeUndefined();
    await app.close();
  });

  it('AC-0004 (admin): admin also bypasses → no `accessibleAccountCount` key', async () => {
    const { orgId } = await seedBase();
    const admin = await prisma.user.create({
      data: {
        orgId,
        email: `a-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'h',
        fullName: 'Admin',
        role: 'admin',
      },
    });
    const app = await buildApp({ id: admin.id, orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Object.prototype.hasOwnProperty.call(body, 'accessibleAccountCount')).toBe(false);
    await app.close();
  });

  it('member with 2 ACL rows → accessibleAccountCount=2 (distinct accounts counted)', async () => {
    const { orgId, ownerId, accountId } = await seedBase();
    // Add a second Zalo account so the member can be granted access to two.
    const account2 = await prisma.zaloAccount.create({
      data: { orgId, ownerUserId: ownerId, status: 'connected' },
    });
    const member = await createMember(orgId);
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: accountId, userId: member.id, permission: 'read' },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account2.id, userId: member.id, permission: 'chat' },
    });
    const app = await buildApp({ id: member.id, orgId, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.accessibleAccountCount).toBe(2);
    await app.close();
  });
});
