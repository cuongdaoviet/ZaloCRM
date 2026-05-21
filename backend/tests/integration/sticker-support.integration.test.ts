/**
 * Integration tests — Feature 0028 sticker support.
 *
 * Coverage matrix:
 *   AC-0001 — inbound sticker persists with contentType='sticker'
 *   AC-0003 — POST /conversations/:id/stickers → 200 + DB row + zca-js called
 *   AC-0004 — GET /zalo/stickers/:id → 200 with cdnUrl
 *   AC-0005 — GET /zalo/sticker-catalogues → 200 with >=1 catalogue
 *   AC-0006 — sticker detail cached: 2 calls in 24h → SDK invoked once
 *   AC-0007 — member without ACL → 403 on all 3 endpoints
 *
 * AC-0002 + AC-0008 cover the FE render branch and picker UX — see the
 * Vitest suites under `frontend/src/components/chat/__tests__/`.
 * AC-0009 is "build pass": running the full vitest+tsc gauntlet IS the AC.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// ── Mocks ────────────────────────────────────────────────────────────────────

const sendStickerMock = vi.fn();
const getStickersDetailMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({
    api: {
      sendSticker: sendStickerMock,
      getStickersDetail: getStickersDetailMock,
    },
  })),
};

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));
vi.mock('../../src/modules/zalo/zalo-rate-limiter.js', () => ({
  zaloRateLimiter: {
    checkLimits: vi.fn(() => ({ allowed: true })),
    recordSend: vi.fn(),
  },
}));
vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'owner' };
  },
}));

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await resetDb(prisma);
  vi.clearAllMocks();
  sendStickerMock.mockResolvedValue({ msgId: 9001 });
  getStickersDetailMock.mockResolvedValue([
    {
      id: 4179,
      cateId: 1,
      type: 1,
      stickerUrl: 'https://cdn.zalo.test/stickers/4179.png',
      stickerWebpUrl: 'https://cdn.zalo.test/stickers/4179.webp',
      stickerSpriteUrl: '',
      totalFrames: 12,
      duration: 1200,
    },
  ]);
  zaloPoolMock.getInstance.mockReturnValue({
    api: {
      sendSticker: sendStickerMock,
      getStickersDetail: getStickersDetailMock,
    },
  });

  const { __resetStickerCache } = await import(
    '../../src/modules/zalo/zalo-sticker-routes.js'
  );
  __resetStickerCache();
});

// ── Seed ─────────────────────────────────────────────────────────────────────

interface Seed {
  owner: { id: string; orgId: string; role: 'owner' };
  member: { id: string; orgId: string; role: 'member' };
  account: { id: string; zaloUid: string };
  conversation: { id: string; externalThreadId: string };
}

async function seed(): Promise<Seed> {
  const tag = Math.random().toString(36).slice(2, 8);
  const org = await prisma.organization.create({ data: { name: `S Org ${tag}` } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${tag}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${tag}@test.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: owner.id,
      status: 'connected',
      zaloUid: `zuid-${tag}`,
      displayName: 'Test Account',
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      threadType: 'user',
      externalThreadId: `thread-${tag}`,
    },
  });
  return {
    owner: { id: owner.id, orgId: org.id, role: 'owner' },
    member: { id: member.id, orgId: org.id, role: 'member' },
    account: { id: account.id, zaloUid: account.zaloUid! },
    conversation: { id: conversation.id, externalThreadId: conversation.externalThreadId! },
  };
}

async function buildChatApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

async function buildStickerApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { zaloStickerRoutes } = await import(
    '../../src/modules/zalo/zalo-sticker-routes.js'
  );
  await app.register(zaloStickerRoutes);
  return app;
}

// ═════════════════════════════════════════════════════════════════════════════
// AC-0001 — inbound sticker persists with contentType='sticker'
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0001 inbound sticker persistence', () => {
  it('handleIncomingMessage stores contentType=sticker + content JSON', async () => {
    const s = await seed();
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const contentJson = JSON.stringify({ id: 4179, catId: 1, type: 1 });
    const result = await handleIncomingMessage({
      accountId: s.account.id,
      senderUid: 'remote-uid',
      senderName: 'KH',
      content: contentJson,
      contentType: 'sticker',
      msgId: 'zmsg-sticker-1',
      timestamp: Date.now(),
      isSelf: false,
      threadId: s.conversation.externalThreadId,
      threadType: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.message.contentType).toBe('sticker');
    expect(result!.message.content).toBe(contentJson);

    const rows = await prisma.message.findMany({
      where: { conversationId: result!.conversationId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].contentType).toBe('sticker');
    const parsed = JSON.parse(rows[0].content || '{}');
    expect(parsed.id).toBe(4179);
    expect(parsed.catId).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0003 — POST /conversations/:id/stickers
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0003 POST sticker', () => {
  it('200 → calls zca-js sendSticker + persists Message + emits cdnUrl', async () => {
    const s = await seed();
    const app = await buildChatApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversation.id}/stickers`,
      payload: { stickerId: 4179, catId: 1, type: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.messageId).toBeTypeOf('string');
    expect(body.sticker).toMatchObject({
      stickerId: 4179,
      catId: 1,
      type: 1,
      cdnUrl: 'https://cdn.zalo.test/stickers/4179.webp',
    });

    const rows = await prisma.message.findMany({
      where: { conversationId: s.conversation.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].contentType).toBe('sticker');
    expect(rows[0].zaloMsgId).toBe('9001');
    const persisted = JSON.parse(rows[0].content || '{}');
    expect(persisted.stickerId).toBe(4179);
    expect(persisted.cdnUrl).toBe('https://cdn.zalo.test/stickers/4179.webp');

    expect(sendStickerMock).toHaveBeenCalledTimes(1);
    const [stickerArg, threadId, threadType] = sendStickerMock.mock.calls[0];
    expect(stickerArg).toEqual({ id: 4179, cateId: 1, type: 1 });
    expect(threadId).toBe(s.conversation.externalThreadId);
    expect(threadType).toBe(0);
    await app.close();
  });

  it('400 on missing fields → invalid_body, SDK not called', async () => {
    const s = await seed();
    const app = await buildChatApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversation.id}/stickers`,
      payload: { stickerId: 4179 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('invalid_body');
    expect(sendStickerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('502 zalo_send_failed when SDK throws', async () => {
    const s = await seed();
    sendStickerMock.mockRejectedValueOnce(new Error('boom'));
    const app = await buildChatApp(s.owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversation.id}/stickers`,
      payload: { stickerId: 4179, catId: 1, type: 1 },
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).code).toBe('zalo_send_failed');
    const rows = await prisma.message.findMany({
      where: { conversationId: s.conversation.id },
    });
    expect(rows).toHaveLength(0);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0004 — GET /zalo/stickers/:id
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0004 GET sticker detail', () => {
  it('200 returns cdnUrl + animationType', async () => {
    const s = await seed();
    const app = await buildStickerApp(s.owner);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/stickers/4179?catId=1&accountId=${s.account.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toMatchObject({
      stickerId: 4179,
      catId: 1,
      type: 1,
      cdnUrl: 'https://cdn.zalo.test/stickers/4179.webp',
      animationType: 'animated',
    });
    expect(getStickersDetailMock).toHaveBeenCalledWith([4179]);
    await app.close();
  });

  it('502 sticker_lookup_failed when SDK returns nothing', async () => {
    const s = await seed();
    getStickersDetailMock.mockResolvedValueOnce([]);
    const app = await buildStickerApp(s.owner);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/stickers/9999?accountId=${s.account.id}`,
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).code).toBe('sticker_lookup_failed');
    await app.close();
  });

  it('503 when the account has no live SDK instance', async () => {
    const s = await seed();
    zaloPoolMock.getInstance.mockReturnValueOnce(undefined as any);
    const app = await buildStickerApp(s.owner);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/stickers/4179?accountId=${s.account.id}`,
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload).code).toBe('account_offline');
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0005 — GET /zalo/sticker-catalogues
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0005 GET sticker catalogues', () => {
  it('200 → returns at least 1 catalogue with stickers (phase 1 hardcoded)', async () => {
    const s = await seed();
    const app = await buildStickerApp(s.owner);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/sticker-catalogues?accountId=${s.account.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body.catalogues)).toBe(true);
    expect(body.catalogues.length).toBeGreaterThanOrEqual(1);
    const first = body.catalogues[0];
    expect(first.name).toBeTypeOf('string');
    expect(Array.isArray(first.stickers)).toBe(true);
    expect(first.stickers.length).toBeGreaterThanOrEqual(20);
    expect(first.stickers[0]).toMatchObject({
      stickerId: expect.any(Number),
      catId: expect.any(Number),
      type: expect.any(Number),
    });
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0006 — sticker detail cached for 24h
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0006 sticker detail cache', () => {
  it('two calls within 24h → getStickersDetail invoked once', async () => {
    const s = await seed();
    const app = await buildStickerApp(s.owner);

    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/stickers/4179?accountId=${s.account.id}`,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/stickers/4179?accountId=${s.account.id}`,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(getStickersDetailMock).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0007 — member without ACL → 403 on all 3 endpoints
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0007 ACL — member without chat permission', () => {
  it('POST /conversations/:id/stickers → 403', async () => {
    const s = await seed();
    const app = await buildChatApp(s.member);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversation.id}/stickers`,
      payload: { stickerId: 4179, catId: 1, type: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(sendStickerMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /zalo/stickers/:id → 403', async () => {
    const s = await seed();
    const app = await buildStickerApp(s.member);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/stickers/4179?accountId=${s.account.id}`,
    });
    expect(res.statusCode).toBe(403);
    expect(getStickersDetailMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /zalo/sticker-catalogues → 403', async () => {
    const s = await seed();
    const app = await buildStickerApp(s.member);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/sticker-catalogues?accountId=${s.account.id}`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('member with chat ACL is allowed', async () => {
    const s = await seed();
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: s.account.id, userId: s.member.id, permission: 'chat' },
    });
    const app = await buildStickerApp(s.member);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo/sticker-catalogues?accountId=${s.account.id}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-org isolation (defence in depth — POST sticker)
// ═════════════════════════════════════════════════════════════════════════════
describe('POST sticker cross-org isolation', () => {
  it('owner from a different org gets 404 (not 200)', async () => {
    const s = await seed();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other org' } });
    const otherOwner = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `oo-${Math.random()}@test.local`,
        passwordHash: 'h',
        fullName: 'Other',
        role: 'owner',
      },
    });
    const app = await buildChatApp({
      id: otherOwner.id,
      orgId: otherOrg.id,
      role: 'owner',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversation.id}/stickers`,
      payload: { stickerId: 4179, catId: 1, type: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(sendStickerMock).not.toHaveBeenCalled();
    await app.close();
  });
});
