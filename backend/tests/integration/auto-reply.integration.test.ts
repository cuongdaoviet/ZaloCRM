/**
 * Integration tests for feature 0005 — auto-reply routes (CRUD) and the
 * maybeAutoReply service path. Real Postgres + Fastify inject for the HTTP
 * boundary; the zca-js api boundary and rate limiter are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const sendMessageMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { sendMessage: sendMessageMock } })),
};
const rateLimiterMock = {
  checkLimits: vi.fn(() => ({ allowed: true })),
  recordSend: vi.fn(),
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
vi.mock('../../src/modules/zalo/zalo-rate-limiter.js', () => ({
  zaloRateLimiter: rateLimiterMock,
}));
vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'admin' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seed() {
  const org = await prisma.organization.create({ data: { name: 'AR Org' } });
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
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      status: 'connected',
      zaloUid: 'self-uid',
    },
  });
  return { org, owner, account };
}

async function buildRouteApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { autoReplyRoutes } = await import(
    '../../src/modules/auto-reply/auto-reply-routes.js'
  );
  await app.register(autoReplyRoutes);
  return app;
}

describe('Auto-reply CRUD routes', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    rateLimiterMock.checkLimits.mockReturnValue({ allowed: true });
    zaloPoolMock.getInstance.mockReturnValue({
      api: { sendMessage: sendMessageMock },
    });
  });

  it('GET returns 404 when no rule exists', async () => {
    const { org, owner, account } = await seed();
    const app = await buildRouteApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PUT creates a rule, GET returns it', async () => {
    const { org, owner, account } = await seed();
    const app = await buildRouteApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
      payload: { message: 'OOO test', startMinute: 480, endMinute: 1080 },
    });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.payload).message).toBe('OOO test');
    await app.close();
  });

  it('PUT is idempotent — second PUT updates the same row', async () => {
    const { org, owner, account } = await seed();
    const app = await buildRouteApp({ id: owner.id, orgId: org.id, role: 'owner' });

    await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
      payload: { message: 'v1' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
      payload: { message: 'v2' },
    });
    expect(await prisma.autoReplyRule.count()).toBe(1);
    const row = await prisma.autoReplyRule.findFirst();
    expect(row?.message).toBe('v2');
    await app.close();
  });

  it('AC-0008: rejects start >= end with 400', async () => {
    const { org, owner, account } = await seed();
    const app = await buildRouteApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
      payload: { message: 'x', startMinute: 1080, endMinute: 480 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0009: rejects invalid timezone with 400', async () => {
    const { org, owner, account } = await seed();
    const app = await buildRouteApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
      payload: { message: 'x', timezone: 'Mars/Olympus' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0010: member without admin access on the Zalo account → 403', async () => {
    const { org, account } = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'M',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'chat' },
    });
    const app = await buildRouteApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('DELETE clears the rule and history', async () => {
    const { org, owner, account } = await seed();
    const app = await buildRouteApp({ id: owner.id, orgId: org.id, role: 'owner' });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
      payload: { message: 'x' },
    });
    // Insert a history row directly
    const rule = await prisma.autoReplyRule.findFirst();
    await prisma.autoReplyHistory.create({
      data: { ruleId: rule!.id, contactUid: 'uid-1', sentAt: new Date() },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/zalo-accounts/${account.id}/auto-reply`,
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.autoReplyRule.count()).toBe(0);
    expect(await prisma.autoReplyHistory.count()).toBe(0);
    await app.close();
  });

  it('returns 404 for an account in another org', async () => {
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
    const otherAccount = await prisma.zaloAccount.create({
      data: { orgId: otherOrg.id, ownerUserId: otherOwner.id, status: 'connected' },
    });
    const app = await buildRouteApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo-accounts/${otherAccount.id}/auto-reply`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('maybeAutoReply (service)', () => {
  // Cover the BR rules end-to-end: passesStaticGates, cooldown, recent-staff
  // activity, rate limiting, and the message + history rows that get written.

  // Helper: insert a rule with a window that covers ICT 08:00-18:00 so any
  // now-ish call to the service is AFTER hours and should trigger.
  async function seedAccountAndRule(opts: {
    enabled?: boolean;
    daysOfWeek?: number;
  } = {}) {
    const { org, owner, account } = await seed();
    const contact = await prisma.contact.create({
      data: { orgId: org.id, zaloUid: 'remote-uid', fullName: 'Khách Anh' },
    });
    const conv = await prisma.conversation.create({
      data: {
        orgId: org.id,
        zaloAccountId: account.id,
        contactId: contact.id,
        threadType: 'user',
        externalThreadId: 'remote-uid',
      },
    });
    // Use Sunday so MON-FRI=62 default rule is OUTSIDE active window regardless of hour
    const rule = await prisma.autoReplyRule.create({
      data: {
        zaloAccountId: account.id,
        enabled: opts.enabled !== false,
        daysOfWeek: opts.daysOfWeek ?? 62,
        startMinute: 480,
        endMinute: 1080,
        timezone: 'Asia/Ho_Chi_Minh',
        message: 'Hello {{firstName}}, OOO',
        cooldownMinutes: 240,
      },
    });
    return { org, owner, account, contact, conv, rule };
  }

  function importService() {
    return import('../../src/modules/auto-reply/auto-reply-service.js');
  }

  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    rateLimiterMock.checkLimits.mockReturnValue({ allowed: true });
    zaloPoolMock.getInstance.mockReturnValue({
      api: { sendMessage: sendMessageMock },
    });
  });

  it('AC-0001: sends an auto-reply outside active window', async () => {
    // Disable Mon-Fri so any weekday passes the static gate
    const { account, conv, contact } = await seedAccountAndRule({ daysOfWeek: 0 });
    const { maybeAutoReply } = await importService();

    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: false,
      conversationContactId: contact.id,
    });

    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(sendMessageMock.mock.calls[0][0]).toEqual({ msg: 'Hello Khách, OOO' });
    expect(await prisma.autoReplyHistory.count()).toBe(1);
    expect(await prisma.message.count()).toBe(1);
  });

  it('AC-0002: second message within cooldown does NOT trigger', async () => {
    const { account, conv, contact } = await seedAccountAndRule({ daysOfWeek: 0 });
    const { maybeAutoReply } = await importService();

    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: false,
      conversationContactId: contact.id,
    });
    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: false,
      conversationContactId: contact.id,
    });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(await prisma.autoReplyHistory.count()).toBe(1);
  });

  it('AC-0004: group threads are skipped', async () => {
    const { account, conv, contact } = await seedAccountAndRule({ daysOfWeek: 0 });
    const { maybeAutoReply } = await importService();

    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: 'group-1',
      threadType: 'group',
      isSelf: false,
      conversationContactId: contact.id,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('AC-0005: self messages are skipped', async () => {
    const { account, conv, contact } = await seedAccountAndRule({ daysOfWeek: 0 });
    const { maybeAutoReply } = await importService();

    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: true,
      conversationContactId: contact.id,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('AC-0006: disabled rules do NOT trigger', async () => {
    const { account, conv, contact } = await seedAccountAndRule({
      enabled: false,
      daysOfWeek: 0,
    });
    const { maybeAutoReply } = await importService();

    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: false,
      conversationContactId: contact.id,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('AC-0007: skips if staff replied in the last 5 minutes', async () => {
    const { account, conv, contact, owner } = await seedAccountAndRule({ daysOfWeek: 0 });
    // Insert a recent staff reply
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        senderType: 'self',
        senderUid: 'self-uid',
        senderName: 'Owner',
        content: 'I am here',
        contentType: 'text',
        sentAt: new Date(Date.now() - 60_000), // 1 min ago
        repliedByUserId: owner.id,
      },
    });
    const { maybeAutoReply } = await importService();

    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: false,
      conversationContactId: contact.id,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('skips when rate limiter blocks', async () => {
    const { account, conv, contact } = await seedAccountAndRule({ daysOfWeek: 0 });
    rateLimiterMock.checkLimits.mockReturnValueOnce({
      allowed: false,
      reason: 'limit hit',
    } as any);
    const { maybeAutoReply } = await importService();

    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: false,
      conversationContactId: contact.id,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(await prisma.autoReplyHistory.count()).toBe(0); // no ledger row written
  });

  it('skips silently when no rule exists', async () => {
    const { account, conv, contact } = await seed().then(async (seed) => {
      const c = await prisma.contact.create({
        data: { orgId: seed.org.id, zaloUid: 'uid', fullName: 'X' },
      });
      const cv = await prisma.conversation.create({
        data: {
          orgId: seed.org.id,
          zaloAccountId: seed.account.id,
          contactId: c.id,
          threadType: 'user',
          externalThreadId: 'uid',
        },
      });
      return { account: seed.account, conv: cv, contact: c };
    });
    const { maybeAutoReply } = await importService();
    await maybeAutoReply({
      accountId: account.id,
      conversationId: conv.id,
      senderUid: contact.zaloUid!,
      threadType: 'user',
      isSelf: false,
      conversationContactId: contact.id,
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
