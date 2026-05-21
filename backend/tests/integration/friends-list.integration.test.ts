/**
 * Integration tests — feature 0042: GET /api/v1/friends.
 *
 * Covers AC-0004, AC-0005, AC-0006 (friend list, search, pagination).
 * Owner sees full org; member is restricted by ZaloAccountAccess.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../../src/shared/database/prisma-client.js', () => ({
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

beforeEach(async () => {
  await resetDb(prisma);
  vi.clearAllMocks();
});

interface Seed {
  org: { id: string };
  owner: { id: string };
  member: { id: string };
  accountA: { id: string };
  accountB: { id: string };
  contactX: { id: string };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { friendshipRoutes } = await import(
    '../../src/modules/friendship/friendship-routes.js'
  );
  await app.register(friendshipRoutes);
  return app;
}

async function seed(): Promise<Seed> {
  const org = await prisma.organization.create({
    data: { name: `Org-${Math.random()}` },
  });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  const accountA = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      displayName: 'Nick A',
      status: 'connected',
    },
  });
  const accountB = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      displayName: 'Nick B',
      status: 'connected',
    },
  });
  const contactX = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Khách Lan', phone: '0901' },
  });
  return { org, owner, member, accountA, accountB, contactX };
}

async function makeFriend(opts: {
  orgId: string;
  zaloAccountId: string;
  contactId: string | null;
  zaloUid: string;
  displayName?: string;
}) {
  return prisma.friend.create({
    data: {
      orgId: opts.orgId,
      zaloAccountId: opts.zaloAccountId,
      zaloUid: opts.zaloUid,
      contactId: opts.contactId,
      displayName: opts.displayName ?? null,
    },
  });
}

describe('AC-0004 friends list happy path', () => {
  it('returns friends across all accounts in org for owner', async () => {
    const s = await seed();
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: s.contactX.id,
      zaloUid: 'u1',
      displayName: 'Lan A',
    });
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountB.id,
      contactId: null,
      zaloUid: 'u2',
      displayName: 'Nam B',
    });

    const app = await buildApp({
      id: s.owner.id,
      orgId: s.org.id,
      role: 'owner',
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.totalPages).toBe(1);
    const names = body.data.map((d: any) => d.displayName).sort();
    expect(names).toEqual(['Lan A', 'Nam B']);
    await app.close();
  });
});

describe('AC-0005 search by displayName', () => {
  it('filters by partial case-insensitive displayName match', async () => {
    const s = await seed();
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: null,
      zaloUid: 'u1',
      displayName: 'Nguyen Thi Lan',
    });
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: null,
      zaloUid: 'u2',
      displayName: 'Tran Van Nam',
    });

    const app = await buildApp({
      id: s.owner.id,
      orgId: s.org.id,
      role: 'owner',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/friends?search=lan',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].displayName).toBe('Nguyen Thi Lan');
    await app.close();
  });

  it('search also matches via linked contact fullName', async () => {
    const s = await seed();
    // friend with no displayName but linked contact "Khách Lan"
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: s.contactX.id,
      zaloUid: 'u3',
    });

    const app = await buildApp({
      id: s.owner.id,
      orgId: s.org.id,
      role: 'owner',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/friends?search=lan',
    });
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].contact?.fullName).toBe('Khách Lan');
    await app.close();
  });
});

describe('AC-0006 pagination', () => {
  it('paginates with perPage parameter', async () => {
    const s = await seed();
    for (let i = 0; i < 5; i++) {
      await makeFriend({
        orgId: s.org.id,
        zaloAccountId: s.accountA.id,
        contactId: null,
        zaloUid: `u${i}`,
        displayName: `Friend ${i}`,
      });
    }

    const app = await buildApp({
      id: s.owner.id,
      orgId: s.org.id,
      role: 'owner',
    });
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/friends?page=1&perPage=2',
    });
    const body1 = JSON.parse(res1.payload);
    expect(body1.data).toHaveLength(2);
    expect(body1.pagination.total).toBe(5);
    expect(body1.pagination.totalPages).toBe(3);

    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/friends?page=3&perPage=2',
    });
    const body2 = JSON.parse(res2.payload);
    expect(body2.data).toHaveLength(1);
    await app.close();
  });
});

describe('member ACL', () => {
  it('member only sees friends on accounts they have access to', async () => {
    const s = await seed();
    // member has access to A only
    await prisma.zaloAccountAccess.create({
      data: {
        zaloAccountId: s.accountA.id,
        userId: s.member.id,
        permission: 'chat',
      },
    });
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: null,
      zaloUid: 'u1',
      displayName: 'On A',
    });
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountB.id,
      contactId: null,
      zaloUid: 'u2',
      displayName: 'On B',
    });

    const app = await buildApp({
      id: s.member.id,
      orgId: s.org.id,
      role: 'member',
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends' });
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].displayName).toBe('On A');
    await app.close();
  });

  it('member with no access returns empty list', async () => {
    const s = await seed();
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: null,
      zaloUid: 'u1',
      displayName: 'On A',
    });
    const app = await buildApp({
      id: s.member.id,
      orgId: s.org.id,
      role: 'member',
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/friends' });
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(0);
    expect(body.pagination.total).toBe(0);
    await app.close();
  });
});

describe('accountId filter', () => {
  it('restricts to a single account', async () => {
    const s = await seed();
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountA.id,
      contactId: null,
      zaloUid: 'u1',
      displayName: 'On A',
    });
    await makeFriend({
      orgId: s.org.id,
      zaloAccountId: s.accountB.id,
      contactId: null,
      zaloUid: 'u2',
      displayName: 'On B',
    });
    const app = await buildApp({
      id: s.owner.id,
      orgId: s.org.id,
      role: 'owner',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/friends?accountId=${s.accountA.id}`,
    });
    const body = JSON.parse(res.payload);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].displayName).toBe('On A');
    await app.close();
  });
});
