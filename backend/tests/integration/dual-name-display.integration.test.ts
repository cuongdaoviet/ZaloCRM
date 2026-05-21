/**
 * Integration tests for Feature 0024 — Dual name display
 * (CRM Name + Zalo Name).
 *
 * Covers:
 *  - BR-0001 / BR-0002: inbound message handler split of `fullName`
 *                       (rep-owned, never overwritten) and
 *                       `zaloDisplayName` (auto-synced from senderName /
 *                       groupName). User + group paths.
 *  - BR-0007:           PUT /api/v1/contacts/:id silently strips
 *                       `zaloDisplayName` from the request body.
 *  - EC-0001:           empty/null senderName must NOT overwrite an
 *                       existing zaloDisplayName.
 *  - AC-0005:           GET /api/v1/contacts/:id and list endpoints
 *                       return `zaloDisplayName`.
 *
 * AC mapping inside this file:
 *  AC-0002 (new contact create) / AC-0003 (existing contact update) /
 *  AC-0004 (PUT strip + rep edit preserves Zalo) / AC-0005 (read-back) /
 *  AC-0008 (group path).
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
vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 'test-user', orgId: 'org-stub', role: 'admin' };
  },
}));

// Feature 0027 — the inbound attachment mirror is mocked to a no-op so the
// dual-name tests below don't accidentally trip the image/video branch.
vi.mock('../../src/shared/storage/download-mirror.js', () => ({
  mirrorAttachment: vi.fn().mockResolvedValue(null),
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seedOrgAndAccount() {
  const org = await prisma.organization.create({ data: { name: 'Test Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `owner-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: user.id, status: 'connected' },
  });
  return { org, user, account };
}

async function buildContactApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { contactRoutes } = await import('../../src/modules/contacts/contact-routes.js');
  await app.register(contactRoutes);
  return app;
}

describe('Feature 0024 — dual name display', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  // ── BR-0001 (user thread) ─────────────────────────────────────────────
  it('AC-0002: NEW inbound contact — fullName and zaloDisplayName both set to senderName', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account, org } = await seedOrgAndAccount();

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-new-1',
      senderName: 'Nguyễn Văn T.',
      content: 'hi',
      contentType: 'text',
      msgId: 'm-new-1',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-new-1',
      threadType: 'user' as const,
      attachments: [],
    });

    const c = await prisma.contact.findFirst({
      where: { orgId: org.id, zaloUid: 'uid-new-1' },
    });
    expect(c).not.toBeNull();
    expect(c!.fullName).toBe('Nguyễn Văn T.');
    expect(c!.zaloDisplayName).toBe('Nguyễn Văn T.');
  });

  // ── BR-0001 (user thread, existing contact) ───────────────────────────
  it('AC-0003: existing contact — only zaloDisplayName updates, fullName preserved', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account, org } = await seedOrgAndAccount();

    // Pre-seed a contact the rep has already renamed.
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-existing',
        fullName: 'Anh Tuấn CFO XYZ',
        zaloDisplayName: 'Nguyễn Văn T.',
      },
    });

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-existing',
      senderName: 'Nguyễn Văn Tèo',
      content: 'hi',
      contentType: 'text',
      msgId: 'm-existing',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-existing',
      threadType: 'user' as const,
      attachments: [],
    });

    const c = await prisma.contact.findFirst({
      where: { orgId: org.id, zaloUid: 'uid-existing' },
    });
    expect(c!.fullName).toBe('Anh Tuấn CFO XYZ'); // rep-owned, untouched
    expect(c!.zaloDisplayName).toBe('Nguyễn Văn Tèo'); // refreshed
  });

  it('existing contact, same senderName as zaloDisplayName → no write', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account, org } = await seedOrgAndAccount();
    const seeded = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-noop',
        fullName: 'CRM Name',
        zaloDisplayName: 'Same Zalo',
      },
    });
    const before = seeded.updatedAt;

    // Force a measurable gap so updatedAt would change if an update did fire.
    await new Promise((r) => setTimeout(r, 10));

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-noop',
      senderName: 'Same Zalo', // identical → no update
      content: 'hi',
      contentType: 'text',
      msgId: 'm-noop',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-noop',
      threadType: 'user' as const,
      attachments: [],
    });

    const after = await prisma.contact.findUnique({ where: { id: seeded.id } });
    expect(after!.fullName).toBe('CRM Name');
    expect(after!.zaloDisplayName).toBe('Same Zalo');
    expect(after!.updatedAt.getTime()).toBe(before.getTime());
  });

  // ── EC-0001 — empty senderName must not overwrite ──────────────────────
  it('EC-0001: empty senderName does NOT overwrite existing zaloDisplayName', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account, org } = await seedOrgAndAccount();
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-empty',
        fullName: 'Rep Name',
        zaloDisplayName: 'Keep Me',
      },
    });

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-empty',
      senderName: '', // empty
      content: 'hi',
      contentType: 'text',
      msgId: 'm-empty',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'uid-empty',
      threadType: 'user' as const,
      attachments: [],
    });

    const c = await prisma.contact.findFirst({
      where: { orgId: org.id, zaloUid: 'uid-empty' },
    });
    expect(c!.fullName).toBe('Rep Name');
    expect(c!.zaloDisplayName).toBe('Keep Me');
  });

  // ── BR-0002 — group path ──────────────────────────────────────────────
  it('AC-0008 (create): group contact — both fullName and zaloDisplayName set to groupName', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account, org } = await seedOrgAndAccount();

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-member',
      senderName: 'Member',
      content: 'hi',
      contentType: 'text',
      msgId: 'g-create',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'group-1',
      threadType: 'group' as const,
      groupName: 'Team Cá Heo',
      attachments: [],
    });

    const c = await prisma.contact.findFirst({
      where: { orgId: org.id, zaloUid: 'group-1' },
    });
    expect(c).not.toBeNull();
    expect(c!.fullName).toBe('Team Cá Heo');
    expect(c!.zaloDisplayName).toBe('Team Cá Heo');
  });

  it('AC-0008 (update): existing group — only zaloDisplayName changes, fullName preserved', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account, org } = await seedOrgAndAccount();
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'group-2',
        fullName: 'Nhóm Sale Q4 (custom)',
        zaloDisplayName: 'Team Cá Heo',
        metadata: { isGroup: true },
      },
    });

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'uid-member',
      senderName: 'Member',
      content: 'hi',
      contentType: 'text',
      msgId: 'g-update',
      timestamp: Date.now(),
      isSelf: false,
      threadId: 'group-2',
      threadType: 'group' as const,
      groupName: 'Team Cá Voi', // group renamed
      attachments: [],
    });

    const c = await prisma.contact.findFirst({
      where: { orgId: org.id, zaloUid: 'group-2' },
    });
    expect(c!.fullName).toBe('Nhóm Sale Q4 (custom)'); // rep-owned name preserved
    expect(c!.zaloDisplayName).toBe('Team Cá Voi'); // refreshed
  });

  // ── BR-0007 — PUT strips zaloDisplayName ──────────────────────────────
  it('AC-0004: PUT /contacts/:id ignores zaloDisplayName in body (silent strip)', async () => {
    const { org, user } = await seedOrgAndAccount();
    const contact = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-put',
        fullName: 'Old CRM',
        zaloDisplayName: 'Original Zalo',
      },
    });

    const app = await buildContactApp({ id: user.id, orgId: org.id, role: 'admin' });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/contacts/${contact.id}`,
        payload: {
          fullName: 'Anh Tuấn CFO',
          zaloDisplayName: 'Hacker Attempt', // must be ignored
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const after = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(after!.fullName).toBe('Anh Tuấn CFO'); // rep edit applied
    expect(after!.zaloDisplayName).toBe('Original Zalo'); // untouched
  });

  // ── AC-0005 — read endpoints expose zaloDisplayName ───────────────────
  it('AC-0005: GET /contacts/:id returns zaloDisplayName', async () => {
    const { org, user } = await seedOrgAndAccount();
    const contact = await prisma.contact.create({
      data: {
        orgId: org.id,
        fullName: 'Anh Tuấn CFO',
        zaloDisplayName: 'Nguyễn Văn T.',
      },
    });

    const app = await buildContactApp({ id: user.id, orgId: org.id, role: 'admin' });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/contacts/${contact.id}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.fullName).toBe('Anh Tuấn CFO');
      expect(body.zaloDisplayName).toBe('Nguyễn Văn T.');
    } finally {
      await app.close();
    }
  });

  it('AC-0005: GET /contacts list includes zaloDisplayName on each row', async () => {
    const { org, user } = await seedOrgAndAccount();
    await prisma.contact.create({
      data: {
        orgId: org.id,
        fullName: 'Anh Tuấn',
        zaloDisplayName: 'Nguyễn T.',
      },
    });

    const app = await buildContactApp({ id: user.id, orgId: org.id, role: 'admin' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/contacts' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.contacts.length).toBeGreaterThan(0);
      expect(body.contacts[0].zaloDisplayName).toBe('Nguyễn T.');
    } finally {
      await app.close();
    }
  });

  // ── BR-0003 — self message does NOT trigger a contact upsert ─────────
  it('self messages do not create a contact row', async () => {
    const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');
    const { account, org } = await seedOrgAndAccount();

    await handleIncomingMessage({
      accountId: account.id,
      senderUid: 'self-uid',
      senderName: '',
      content: 'hi from me',
      contentType: 'text',
      msgId: 'self-1',
      timestamp: Date.now(),
      isSelf: true,
      threadId: 'uid-fresh',
      threadType: 'user' as const,
      attachments: [],
    });

    const count = await prisma.contact.count({ where: { orgId: org.id } });
    expect(count).toBe(0);
  });
});
