/**
 * Integration tests for Feature 0026 — GET /api/v1/conversations/:id/members.
 *
 * Covers backend AC-0001..AC-0006 from SPEC.md §6.
 * FE-only ACs (AC-0007..AC-0011) live in the use-mentions unit tests + the
 * Vue components — exercised by vue-tsc + vite build (AC-0013).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// zca-js api.getGroupInfo spy — re-bound in each `it`.
const getGroupInfoMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ status: 'connected', api: { getGroupInfo: getGroupInfoMock } })),
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
  getGroupInfoMock.mockReset();
  zaloPoolMock.getInstance.mockReset();
  zaloPoolMock.getInstance.mockReturnValue({
    status: 'connected',
    api: { getGroupInfo: getGroupInfoMock },
  });
});

interface Seed {
  orgId: string;
  userId: string;
  accountId: string;
  groupConvId: string;
  userConvId: string;
  externalGroupId: string;
}

async function seedOrgAccountAndConversations(): Promise<Seed> {
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
  const groupContact = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'Group X', zaloUid: 'gx-uid' },
  });
  const userContact = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'User Y', zaloUid: 'uy-uid' },
  });
  const externalGroupId = 'group-thread-12345';
  const groupConv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: groupContact.id,
      threadType: 'group',
      externalThreadId: externalGroupId,
      lastMessageAt: new Date(),
    },
  });
  const userConv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: userContact.id,
      threadType: 'user',
      externalThreadId: 'uy-uid',
      lastMessageAt: new Date(),
    },
  });
  return {
    orgId: org.id,
    userId: owner.id,
    accountId: account.id,
    groupConvId: groupConv.id,
    userConvId: userConv.id,
    externalGroupId,
  };
}

/**
 * Shape mirrors the zca-js v2 response we see in the wild:
 *   { gridInfoMap: { [groupId]: { currentMems: [{ id, dName, avatar }] } } }
 */
type FakeMember = {
  id: string;
  dName?: string;
  displayName?: string;
  zaloName?: string;
  avatar?: string;
};

function fakeGroupInfo(groupId: string, members: FakeMember[]): unknown {
  return {
    gridInfoMap: {
      [groupId]: {
        name: 'Group X',
        currentMems: members,
      },
    },
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

describe('GET /api/v1/conversations/:id/members (feature 0026)', () => {
  it('AC-0001: group conversation → 200 with parsed member list', async () => {
    const seed = await seedOrgAccountAndConversations();
    getGroupInfoMock.mockResolvedValue(
      fakeGroupInfo(seed.externalGroupId, [
        { id: '2347234782', dName: 'Lan Anh', avatar: 'https://cdn.zalo/a.jpg' },
        { id: '9988776655', dName: 'Bình', avatar: 'https://cdn.zalo/b.jpg' },
      ]),
    );

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toEqual({
      uid: '2347234782',
      displayName: 'Lan Anh',
      avatarUrl: 'https://cdn.zalo/a.jpg',
    });
    expect(getGroupInfoMock).toHaveBeenCalledWith(seed.externalGroupId);
    await app.close();
  });

  it('AC-0002: user-to-user conversation → 400 not_a_group', async () => {
    const seed = await seedOrgAccountAndConversations();
    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.userConvId}/members`,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('not_a_group');
    expect(getGroupInfoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('AC-0003: cross-org request → 404 (no leak)', async () => {
    const seed = await seedOrgAccountAndConversations();

    // Build an app as a user in a different org.
    const otherOrg = await prisma.organization.create({ data: { name: 'Other Org' } });
    const otherUser = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `oo-${Date.now()}@t.local`,
        passwordHash: 'h',
        fullName: 'Other',
        role: 'owner',
      },
    });
    const app = await buildApp({ id: otherUser.id, orgId: otherOrg.id, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(404);
    expect(getGroupInfoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('AC-0004: member without chat ACL → 403', async () => {
    const seed = await seedOrgAccountAndConversations();
    const member = await prisma.user.create({
      data: {
        orgId: seed.orgId,
        email: `m-${Date.now()}-${Math.random()}@t.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    // No ZaloAccountAccess row → no permission on the underlying account.

    const app = await buildApp({ id: member.id, orgId: seed.orgId, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(403);
    expect(getGroupInfoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('AC-0004b: member with read-only ACL → 403 (chat required)', async () => {
    const seed = await seedOrgAccountAndConversations();
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
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0004c: member with chat ACL → 200', async () => {
    const seed = await seedOrgAccountAndConversations();
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
    getGroupInfoMock.mockResolvedValue(
      fakeGroupInfo(seed.externalGroupId, [{ id: '111111', dName: 'A' }]),
    );

    const app = await buildApp({ id: member.id, orgId: seed.orgId, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).members).toHaveLength(1);
    await app.close();
  });

  it('AC-0005: account offline (api null) → 200 with members: []', async () => {
    const seed = await seedOrgAccountAndConversations();
    zaloPoolMock.getInstance.mockReturnValueOnce({ status: 'disconnected', api: null });

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ members: [] });
    expect(getGroupInfoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('AC-0005b: zaloPool returns undefined → 200 with members: []', async () => {
    const seed = await seedOrgAccountAndConversations();
    zaloPoolMock.getInstance.mockReturnValueOnce(undefined as any);

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ members: [] });
    await app.close();
  });

  it('AC-0006: second call within TTL → cache hit (api.getGroupInfo called once)', async () => {
    const seed = await seedOrgAccountAndConversations();
    getGroupInfoMock.mockResolvedValue(
      fakeGroupInfo(seed.externalGroupId, [{ id: '111111', dName: 'A' }]),
    );

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const r1 = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });
    const r2 = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(getGroupInfoMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(r1.payload).members).toEqual(JSON.parse(r2.payload).members);
    await app.close();
  });

  it('getGroupInfo throwing → 200 with empty members (graceful)', async () => {
    const seed = await seedOrgAccountAndConversations();
    getGroupInfoMock.mockRejectedValue(new Error('zca-js timeout'));

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).members).toEqual([]);
    await app.close();
  });

  it('non-existent conversation → 404', async () => {
    const seed = await seedOrgAccountAndConversations();
    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/00000000-0000-0000-0000-000000000000/members`,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('displayName fallback chain: dName → displayName → zaloName → uid', async () => {
    const seed = await seedOrgAccountAndConversations();
    getGroupInfoMock.mockResolvedValue(
      fakeGroupInfo(seed.externalGroupId, [
        { id: '111111', dName: 'A' },        // dName wins
        { id: '222222', displayName: 'B' },  // displayName wins (no dName)
        { id: '333333', zaloName: 'C' },     // zaloName wins (no dName/displayName)
        { id: '444444' },                    // no name field → uid fallback
      ]),
    );

    const app = await buildApp({ id: seed.userId, orgId: seed.orgId, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${seed.groupConvId}/members`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const byUid: Record<string, string> = {};
    for (const m of body.members) byUid[m.uid] = m.displayName;
    expect(byUid['111111']).toBe('A');
    expect(byUid['222222']).toBe('B');
    expect(byUid['333333']).toBe('C');
    expect(byUid['444444']).toBe('444444');
    await app.close();
  });
});
