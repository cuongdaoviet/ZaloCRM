/**
 * Integration tests for Phase A.1 — POST /api/v1/zalo-accounts/:id/sync-labels.
 *
 * zca-js boundary is mocked via zaloPool.getInstance().api.getLabels.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const getLabelsMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { getLabels: getLabelsMock } })),
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
// requireRole reads req.user.role — let it work normally.

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
  vi.restoreAllMocks();
});

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { zaloLabelSyncRoutes } = await import('../../src/modules/crm-tags/zalo-label-sync-routes.js');
  await app.register(zaloLabelSyncRoutes);
  return app;
}

async function seed(label: string, role: 'owner' | 'admin' | 'member' = 'owner') {
  const org = await prisma.organization.create({ data: { name: `${label} Org` } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${label}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: `User ${label}`,
      role,
    },
  });
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: user.id,
      status: 'connected',
      displayName: `Sale ${label}`,
    },
  });
  return { org, user, account };
}

function sampleLabel(id: number, text: string, color = '#ff5252'): any {
  return {
    id,
    text,
    textKey: `key_${id}`,
    color,
    emoji: '⭐',
    offset: 0,
    conversations: [],
    createTime: Date.now(),
  };
}

describe('POST /api/v1/zalo-accounts/:id/sync-labels', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    getLabelsMock.mockReset();
    zaloPoolMock.getInstance.mockClear();
    // Default: a working API
    zaloPoolMock.getInstance.mockReturnValue({ api: { getLabels: getLabelsMock } });
  });

  it('first sync creates group + tags + label mirror', async () => {
    const { org, user, account } = await seed('A');
    getLabelsMock.mockResolvedValue({
      labelData: [sampleLabel(1, 'VIP'), sampleLabel(2, 'Quan tâm', '#42a5f5')],
      version: 5,
    });

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.synced.labelsCreated).toBe(2);
    expect(body.synced.labelsUpdated).toBe(0);
    expect(body.synced.labelsArchived).toBe(0);
    expect(body.synced.adopted).toBe(0);

    const tags = await prisma.crmTag.findMany({ where: { orgId: org.id } });
    expect(tags).toHaveLength(2);
    expect(tags.every((t) => t.managedBy === 'zalo_sync')).toBe(true);
    expect(tags.every((t) => t.groupId === body.synced.groupId)).toBe(true);

    const group = await prisma.crmTagGroup.findUnique({ where: { id: body.synced.groupId } });
    expect(group?.managedBy).toBe('zalo_sync');
    expect(group?.zaloAccountId).toBe(account.id);
    expect(group?.name).toBe('Zalo — Sale A');

    const labels = await prisma.zaloLabel.findMany({ where: { zaloAccountId: account.id } });
    expect(labels).toHaveLength(2);
    await app.close();
  });

  it('second sync with one label removed archives the orphan', async () => {
    const { org, user, account } = await seed('B');
    getLabelsMock.mockResolvedValue({
      labelData: [sampleLabel(1, 'VIP'), sampleLabel(2, 'Quan tâm')],
      version: 5,
    });
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });

    // Now label id=2 disappears upstream.
    getLabelsMock.mockResolvedValue({
      labelData: [sampleLabel(1, 'VIP')],
      version: 6,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.synced.labelsArchived).toBe(1);

    const archived = await prisma.crmTag.findMany({
      where: { orgId: org.id, archivedAt: { not: null } },
    });
    expect(archived).toHaveLength(1);
    expect(archived[0].name).toBe('Quan tâm');
    // ZaloLabel mirror also drops the row.
    const labelsLeft = await prisma.zaloLabel.findMany({ where: { zaloAccountId: account.id } });
    expect(labelsLeft).toHaveLength(1);
    await app.close();
  });

  it('adopts a name-collision CRM tag', async () => {
    const { org, user, account } = await seed('C');
    // Pre-create a CRM-only tag with the same name.
    await prisma.crmTag.create({
      data: { orgId: org.id, name: 'VIP', normalizedName: 'vip', color: '#000000' },
    });
    getLabelsMock.mockResolvedValue({
      labelData: [sampleLabel(1, 'VIP', '#ff5252')],
      version: 1,
    });

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.synced.adopted).toBe(1);
    expect(body.synced.labelsCreated).toBe(0);
    expect(body.synced.labelsUpdated).toBe(1);

    const tag = await prisma.crmTag.findFirst({ where: { orgId: org.id, normalizedName: 'vip' } });
    expect(tag?.managedBy).toBe('zalo_sync');
    expect(tag?.sourceZaloLabelId).toBe('1');
    expect(tag?.color).toBe('#ff5252'); // adopted Zalo's color
    await app.close();
  });

  it('member → 403', async () => {
    const { org, user, account } = await seed('D', 'member');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    expect(res.statusCode).toBe(403);
    expect(getLabelsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('cross-org account → 404', async () => {
    const { account: accountA } = await seed('E1');
    const { org: orgB, user: ownerB } = await seed('E2');
    const app = await buildApp({ id: ownerB.id, orgId: orgB.id, role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${accountA.id}/sync-labels`,
    });
    expect(res.statusCode).toBe(404);
    expect(getLabelsMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('account not connected → 400 ZALO_NOT_LOGGED_IN', async () => {
    const { org, user, account } = await seed('F');
    zaloPoolMock.getInstance.mockReturnValueOnce(null as any);

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('ZALO_NOT_LOGGED_IN');
    await app.close();
  });

  it('zca-js throws → 502 ZALO_BRIDGE_ERROR', async () => {
    const { org, user, account } = await seed('G');
    getLabelsMock.mockRejectedValue(new Error('upstream down'));

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).code).toBe('ZALO_BRIDGE_ERROR');
    await app.close();
  });

  it('idempotent — re-sync of identical catalog updates, does not duplicate', async () => {
    const { org, user, account } = await seed('H');
    getLabelsMock.mockResolvedValue({
      labelData: [sampleLabel(1, 'VIP')],
      version: 1,
    });
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'owner' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${account.id}/sync-labels`,
    });
    const body2 = JSON.parse(res2.payload);
    expect(body2.synced.labelsCreated).toBe(0);
    expect(body2.synced.labelsUpdated).toBe(1);
    expect(body2.synced.labelsArchived).toBe(0);

    const tagCount = await prisma.crmTag.count({ where: { orgId: org.id } });
    expect(tagCount).toBe(1);
    await app.close();
  });
});
