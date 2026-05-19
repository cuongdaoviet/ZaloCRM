/**
 * Integration tests for activity log — feature 0012.
 * Covers AC-0001 to AC-0011 from docs/features/0012-activity-log/SPEC.md.
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
  const { activityRoutes } = await import('../../src/modules/activity/activity-routes.js');
  await app.register(activityRoutes);
  return app;
}

async function seedOrg(label: string) {
  const org = await prisma.organization.create({ data: { name: `${label} Org` } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: `Owner ${label}`,
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: `Member ${label}`,
      role: 'member',
    },
  });
  return { org, owner, member };
}

describe('Activity log', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: GET /activity returns empty list for fresh org', async () => {
    const { org, owner } = await seedOrg('A');
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.activities).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
    expect(body.totalPages).toBe(0);
    await app.close();
  });

  it('AC-0002: logActivity persists a record', async () => {
    const { org, owner } = await seedOrg('B');
    const { logActivity } = await import('../../src/modules/activity/activity-service.js');
    await logActivity({
      orgId: org.id,
      userId: owner.id,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: 'camp-1',
      details: { name: 'Promo X' },
    });

    const rows = await prisma.activityLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('campaign.created');
    expect(rows[0].entityType).toBe('campaign');
    expect(rows[0].details).toEqual({ name: 'Promo X' });
  });

  it('AC-0003: owner sees all activity in their org', async () => {
    const { org, owner, member } = await seedOrg('C');
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'note.created' },
    });
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: member.id, action: 'contact.status_changed' },
    });
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: null, action: 'auto_reply.fired' },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(3);
    await app.close();
  });

  it('AC-0004: member sees only own activity, never others', async () => {
    const { org, owner, member } = await seedOrg('D');
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'note.created' },
    });
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: member.id, action: 'note.updated' },
    });
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: null, action: 'auto_reply.fired' },
    });

    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(body.activities[0].action).toBe('note.updated');
    await app.close();
  });

  it('AC-0005: member cannot escalate by passing ?userId=', async () => {
    const { org, owner, member } = await seedOrg('E');
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'note.created' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/activity?userId=${owner.id}`,
    });
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(0);
    await app.close();
  });

  it('AC-0006: cross-org isolation — orgA owner cannot see orgB activity', async () => {
    const { org: orgA, owner: ownerA } = await seedOrg('F1');
    const { org: orgB, owner: ownerB } = await seedOrg('F2');
    await prisma.activityLog.create({
      data: { orgId: orgB.id, userId: ownerB.id, action: 'note.created' },
    });

    const app = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    expect(JSON.parse(res.payload).total).toBe(0);
    await app.close();
  });

  it('AC-0007: activities ordered by createdAt DESC', async () => {
    const { org, owner } = await seedOrg('G');
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'a',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'b',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
    });
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'c',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    const body = JSON.parse(res.payload);
    expect(body.activities.map((a: any) => a.action)).toEqual(['c', 'b', 'a']);
    await app.close();
  });

  it('AC-0008: pagination — page=2 returns next slice', async () => {
    const { org, owner } = await seedOrg('H');
    for (let i = 0; i < 5; i++) {
      await prisma.activityLog.create({
        data: {
          orgId: org.id, userId: owner.id, action: `act-${i}`,
          createdAt: new Date(2026, 0, i + 1),
        },
      });
    }
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?page=2&limit=2',
    });
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(5);
    expect(body.totalPages).toBe(3);
    expect(body.activities).toHaveLength(2);
    expect(body.activities.map((a: any) => a.action)).toEqual(['act-2', 'act-1']);
    await app.close();
  });

  it('AC-0009: filter by entityType', async () => {
    const { org, owner } = await seedOrg('I');
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'campaign.created', entityType: 'campaign' },
    });
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'note.created', entityType: 'conversation_note' },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?entityType=campaign',
    });
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(body.activities[0].entityType).toBe('campaign');
    await app.close();
  });

  it('AC-0010: filter by exact action code', async () => {
    const { org, owner } = await seedOrg('J');
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'campaign.cancelled' },
    });
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'campaign.completed' },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?action=campaign.cancelled',
    });
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(body.activities[0].action).toBe('campaign.cancelled');
    await app.close();
  });

  it('AC-0011: filter by date range', async () => {
    const { org, owner } = await seedOrg('K');
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'old',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'inside',
        createdAt: new Date('2026-05-15T00:00:00Z'),
      },
    });
    await prisma.activityLog.create({
      data: {
        orgId: org.id, userId: owner.id, action: 'future',
        createdAt: new Date('2026-12-31T00:00:00Z'),
      },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?from=2026-05-01T00:00:00Z&to=2026-06-01T00:00:00Z',
    });
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(1);
    expect(body.activities[0].action).toBe('inside');
    await app.close();
  });

  it('logActivity swallows DB errors so callers stay fire-and-forget', async () => {
    const { logActivity } = await import('../../src/modules/activity/activity-service.js');
    // Pass an orgId that violates the FK so create throws inside logActivity.
    // logActivity should swallow the error and not throw.
    await expect(
      logActivity({
        orgId: '00000000-0000-0000-0000-000000000000',
        userId: null,
        action: 'never.fires',
      }),
    ).resolves.toBeUndefined();
  });

  it('response includes user info when populated', async () => {
    const { org, owner } = await seedOrg('L');
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: owner.id, action: 'note.created' },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    const body = JSON.parse(res.payload);
    expect(body.activities[0].user).toEqual({ id: owner.id, fullName: 'Owner L' });
    await app.close();
  });

  it('system activity (userId=null) shows user=null in response', async () => {
    const { org, owner } = await seedOrg('M');
    await prisma.activityLog.create({
      data: { orgId: org.id, userId: null, action: 'auto_reply.fired' },
    });

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    const body = JSON.parse(res.payload);
    expect(body.activities[0].user).toBeNull();
    await app.close();
  });
});
