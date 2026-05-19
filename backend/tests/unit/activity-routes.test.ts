/**
 * Unit tests for activity-routes — feature 0012.
 *
 * Focus: query validation (page/limit/from/to) without DB. We mock the prisma
 * client so the handler returns the expected shape for happy-path inputs and
 * 400 for malformed filters.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const prismaMock = {
  activityLog: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
};

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  prisma: prismaMock,
}));

vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async () => {},
}));

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { activityRoutes } = await import('../../src/modules/activity/activity-routes.js');
  await app.register(activityRoutes);
  return app;
}

describe('activity-routes — query validation', () => {
  beforeEach(() => {
    prismaMock.activityLog.findMany.mockReset();
    prismaMock.activityLog.count.mockReset();
    prismaMock.activityLog.findMany.mockResolvedValue([]);
    prismaMock.activityLog.count.mockResolvedValue(0);
  });

  it('returns paginated shape with defaults', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/activity' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toMatchObject({
      activities: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    await app.close();
  });

  it('caps limit at 200', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?limit=9999',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).limit).toBe(200);
    await app.close();
  });

  it('rejects limit=0', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?limit=0',
    });
    // limit=0 → Number(0) is falsy so it falls back to DEFAULT_LIMIT (50)
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).limit).toBe(50);
    await app.close();
  });

  it('rejects negative limit', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?limit=-5',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects invalid from date', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?from=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/from/);
    await app.close();
  });

  it('rejects invalid to date', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?to=garbage',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/to/);
    await app.close();
  });

  it('rejects from > to', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/activity?from=2026-05-10T00:00:00Z&to=2026-05-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/from phải <= to/);
    await app.close();
  });

  it('member role forces userId filter to self', async () => {
    const app = await buildApp({ id: 'self', orgId: 'o1', role: 'member' });
    await app.inject({
      method: 'GET',
      url: '/api/v1/activity?userId=other',
    });
    expect(prismaMock.activityLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: 'o1', userId: 'self' }),
      }),
    );
    await app.close();
  });

  it('admin can filter by arbitrary userId', async () => {
    const app = await buildApp({ id: 'admin1', orgId: 'o1', role: 'admin' });
    await app.inject({
      method: 'GET',
      url: '/api/v1/activity?userId=target',
    });
    expect(prismaMock.activityLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: 'o1', userId: 'target' }),
      }),
    );
    await app.close();
  });

  it('passes entityType and action filters through', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    await app.inject({
      method: 'GET',
      url: '/api/v1/activity?entityType=campaign&action=campaign.created',
    });
    expect(prismaMock.activityLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: 'o1',
          entityType: 'campaign',
          action: 'campaign.created',
        }),
      }),
    );
    await app.close();
  });

  it('builds createdAt range when both from and to are valid', async () => {
    const app = await buildApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    await app.inject({
      method: 'GET',
      url: '/api/v1/activity?from=2026-05-01T00:00:00Z&to=2026-05-10T00:00:00Z',
    });
    const call = prismaMock.activityLog.findMany.mock.calls[0][0];
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    await app.close();
  });
});
