/**
 * Integration tests for feature 0008 — campaigns CRUD + lifecycle routes.
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
  const { campaignRoutes } = await import(
    '../../src/modules/campaigns/campaign-routes.js'
  );
  await app.register(campaignRoutes);
  return app;
}

async function seedOrgWithContacts(contactCount = 3) {
  const org = await prisma.organization.create({ data: { name: 'C Org' } });
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
  // Seed contacts: half "interested" with zaloUid, half "new" without
  for (let i = 0; i < contactCount; i++) {
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: `uid-${i}`,
        fullName: `Khách ${i}`,
        status: 'interested',
      },
    });
  }
  // Add 1 contact without zaloUid that must NOT be targeted
  await prisma.contact.create({
    data: { orgId: org.id, fullName: 'No UID', status: 'interested', zaloUid: null },
  });
  return { org, owner, member, account };
}

describe('POST /api/v1/campaigns', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: materializes targets from filter, defaults to status=draft', async () => {
    const { org, owner, account } = await seedOrgWithContacts(3);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: 'Test',
        zaloAccountId: account.id,
        message: 'Hi',
        filter: { status: ['interested'] },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('draft');
    // 3 contacts with zaloUid match; 1 without uid skipped
    expect(body.totalTargets).toBe(3);

    const targets = await prisma.campaignTarget.findMany({ where: { campaignId: body.id } });
    expect(targets).toHaveLength(3);
    expect(targets.every((t) => t.status === 'pending')).toBe(true);
    await app.close();
  });

  it('AC-0009: rejects member with 403', async () => {
    const { org, member, account } = await seedOrgWithContacts(1);
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: 'X',
        zaloAccountId: account.id,
        message: 'Hi',
        filter: { status: ['interested'] },
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 400 when no contact matches filter', async () => {
    const { org, owner, account } = await seedOrgWithContacts(0);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: 'X',
        zaloAccountId: account.id,
        message: 'Hi',
        filter: { status: ['interested'] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/Không có khách hàng/);
    await app.close();
  });

  it('returns 404 when zalo account is in another org', async () => {
    const { org, owner } = await seedOrgWithContacts(1);
    const otherOrg = await prisma.organization.create({ data: { name: 'B' } });
    const otherOwner = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `b-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'B',
        role: 'owner',
      },
    });
    const otherAccount = await prisma.zaloAccount.create({
      data: { orgId: otherOrg.id, ownerUserId: otherOwner.id, status: 'connected' },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: 'X',
        zaloAccountId: otherAccount.id,
        message: 'Hi',
        filter: { status: ['interested'] },
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('Campaign lifecycle transitions', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0002: start without scheduledAt → status=running', async () => {
    const { org, owner, account } = await seedOrgWithContacts(2);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: 'T', zaloAccountId: account.id, message: 'Hi',
        filter: { status: ['interested'] },
      },
    });
    const id = JSON.parse(create.payload).id;

    const start = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/start` });
    expect(start.statusCode).toBe(200);
    expect(JSON.parse(start.payload).status).toBe('running');
    await app.close();
  });

  it('AC-0003: start with future scheduledAt → status=scheduled', async () => {
    const { org, owner, account } = await seedOrgWithContacts(1);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/campaigns',
      payload: {
        name: 'T', zaloAccountId: account.id, message: 'Hi',
        filter: { status: ['interested'] },
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const id = JSON.parse(create.payload).id;

    const start = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/start` });
    expect(JSON.parse(start.payload).status).toBe('scheduled');
    await app.close();
  });

  it('AC-0004 / AC-0005: pause running, then resume', async () => {
    const { org, owner, account } = await seedOrgWithContacts(2);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'T', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });
    const id = JSON.parse(create.payload).id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/start` });

    const pause = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/pause` });
    expect(JSON.parse(pause.payload).status).toBe('paused');

    const resume = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/resume` });
    expect(JSON.parse(resume.payload).status).toBe('running');
    await app.close();
  });

  it('AC-0006: cancel sets status=cancelled', async () => {
    const { org, owner, account } = await seedOrgWithContacts(1);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'T', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });
    const id = JSON.parse(create.payload).id;
    await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/start` });

    const cancel = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/cancel` });
    expect(JSON.parse(cancel.payload).status).toBe('cancelled');
    await app.close();
  });

  it('rejects illegal transition (e.g. resume a completed campaign)', async () => {
    const { org, owner, account } = await seedOrgWithContacts(1);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'T', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });
    const id = JSON.parse(create.payload).id;
    // Force status=completed via direct DB write
    await prisma.campaign.update({ where: { id }, data: { status: 'completed', completedAt: new Date() } });

    const resume = await app.inject({ method: 'POST', url: `/api/v1/campaigns/${id}/resume` });
    expect(resume.statusCode).toBe(400);
    await app.close();
  });
});

describe('Retry failed', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0007: resets failed targets back to pending', async () => {
    const { org, owner, account } = await seedOrgWithContacts(3);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'T', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });
    const id = JSON.parse(create.payload).id;

    // Simulate worker: mark 2 targets failed
    const targets = await prisma.campaignTarget.findMany({ where: { campaignId: id } });
    await prisma.campaignTarget.updateMany({
      where: { id: { in: targets.slice(0, 2).map((t) => t.id) } },
      data: { status: 'failed', errorMessage: 'mock' },
    });
    await prisma.campaign.update({
      where: { id },
      data: { status: 'completed', failedCount: 2, completedAt: new Date() },
    });

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${id}/retry-failed`,
    });
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.payload).retriedCount).toBe(2);

    const after = await prisma.campaign.findUnique({ where: { id } });
    expect(after?.status).toBe('running');
    expect(after?.failedCount).toBe(0);
    // All 3 targets pending now: 1 was always pending, 2 reset from failed
    const pendingCount = await prisma.campaignTarget.count({
      where: { campaignId: id, status: 'pending' },
    });
    expect(pendingCount).toBe(3);
    const failedCount = await prisma.campaignTarget.count({
      where: { campaignId: id, status: 'failed' },
    });
    expect(failedCount).toBe(0);
    await app.close();
  });

  it('returns 400 when there is nothing to retry', async () => {
    const { org, owner, account } = await seedOrgWithContacts(1);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'T', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });
    const id = JSON.parse(create.payload).id;

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/campaigns/${id}/retry-failed`,
    });
    expect(retry.statusCode).toBe(400);
    await app.close();
  });
});

describe('List + detail + delete', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0012: cross-org isolation', async () => {
    const { org: orgA, owner: ownerA, account: accountA } = await seedOrgWithContacts(1);
    const { org: orgB, owner: ownerB } = await seedOrgWithContacts(1);

    const appA = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });
    await appA.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'A', zaloAccountId: accountA.id, message: 'Hi', filter: { status: ['interested'] } },
    });

    const appB = await buildApp({ id: ownerB.id, orgId: orgB.id, role: 'owner' });
    const list = await appB.inject({ method: 'GET', url: '/api/v1/campaigns' });
    expect(JSON.parse(list.payload).campaigns).toHaveLength(0);
    await appA.close();
    await appB.close();
  });

  it('member only sees their own campaigns', async () => {
    const { org, owner, member, account } = await seedOrgWithContacts(1);
    const appOwner = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    await appOwner.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'OwnerCampaign', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });

    const appMember = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const list = await appMember.inject({ method: 'GET', url: '/api/v1/campaigns' });
    expect(JSON.parse(list.payload).campaigns).toHaveLength(0); // member didn't create any
    await appOwner.close();
    await appMember.close();
  });

  it('DELETE refuses non-terminal campaigns', async () => {
    const { org, owner, account } = await seedOrgWithContacts(1);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'T', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });
    const id = JSON.parse(create.payload).id;

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/campaigns/${id}` });
    expect(del.statusCode).toBe(400); // status=draft, not terminal
    await app.close();
  });

  it('DELETE soft-deletes cancelled campaigns', async () => {
    const { org, owner, account } = await seedOrgWithContacts(1);
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const create = await app.inject({
      method: 'POST', url: '/api/v1/campaigns',
      payload: { name: 'T', zaloAccountId: account.id, message: 'Hi', filter: { status: ['interested'] } },
    });
    const id = JSON.parse(create.payload).id;
    await prisma.campaign.update({ where: { id }, data: { status: 'cancelled' } });

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/campaigns/${id}` });
    expect(del.statusCode).toBe(204);

    // List shouldn't include the soft-deleted row
    const list = await app.inject({ method: 'GET', url: '/api/v1/campaigns' });
    expect(JSON.parse(list.payload).campaigns).toHaveLength(0);
    await app.close();
  });
});
