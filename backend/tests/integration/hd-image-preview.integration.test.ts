/**
 * Integration tests for Feature 0032 — HD image preview
 * (uploadAttachment-first fallback when MinIO is disabled).
 *
 * Covers:
 *   - AC-0001: outbound image with `MINIO_ENABLED=false` persists Message
 *              with `content.hdUrl` non-empty (JSON envelope).
 *   - AC-0002: uploadAttachment returns empty hdUrl → 502 `upload_failed`,
 *              no Message row.
 *   - AC-0003: `attachments[0].thumb` populated when uploadAttachment
 *              response carries it.
 *   - AC-0004 regression: tests in `send-attachment` and `minio-mirror`
 *              cover the MinIO primary path — this file only exercises
 *              the fallback, so 0027 contracts remain untouched.
 *
 * The fallback path is selected via `config.minioEnabled = false`. We
 * flip the flag for this entire describe block (it's read once per route
 * invocation, so a single mutation around buildApp is enough).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const sendMessageMock = vi.fn();
const uploadAttachmentMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({
    api: { sendMessage: sendMessageMock, uploadAttachment: uploadAttachmentMock },
  })),
};
const uploadBufferMock = vi.fn();

// Feature 0032 — these tests exercise the fallback path, gated by
// `config.minioEnabled = false`. We mock the config module directly so
// the flag flip is robust to module caching (integration tests share a
// single fork; env-var mutation alone wouldn't reach already-loaded
// modules).
const configMock = {
  minioEnabled: false,
  s3Endpoint: 'http://minio.test:9000',
  s3PublicUrl: 'http://minio.test',
  s3Bucket: 'zalocrm-attachments',
  s3AccessKey: 'k',
  s3SecretKey: 's',
  s3Region: 'us-east-1',
  port: 3000,
  host: '0.0.0.0',
  nodeEnv: 'test',
  jwtSecret: 'x',
  encryptionKey: 'x',
  databaseUrl: '',
  uploadDir: '/tmp',
  appUrl: 'http://localhost:3000',
  isProduction: false,
  friendActiveWindowDays: 7,
};

vi.mock('../../src/config/index.js', () => ({
  config: configMock,
}));

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/shared/storage/minio-client.js', () => ({
  uploadBuffer: uploadBufferMock,
  ensureBucket: vi.fn().mockResolvedValue(undefined),
  minioClient: {},
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
    if (!req.user) req.user = { id: 'test-user', orgId: 'org-stub', role: 'admin' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seed() {
  const org = await prisma.organization.create({ data: { name: 'HD Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'A',
      role: 'admin',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: user.id, status: 'connected', zaloUid: 'self-uid' },
  });
  const contact = await prisma.contact.create({
    data: { orgId: org.id, zaloUid: 'remote-uid', fullName: 'K' },
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
  return { org, user, account, contact, conv };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  await app.register(fastifyMultipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

function multipartBody(
  fieldName: string,
  filename: string,
  contentType: string,
  buffer: Buffer,
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const payload = Buffer.concat([head, buffer, tail]);
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length),
    },
    payload,
  };
}

const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...Array(100).fill(0xff),
]);

describe('Feature 0032 — Zalo CDN fallback (minioEnabled=false)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    // Ensure each test starts with the fallback path selected.
    configMock.minioEnabled = false;
    sendMessageMock.mockResolvedValue({
      message: null,
      attachment: [{ msgId: 12345 }],
    });
    zaloPoolMock.getInstance.mockReturnValue({
      api: { sendMessage: sendMessageMock, uploadAttachment: uploadAttachmentMock },
    });
    uploadBufferMock.mockResolvedValue({
      key: '2026-05-21/uuid.png',
      url: 'http://minio.test/zalocrm-attachments/2026-05-21/uuid.png',
      size: FAKE_PNG.length,
      mimeType: 'image/png',
    });
  });

  it('AC-0001: persists Message with content.hdUrl non-empty when MinIO disabled', async () => {
    const { org, user, conv } = await seed();
    uploadAttachmentMock.mockResolvedValueOnce({
      hdUrl: 'https://zdn.vn/photo-hd.jpg',
      normalUrl: 'https://zdn.vn/photo.jpg',
      thumb: 'https://zdn.vn/photo-thumb.jpg',
      fileType: 'image',
    });

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(201);
    // MinIO must NOT have been called — env opted out.
    expect(uploadBufferMock).not.toHaveBeenCalled();
    // uploadAttachment is called FIRST, then sendMessage with the hdUrl.
    expect(uploadAttachmentMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const sendCallArgs = sendMessageMock.mock.calls[0];
    expect(sendCallArgs[0].attachments[0]).toBe('https://zdn.vn/photo-hd.jpg');

    const msg = JSON.parse(res.payload);
    expect(msg.contentType).toBe('image');
    // BR-0002: `content` is a JSON envelope {href, hdUrl, thumb}.
    const envelope = JSON.parse(msg.content);
    expect(envelope.hdUrl).toBe('https://zdn.vn/photo-hd.jpg');
    expect(envelope.href).toBe('https://zdn.vn/photo-hd.jpg');
    expect(envelope.thumb).toBe('https://zdn.vn/photo-thumb.jpg');

    // Verify persisted row matches.
    const persisted = await prisma.message.findFirst();
    expect(persisted?.contentType).toBe('image');
    const persistedEnvelope = JSON.parse(persisted!.content!);
    expect(persistedEnvelope.hdUrl).toBe('https://zdn.vn/photo-hd.jpg');
    expect(persistedEnvelope.hdUrl).not.toBe('');

    await app.close();
  });

  it('AC-0002: uploadAttachment returns empty hdUrl → 502 upload_failed, no Message', async () => {
    const { org, user, conv } = await seed();
    uploadAttachmentMock.mockResolvedValueOnce({
      hdUrl: '',
      normalUrl: '',
      thumb: '',
    });

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).code).toBe('upload_failed');
    // BR-0003: sendMessage MUST NOT be called when hdUrl is empty —
    // root cause of the v3.0 empty-preview bug.
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(await prisma.message.count()).toBe(0);

    await app.close();
  });

  it('AC-0003: attachments[0].thumb populated when uploadAttachment returns thumb', async () => {
    const { org, user, conv } = await seed();
    uploadAttachmentMock.mockResolvedValueOnce({
      hdUrl: 'https://zdn.vn/photo-hd.jpg',
      thumb: 'https://zdn.vn/photo-thumb.jpg',
    });

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(201);
    const msg = JSON.parse(res.payload);
    expect(msg.attachments[0].hdUrl).toBe('https://zdn.vn/photo-hd.jpg');
    expect(msg.attachments[0].thumb).toBe('https://zdn.vn/photo-thumb.jpg');

    await app.close();
  });

  it('EC-0002: uploadAttachment throws → 502 upload_failed, no sendMessage, no Message', async () => {
    const { org, user, conv } = await seed();
    uploadAttachmentMock.mockRejectedValueOnce(new Error('zalo network'));

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).code).toBe('upload_failed');
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(await prisma.message.count()).toBe(0);

    await app.close();
  });

  it('falls back to normalUrl when uploadAttachment returns no hdUrl but normalUrl present', async () => {
    const { org, user, conv } = await seed();
    uploadAttachmentMock.mockResolvedValueOnce({
      hdUrl: '',
      normalUrl: 'https://zdn.vn/photo-normal.jpg',
    });

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(201);
    const msg = JSON.parse(res.payload);
    const envelope = JSON.parse(msg.content);
    expect(envelope.hdUrl).toBe('https://zdn.vn/photo-normal.jpg');

    await app.close();
  });

  it('zca-js sendMessage fails after uploadAttachment → 502 zalo_send_failed', async () => {
    const { org, user, conv } = await seed();
    uploadAttachmentMock.mockResolvedValueOnce({
      hdUrl: 'https://zdn.vn/photo-hd.jpg',
    });
    sendMessageMock.mockRejectedValueOnce(new Error('zalo send timeout'));

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).code).toBe('zalo_send_failed');
    expect(await prisma.message.count()).toBe(0);

    await app.close();
  });
});
