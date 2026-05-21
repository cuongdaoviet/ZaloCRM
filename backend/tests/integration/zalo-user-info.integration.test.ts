/**
 * Integration tests for Feature 0030 — Zalo user info popup
 * (GET /api/v1/zalo/users/:uid?accountId=X).
 *
 * Covers AC-0001 … AC-0007 + EC-0001 (invalid uid).
 * AC-0008..AC-0010 are FE only. AC-0011 is the build step.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// zca-js api.getUserInfo spy — re-bound in each `it`.
const getUserInfoMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ status: 'connected', api: { getUserInfo: getUserInfoMock } })),
};

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));
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
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetDb(prisma);
  getUserInfoMock.mockReset();
  zaloPoolMock.getInstance.mockReset();
  zaloPoolMock.getInstance.mockReturnValue({
    status: 'connected',
    api: { getUserInfo: getUserInfoMock },
  });
  const mod = await import('../../src/modules/zalo/zalo-user-routes.js');
  mod.clearZaloUserInfoCache();
});

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { zaloUserRoutes } = await import('../../src/modules/zalo/zalo-user-routes.js');
  await app.register(zaloUserRoutes);
  return app;
}

interface Seed {
  orgId: string;
  userId: string;
  accountId: string;
}

async function seedOrgAndAccount(): Promise<Seed> {
  const org = await prisma.organization.create({ data: { name: `Org-${Math.random()}` } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, displayName: 'Nick', status: 'connected' },
  });
  return { orgId: org.id, userId: owner.id, accountId: account.id };
}

/** Build a zca-js-shaped response for a single uid. */
function fakeProfile(
  uid: string,
  partial: { name?: string; avatar?: string; phone?: string; gender?: number | string } = {},
): unknown {
  return {
    changed_profiles: {
      [uid]: {
        zaloName: partial.name ?? 'Lan Anh',
        avatar: partial.avatar ?? 'https://cdn.zalo/avatar.jpg',
        phoneNumber: partial.phone ?? '0901234567',
        gender: partial.gender ?? 1,
      },
    },
  };
}

describe('GET /api/v1/zalo/users/:uid (feature 0030)', () => {
  it('AC-0001: valid params → 200 with expected shape', async () => {
    const seed = await seedOrgAndAccount();
    getUserInfoMock.mockResolvedValue(fakeProfile('2347234782'));

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toMatchObject({
      uid: '2347234782',
      displayName: 'Lan Anh',
      avatarUrl: 'https://cdn.zalo/avatar.jpg',
      gender: 'female',
      phone: '0901234567',
      contactId: null,
      online: true,
      cached: false,
    });
    await app.close();
  });

  it('AC-0002: same uid within 10 min → cache hit (api.getUserInfo called once)', async () => {
    const seed = await seedOrgAndAccount();
    getUserInfoMock.mockResolvedValue(fakeProfile('2347234782'));

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const r1 = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    const r2 = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(getUserInfoMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(r1.payload).cached).toBe(false);
    expect(JSON.parse(r2.payload).cached).toBe(true);
    await app.close();
  });

  it('AC-0003: member without chat ACL → 403', async () => {
    const seed = await seedOrgAndAccount();
    const member = await prisma.user.create({
      data: {
        orgId: seed.orgId,
        email: `m-${Date.now()}-${Math.random()}@t.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    // No ZaloAccountAccess row → no ACL.
    getUserInfoMock.mockResolvedValue(fakeProfile('2347234782'));

    const app = await buildApp({ id: member.id, orgId: seed.orgId, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(403);
    expect(getUserInfoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('AC-0003b: member with read-only ACL → 403 (chat required)', async () => {
    const seed = await seedOrgAndAccount();
    const member = await prisma.user.create({
      data: {
        orgId: seed.orgId,
        email: `m-${Date.now()}-${Math.random()}@t.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: seed.accountId, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: seed.orgId, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0003c: member with chat ACL → 200', async () => {
    const seed = await seedOrgAndAccount();
    const member = await prisma.user.create({
      data: {
        orgId: seed.orgId,
        email: `m-${Date.now()}-${Math.random()}@t.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: seed.accountId, userId: member.id, permission: 'chat' },
    });
    getUserInfoMock.mockResolvedValue(fakeProfile('2347234782'));

    const app = await buildApp({ id: member.id, orgId: seed.orgId, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('AC-0004: cross-org accountId → 404', async () => {
    const seed = await seedOrgAndAccount();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other' } });
    const otherUser = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `x-${Date.now()}@t.local`,
        passwordHash: 'h',
        fullName: 'X',
        role: 'owner',
      },
    });
    const app = await buildApp({ id: otherUser.id, orgId: otherOrg.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('AC-0005: response includes contactId when Contact exists with zaloUid', async () => {
    const seed = await seedOrgAndAccount();
    const contact = await prisma.contact.create({
      data: { orgId: seed.orgId, fullName: 'Existing', zaloUid: '2347234782' },
    });
    getUserInfoMock.mockResolvedValue(fakeProfile('2347234782'));

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).contactId).toBe(contact.id);
    await app.close();
  });

  it('AC-0006: response includes contactId=null when no Contact match', async () => {
    const seed = await seedOrgAndAccount();
    getUserInfoMock.mockResolvedValue(fakeProfile('9999999999'));

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/9999999999?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).contactId).toBeNull();
    await app.close();
  });

  it('AC-0007: zca-js getUserInfo throws → 200 with degraded payload (displayName=Unknown)', async () => {
    const seed = await seedOrgAndAccount();
    getUserInfoMock.mockRejectedValue(new Error('Hidden by privacy'));

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.displayName).toBe('Unknown');
    expect(body.avatarUrl).toBeNull();
    expect(body.phone).toBeNull();
    expect(body.online).toBe(true);
    await app.close();
  });

  it('EC-0003: account offline → 200 with online=false stub', async () => {
    const seed = await seedOrgAndAccount();
    zaloPoolMock.getInstance.mockReturnValue({ status: 'disconnected', api: null } as any);

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.online).toBe(false);
    expect(body.displayName).toBe('Unknown');
    expect(getUserInfoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('EC-0005: non-digit uid → 400 invalid_uid', async () => {
    const seed = await seedOrgAndAccount();
    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/abc?accountId=${seed.accountId}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('invalid_uid');
    await app.close();
  });

  it('missing accountId query → 400 missing_account_id', async () => {
    const seed = await seedOrgAndAccount();
    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/users/2347234782`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('missing_account_id');
    await app.close();
  });
});
