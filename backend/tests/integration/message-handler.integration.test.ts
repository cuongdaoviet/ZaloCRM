/**
 * Integration test: handleIncomingMessage against a REAL Postgres
 * provisioned via testcontainers. Verifies the dedupe contract and the
 * @@index([zaloMsgId]) migration end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// Replace the singleton prisma client with our testcontainers-backed client
vi.mock('../../src/shared/database/prisma-client.js', async () => {
  return {
    get prisma() {
      return prisma;
    },
  };
});

vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));

// Feature 0027 — mock the inbound mirror. By default the mirror does
// nothing (returns null) so existing tests keep their original content.
// Per-test we override this to assert mirror behaviour explicitly.
const mirrorAttachmentMock = vi.fn();
vi.mock('../../src/shared/storage/download-mirror.js', () => ({
  mirrorAttachment: mirrorAttachmentMock,
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

// Helpers — create the minimal fixtures (org + zalo account) needed
async function seedOrgAndAccount() {
  const org = await prisma.organization.create({ data: { name: 'Test Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `owner-${Date.now()}@test.local`,
      passwordHash: 'hash',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: user.id, status: 'connected' },
  });
  return { org, user, account };
}

describe('handleIncomingMessage — integration (real Postgres)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    // Default: mirror does nothing — keep the original Zalo URL so the
    // existing dedupe/conversation tests are unaffected by feature 0027.
    mirrorAttachmentMock.mockReset();
    mirrorAttachmentMock.mockResolvedValue(null);
  });

  it('inserts a message exactly once for a unique zaloMsgId', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    const msg = {
      accountId: account.id,
      senderUid: 'uid-A',
      senderName: 'Alice',
      content: 'hello',
      contentType: 'text',
      msgId: 'zalo-001',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-A',
      threadType: 'user' as const,
      attachments: [],
    };

    const result = await handleIncomingMessage(msg);
    expect(result).not.toBeNull();

    const count = await prisma.message.count({ where: { zaloMsgId: 'zalo-001' } });
    expect(count).toBe(1);
  });

  it('AC-0004: calling twice with same zaloMsgId inserts only one row', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    const msg = {
      accountId: account.id,
      senderUid: 'uid-B',
      senderName: 'Bob',
      content: 'duplicate test',
      contentType: 'text',
      msgId: 'zalo-dup',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-B',
      threadType: 'user' as const,
      attachments: [],
    };

    const r1 = await handleIncomingMessage(msg);
    const r2 = await handleIncomingMessage(msg);

    expect(r1).not.toBeNull();
    expect(r2).toBeNull(); // dedupe short-circuits

    const count = await prisma.message.count({ where: { zaloMsgId: 'zalo-dup' } });
    expect(count).toBe(1);
  });

  it('inserts both messages when msgId differs', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();
    const base = {
      accountId: account.id,
      senderUid: 'uid-C',
      senderName: 'Carol',
      contentType: 'text',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-C',
      threadType: 'user' as const,
      attachments: [],
    };

    await handleIncomingMessage({ ...base, content: 'one', msgId: 'zalo-a' });
    await handleIncomingMessage({ ...base, content: 'two', msgId: 'zalo-b' });

    const total = await prisma.message.count();
    expect(total).toBe(2);
  });

  it('reuses the conversation across messages for the same thread', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();
    const base = {
      accountId: account.id,
      senderUid: 'uid-D',
      senderName: 'Dave',
      contentType: 'text',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-D',
      threadType: 'user' as const,
      attachments: [],
    };

    await handleIncomingMessage({ ...base, content: 'm1', msgId: 'zalo-x' });
    await handleIncomingMessage({ ...base, content: 'm2', msgId: 'zalo-y' });

    const convCount = await prisma.conversation.count();
    expect(convCount).toBe(1); // only one conversation row reused

    const conv = await prisma.conversation.findFirst();
    // unreadCount math is owned by updateConversationAfterMessage: +1 per
    // contact message, reset to 0 per self message. Two contact messages → 2.
    expect(conv?.unreadCount).toBe(2);
    expect(conv?.isReplied).toBe(false);
  });

  it('first contact message creates conversation with unreadCount=1 (not double-counted)', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-F',
      senderName: 'Frank',
      content: 'first',
      contentType: 'text',
      msgId: 'zalo-first',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-F',
      threadType: 'user' as const,
      attachments: [],
    });

    const conv = await prisma.conversation.findFirst();
    expect(conv?.unreadCount).toBe(1);
    expect(conv?.isReplied).toBe(false);
  });

  it('first self message creates conversation with unreadCount=0 and isReplied=true', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-self',
      senderName: '',
      content: 'hi from me',
      contentType: 'text',
      msgId: 'zalo-self',
      timestamp: Date.now(),
      isSelf: true,
      threadId: 'uid-G',
      threadType: 'user' as const,
      attachments: [],
    });

    const conv = await prisma.conversation.findFirst();
    expect(conv?.unreadCount).toBe(0);
    expect(conv?.isReplied).toBe(true);
  });

  it('self reply resets unreadCount and flips isReplied=true', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();
    const base = {
      accountId: account.id,
      senderUid: 'uid-E',
      senderName: 'Eve',
      contentType: 'text',
      timestamp: Date.now(),
      threadId: 'uid-E',
      threadType: 'user' as const,
      attachments: [],
    };

    // Two contact messages → unreadCount=2, isReplied=false
    await handleIncomingMessage({ ...base, content: 'c1', msgId: 'zalo-c1', isSelf: false });
    await handleIncomingMessage({ ...base, content: 'c2', msgId: 'zalo-c2', isSelf: false });
    let conv = await prisma.conversation.findFirst();
    expect(conv?.unreadCount).toBe(2);
    expect(conv?.isReplied).toBe(false);

    // Self reply → unreadCount=0, isReplied=true
    await handleIncomingMessage({ ...base, content: 'self reply', msgId: 'zalo-c3', isSelf: true });
    conv = await prisma.conversation.findFirst();
    expect(conv?.unreadCount).toBe(0);
    expect(conv?.isReplied).toBe(true);

    // Another contact message → unreadCount=1 again
    await handleIncomingMessage({ ...base, content: 'c4', msgId: 'zalo-c4', isSelf: false });
    conv = await prisma.conversation.findFirst();
    expect(conv?.unreadCount).toBe(1);
    expect(conv?.isReplied).toBe(false);
  });

  // ── Feature 0027 — inbound attachment mirror ───────────────────────────
  // AC-0007 / AC-0008. The mirror is best-effort: success swaps the Zalo
  // URL inside the JSON envelope for a MinIO URL; failure keeps the
  // original. Either way the message persists (BR-0008).

  it('AC-0007: image inbound — mirror success swaps href to MinIO URL', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    mirrorAttachmentMock.mockResolvedValueOnce({
      key: '2026-05-21/abc.jpg',
      url: 'http://minio.test/zalocrm-attachments/2026-05-21/abc.jpg',
      size: 100,
      mimeType: 'image/jpeg',
    });

    const result = await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-img',
      senderName: 'Img',
      content: JSON.stringify({
        href: 'https://zdn.vn/orig.jpg',
        thumb: 'https://zdn.vn/orig.jpg',
        params: '{"fileExt":"jpg"}',
        title: 'photo.jpg',
      }),
      contentType: 'image',
      msgId: 'zalo-img-1',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-img',
      threadType: 'user' as const,
      attachments: [],
    });

    expect(result).not.toBeNull();
    expect(mirrorAttachmentMock).toHaveBeenCalledOnce();
    expect(mirrorAttachmentMock.mock.calls[0][0]).toMatchObject({
      url: 'https://zdn.vn/orig.jpg',
    });

    const persisted = await prisma.message.findFirst({ where: { zaloMsgId: 'zalo-img-1' } });
    const envelope = JSON.parse(persisted!.content!);
    expect(envelope.href).toBe('http://minio.test/zalocrm-attachments/2026-05-21/abc.jpg');
    // Other envelope fields preserved.
    expect(envelope.params).toBe('{"fileExt":"jpg"}');
    expect(envelope.title).toBe('photo.jpg');

    // Returned message reflects the rewritten URL too — so the listener
    // emits the MinIO-URL row over Socket.IO.
    const returnedEnvelope = JSON.parse(result!.message.content!);
    expect(returnedEnvelope.href).toBe(
      'http://minio.test/zalocrm-attachments/2026-05-21/abc.jpg',
    );
  });

  it('AC-0008: mirror failure keeps the original Zalo URL (best-effort)', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    // Simulate download/upload failure.
    mirrorAttachmentMock.mockResolvedValueOnce(null);

    const original = JSON.stringify({
      href: 'https://zdn.vn/orig.jpg',
      thumb: 'https://zdn.vn/orig-thumb.jpg',
    });

    const result = await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-fail',
      senderName: 'Fail',
      content: original,
      contentType: 'image',
      msgId: 'zalo-img-fail',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-fail',
      threadType: 'user' as const,
      attachments: [],
    });

    expect(result).not.toBeNull();
    expect(mirrorAttachmentMock).toHaveBeenCalled();

    const persisted = await prisma.message.findFirst({ where: { zaloMsgId: 'zalo-img-fail' } });
    // Message persists; content unchanged.
    expect(persisted?.content).toBe(original);
  });

  it('text messages do not invoke the mirror at all', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-text',
      senderName: 'Text',
      content: 'just text',
      contentType: 'text',
      msgId: 'zalo-text',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-text',
      threadType: 'user' as const,
      attachments: [],
    });

    expect(mirrorAttachmentMock).not.toHaveBeenCalled();
  });

  it('video inbound — mirrors hdUrl and thumb separately, preserves params', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account } = await seedOrgAndAccount();

    // First call mirrors the video, second mirrors the thumbnail.
    mirrorAttachmentMock
      .mockResolvedValueOnce({
        key: 'k1',
        url: 'http://minio.test/v.mp4',
        size: 1,
        mimeType: 'video/mp4',
      })
      .mockResolvedValueOnce({
        key: 'k2',
        url: 'http://minio.test/poster.jpg',
        size: 1,
        mimeType: 'image/jpeg',
      });

    const result = await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-vid',
      senderName: 'Vid',
      content: JSON.stringify({
        hdUrl: 'https://zdn.vn/v.mp4',
        href: 'https://zdn.vn/v.mp4',
        thumb: 'https://zdn.vn/poster.jpg',
        params: { duration: 5 },
      }),
      contentType: 'video',
      msgId: 'zalo-vid',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-vid',
      threadType: 'user' as const,
      attachments: [],
    });

    expect(result).not.toBeNull();
    expect(mirrorAttachmentMock).toHaveBeenCalledTimes(2);

    const persisted = await prisma.message.findFirst({ where: { zaloMsgId: 'zalo-vid' } });
    const envelope = JSON.parse(persisted!.content!);
    expect(envelope.hdUrl).toBe('http://minio.test/v.mp4');
    expect(envelope.href).toBe('http://minio.test/v.mp4');
    expect(envelope.thumb).toBe('http://minio.test/poster.jpg');
    expect(envelope.params).toEqual({ duration: 5 });
  });
});
