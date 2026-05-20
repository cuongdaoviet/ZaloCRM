/**
 * Integration tests for Feature 0027 — MinIO/S3 attachment mirror.
 *
 * Focuses on the failure surface around the outbound flow:
 *   - storage_failed  → MinIO upload throws, no Zalo call, no Message row
 *   - zalo_send_failed → MinIO succeeds, Zalo throws, MinIO orphan
 *                        accepted, no Message row
 *   - happy-path orphan check (one MinIO upload per successful request)
 *
 * Inbound mirror happy/fail paths live in
 * `message-handler.integration.test.ts` since they hang off the existing
 * inbound message flow.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const sendMessageMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { sendMessage: sendMessageMock } })),
};
const uploadBufferMock = vi.fn();

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
  const org = await prisma.organization.create({ data: { name: 'Mirror Org' } });
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

describe('Outbound MinIO mirror — failure cases', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    sendMessageMock.mockResolvedValue({
      message: null,
      attachment: [{ msgId: 7 }],
    });
    zaloPoolMock.getInstance.mockReturnValue({ api: { sendMessage: sendMessageMock } });
    uploadBufferMock.mockResolvedValue({
      key: '2026-05-21/uuid.png',
      url: 'http://minio.test/zalocrm-attachments/2026-05-21/uuid.png',
      size: FAKE_PNG.length,
      mimeType: 'image/png',
    });
  });

  it('AC-0005: storage_failed when MinIO upload throws — no Zalo call, no Message row', async () => {
    const { org, user, conv } = await seed();
    uploadBufferMock.mockRejectedValueOnce(new Error('disk full'));

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(502);
    const errBody = JSON.parse(res.payload);
    expect(errBody.code).toBe('storage_failed');
    // BR-0005: Zalo MUST NOT be called when MinIO fails (avoid orphan-on-Zalo).
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(await prisma.message.count()).toBe(0);
    await app.close();
  });

  it('AC-0006: zalo_send_failed — MinIO succeeded but Zalo threw → orphan on MinIO, no Message row', async () => {
    const { org, user, conv } = await seed();
    sendMessageMock.mockRejectedValueOnce(new Error('zalo network'));

    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(502);
    const errBody = JSON.parse(res.payload);
    expect(errBody.code).toBe('zalo_send_failed');
    // EC-0006: MinIO upload happened (acceptable orphan), Zalo call attempted,
    // no Message row persisted.
    expect(uploadBufferMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(await prisma.message.count()).toBe(0);
    await app.close();
  });

  it('Happy path: exactly one MinIO upload per successful attachment send', async () => {
    const { org, user, conv } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(201);
    expect(uploadBufferMock).toHaveBeenCalledOnce();
    // Verify MinIO got the right inputs — buffer, MIME, filename — so the
    // bucket key uses the right extension (BR-0001 / BR-0003).
    const [buf, mime, name] = uploadBufferMock.mock.calls[0];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(FAKE_PNG.length);
    expect(mime).toBe('image/png');
    expect(name).toBe('photo.png');

    const persisted = await prisma.message.findFirst();
    expect(persisted?.content).toBe(
      'http://minio.test/zalocrm-attachments/2026-05-21/uuid.png',
    );
    await app.close();
  });
});
