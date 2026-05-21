/**
 * Integration tests — feature 0031 reply / quote message.
 *
 * Coverage: every server-side AC from SPEC §6 (AC-0001..AC-0008). FE-only
 * ACs (0009..0011) are exercised by the build / manual checks; AC-0012 is
 * the build pass step in CI.
 *
 * Strategy:
 *   - Real Postgres via setup-db.
 *   - Fastify `inject` for the POST + GET endpoints.
 *   - zca-js boundary mocked via `zaloPool.getInstance().api.sendMessage`.
 *   - For inbound parse we call `handleIncomingMessage()` directly with a
 *     hand-rolled IncomingMessage payload (the upstream extractQuoteRef is
 *     unit-tested separately).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// ── Mocks ────────────────────────────────────────────────────────────────────
const sendMessageMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { sendMessage: sendMessageMock } })),
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
// chat-routes imports minio-client (used by attachment route); the package
// is optional in test env so stub it out. Reply tests never exercise upload.
vi.mock('../../src/shared/storage/minio-client.js', () => ({
  uploadBuffer: vi.fn(),
  ensureBucket: vi.fn().mockResolvedValue(undefined),
  minioClient: {},
}));
// Inbound mirror — never called in reply tests, but message-handler.ts
// imports it eagerly.
vi.mock('../../src/shared/storage/download-mirror.js', () => ({
  mirrorAttachment: vi.fn().mockResolvedValue(null),
}));
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
    if (!req.user) req.user = { id: 'test-user', orgId: 'org-stub', role: 'admin' };
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
  sendMessageMock.mockResolvedValue({ message: { msgId: 'sent-msgid' } });
  zaloPoolMock.getInstance.mockReturnValue({ api: { sendMessage: sendMessageMock } });
});

interface SeedResult {
  orgId: string;
  userId: string;
  accountId: string;
  conversationId: string;
  otherConversationId: string;
  parentMessageId: string;
  parentZaloMsgId: string;
}

/**
 * Seed: 1 org / 1 admin / 1 Zalo account / 2 conversations / 1 parent message
 * inside conversationId. otherConversationId is used for the cross-conv
 * validation case (AC-0003).
 */
async function seed(): Promise<SeedResult> {
  const org = await prisma.organization.create({ data: { name: 'Reply Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Admin',
      role: 'admin',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: user.id,
      status: 'connected',
      zaloUid: 'self-uid',
      displayName: 'Test Account',
    },
  });
  const contactA = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'A', zaloUid: 'zA' },
  });
  const contactB = await prisma.contact.create({
    data: { orgId: org.id, fullName: 'B', zaloUid: 'zB' },
  });
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contactA.id,
      threadType: 'user',
      externalThreadId: 'zA',
    },
  });
  const otherConv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contactB.id,
      threadType: 'user',
      externalThreadId: 'zB',
    },
  });
  const parent = await prisma.message.create({
    data: {
      conversationId: conv.id,
      zaloMsgId: 'parent-zaloid',
      senderType: 'contact',
      senderUid: 'zA',
      senderName: 'A',
      content: 'parent message body',
      contentType: 'text',
      sentAt: new Date(),
    },
  });
  return {
    orgId: org.id,
    userId: user.id,
    accountId: account.id,
    conversationId: conv.id,
    otherConversationId: otherConv.id,
    parentMessageId: parent.id,
    parentZaloMsgId: parent.zaloMsgId!,
  };
}

async function buildApp(user: {
  id: string;
  orgId: string;
  role: string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

// ═════════════════════════════════════════════════════════════════════════════
// AC-0001 — Schema migration: replyToMessageId column + FK + index exist
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0001 schema migration', () => {
  it('Message row accepts replyToMessageId set to an existing message id', async () => {
    const s = await seed();
    const child = await prisma.message.create({
      data: {
        conversationId: s.conversationId,
        senderType: 'self',
        senderUid: 'self-uid',
        senderName: 'Staff',
        content: 'child reply',
        contentType: 'text',
        sentAt: new Date(),
        replyToMessageId: s.parentMessageId,
      },
    });
    expect(child.replyToMessageId).toBe(s.parentMessageId);
  });

  it('SET NULL: deleting the parent leaves child rows with replyToMessageId=null', async () => {
    const s = await seed();
    const child = await prisma.message.create({
      data: {
        conversationId: s.conversationId,
        senderType: 'self',
        senderUid: 'self-uid',
        senderName: 'Staff',
        content: 'will outlive parent',
        contentType: 'text',
        sentAt: new Date(),
        replyToMessageId: s.parentMessageId,
      },
    });
    await prisma.message.delete({ where: { id: s.parentMessageId } });
    const reread = await prisma.message.findUnique({ where: { id: child.id } });
    expect(reread?.replyToMessageId).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0002 — POST with valid replyToMessageId → 200, FK set, zca-js called
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0002 POST with valid replyToMessageId', () => {
  it('persists the FK + returns the projection on the response body', async () => {
    const s = await seed();
    const app = await buildApp({ id: s.userId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversationId}/messages`,
      payload: {
        content: 'phản hồi cụ thể tin này',
        replyToMessageId: s.parentMessageId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.replyToMessageId).toBe(s.parentMessageId);
    expect(body.replyToMessage).toBeTruthy();
    expect(body.replyToMessage.id).toBe(s.parentMessageId);
    expect(body.replyToMessage.content).toBe('parent message body');
    expect(body.replyToMessage.senderType).toBe('contact');

    const dbRow = await prisma.message.findUnique({ where: { id: body.id } });
    expect(dbRow?.replyToMessageId).toBe(s.parentMessageId);
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0003 — POST with replyToMessageId from a different conversation → 400
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0003 cross-conversation reply target', () => {
  it('rejects with 400 and reply_target_invalid code', async () => {
    const s = await seed();
    const foreign = await prisma.message.create({
      data: {
        conversationId: s.otherConversationId,
        zaloMsgId: 'foreign-zaloid',
        senderType: 'contact',
        senderUid: 'zB',
        senderName: 'B',
        content: 'parent in another conversation',
        contentType: 'text',
        sentAt: new Date(),
      },
    });
    const app = await buildApp({ id: s.userId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversationId}/messages`,
      payload: { content: 'oops', replyToMessageId: foreign.id },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('reply_target_invalid');
    expect(sendMessageMock).not.toHaveBeenCalled();
    // No row leaked into the target conversation.
    const count = await prisma.message.count({
      where: { conversationId: s.conversationId },
    });
    expect(count).toBe(1); // only the seeded parent
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0004 — POST with non-existent replyToMessageId → 400
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0004 non-existent reply target', () => {
  it('rejects with 400 reply_target_invalid', async () => {
    const s = await seed();
    const app = await buildApp({ id: s.userId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversationId}/messages`,
      payload: {
        content: 'reply to ghost',
        replyToMessageId: '00000000-0000-0000-0000-000000000000',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('reply_target_invalid');
    expect(sendMessageMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0005 — zca-js sendMessage called with a `quote` arg matching shape
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0005 zca-js quote arg shape', () => {
  it('passes { msgId, content, senderId, ts } in the quote arg', async () => {
    const s = await seed();
    const app = await buildApp({ id: s.userId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversationId}/messages`,
      payload: { content: 'reply text', replyToMessageId: s.parentMessageId },
    });
    expect(res.statusCode).toBe(200);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [arg, threadId, threadType] = sendMessageMock.mock.calls[0];
    expect(arg.msg).toBe('reply text');
    expect(arg.quote).toBeTruthy();
    expect(arg.quote.msgId).toBe(s.parentZaloMsgId);
    expect(arg.quote.content).toBe('parent message body');
    expect(arg.quote.senderId).toBe('zA');
    expect(typeof arg.quote.ts).toBe('number');
    expect(threadId).toBe('zA');
    expect(threadType).toBe(0);
    await app.close();
  });

  it('omits the quote arg when no replyToMessageId is provided (back-compat)', async () => {
    const s = await seed();
    const app = await buildApp({ id: s.userId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${s.conversationId}/messages`,
      payload: { content: 'plain message no reply' },
    });
    expect(res.statusCode).toBe(200);
    const [arg] = sendMessageMock.mock.calls[0];
    expect(arg.quote).toBeUndefined();
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0006 — Inbound message with quote ref to existing local message
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0006 inbound quote resolves to local FK', () => {
  it('sets replyToMessageId when the quote msgId matches a local message', async () => {
    const s = await seed();
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const result = await handleIncomingMessage({
      accountId: s.accountId,
      senderUid: 'zA',
      senderName: 'A',
      content: 'reply from contact',
      contentType: 'text',
      msgId: 'inbound-reply-1',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'zA',
      threadType: 'user',
      attachments: [],
      quoteRef: {
        msgId: s.parentZaloMsgId,
        content: 'parent message body',
        senderUid: 'self-uid',
        ts: Date.now() - 60_000,
      },
    });
    expect(result).not.toBeNull();
    const row = await prisma.message.findUnique({ where: { id: result!.message.id } });
    expect(row?.replyToMessageId).toBe(s.parentMessageId);
    // Content remained the user's plain text — no quotedMeta envelope.
    expect(row?.content).toBe('reply from contact');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0007 — Inbound message with quote ref to message NOT in DB
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0007 inbound quote with absent target', () => {
  it('persists quotedMeta in content JSON, leaves replyToMessageId null', async () => {
    const s = await seed();
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const result = await handleIncomingMessage({
      accountId: s.accountId,
      senderUid: 'zA',
      senderName: 'A',
      content: 'reply to legacy zalo message',
      contentType: 'text',
      msgId: 'inbound-reply-orphan',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'zA',
      threadType: 'user',
      attachments: [],
      quoteRef: {
        msgId: 'unknown-zalo-msgid-not-in-db',
        content: 'tin nhắn cũ',
        senderUid: 'self-uid',
        ts: Date.now() - 600_000,
      },
    });
    expect(result).not.toBeNull();
    const row = await prisma.message.findUnique({ where: { id: result!.message.id } });
    expect(row?.replyToMessageId).toBeNull();
    expect(row?.content).toBeTruthy();
    const parsed = JSON.parse(row!.content!);
    expect(parsed.text).toBe('reply to legacy zalo message');
    expect(parsed.quotedMeta).toBeTruthy();
    expect(parsed.quotedMeta.msgId).toBe('unknown-zalo-msgid-not-in-db');
    expect(parsed.quotedMeta.content).toBe('tin nhắn cũ');
  });

  it('truncates very long inbound quote previews to 200 chars + ellipsis', async () => {
    const s = await seed();
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const longText = 'x'.repeat(500);
    const result = await handleIncomingMessage({
      accountId: s.accountId,
      senderUid: 'zA',
      senderName: 'A',
      content: 'short reply',
      contentType: 'text',
      msgId: 'inbound-reply-long',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'zA',
      threadType: 'user',
      attachments: [],
      quoteRef: {
        msgId: 'absent',
        content: longText,
        senderUid: 'self-uid',
        ts: Date.now(),
      },
    });
    const row = await prisma.message.findUnique({ where: { id: result!.message.id } });
    const parsed = JSON.parse(row!.content!);
    expect(parsed.quotedMeta.content.length).toBe(201); // 200 + 1 ellipsis char
    expect(parsed.quotedMeta.content.endsWith('…')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC-0008 — GET conversation messages includes replyToMessage projection
// ═════════════════════════════════════════════════════════════════════════════
describe('AC-0008 GET projection', () => {
  it('eager-loads replyToMessage on listing endpoint and truncates to 200 chars', async () => {
    const s = await seed();
    // Replace parent content with a very long string so we can assert the
    // server-side truncation (BR-0007).
    const longText = 'a'.repeat(400);
    await prisma.message.update({
      where: { id: s.parentMessageId },
      data: { content: longText },
    });
    const child = await prisma.message.create({
      data: {
        conversationId: s.conversationId,
        senderType: 'self',
        senderUid: 'self-uid',
        senderName: 'Staff',
        content: 'reply to long parent',
        contentType: 'text',
        sentAt: new Date(),
        replyToMessageId: s.parentMessageId,
      },
    });
    const app = await buildApp({ id: s.userId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${s.conversationId}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const childRow = (body.messages as Array<{ id: string; replyToMessage?: any }>).find(
      (m) => m.id === child.id,
    );
    expect(childRow).toBeTruthy();
    expect(childRow!.replyToMessage).toBeTruthy();
    expect(childRow!.replyToMessage.id).toBe(s.parentMessageId);
    // 200 chars + 1 ellipsis.
    expect(childRow!.replyToMessage.content.length).toBe(201);
    expect(childRow!.replyToMessage.content.endsWith('…')).toBe(true);
    await app.close();
  });

  it('returns null replyToMessage on plain non-reply messages', async () => {
    const s = await seed();
    const app = await buildApp({ id: s.userId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${s.conversationId}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // Seeded parent is a non-reply — replyToMessage should be null.
    expect(body.messages[0].replyToMessage).toBeNull();
    await app.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Unit-flavoured: extractQuoteRef tolerates both `quote` and `quoted` keys
// ═════════════════════════════════════════════════════════════════════════════
describe('extractQuoteRef shape tolerance', () => {
  it('reads from data.quote', async () => {
    const { extractQuoteRef } = await import(
      '../../src/modules/zalo/zalo-message-helpers.js'
    );
    const ref = extractQuoteRef({
      quote: { msgId: '1', content: 'x', senderId: 'u', ts: 1234 },
    });
    expect(ref).toEqual({ msgId: '1', content: 'x', senderUid: 'u', ts: 1234 });
  });

  it('reads from data.quoted as a fallback', async () => {
    const { extractQuoteRef } = await import(
      '../../src/modules/zalo/zalo-message-helpers.js'
    );
    const ref = extractQuoteRef({
      quoted: { msgId: '2', msg: 'y', uidFrom: 'u2', ts: '5678' },
    });
    expect(ref).toEqual({ msgId: '2', content: 'y', senderUid: 'u2', ts: 5678 });
  });

  it('returns null when no quote ref is present', async () => {
    const { extractQuoteRef } = await import(
      '../../src/modules/zalo/zalo-message-helpers.js'
    );
    expect(extractQuoteRef({})).toBeNull();
    expect(extractQuoteRef(null)).toBeNull();
    expect(extractQuoteRef({ quote: { content: 'no msgid' } })).toBeNull();
  });

  it('stringifies non-string content (image envelope etc.)', async () => {
    const { extractQuoteRef } = await import(
      '../../src/modules/zalo/zalo-message-helpers.js'
    );
    const ref = extractQuoteRef({
      quote: {
        msgId: '3',
        content: { href: 'https://x' },
        senderId: 'u3',
        ts: 9,
      },
    });
    expect(ref?.content).toBe('{"href":"https://x"}');
  });
});
