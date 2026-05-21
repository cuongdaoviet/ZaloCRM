/**
 * Integration tests for Feature 0034 — Contact merge by Zalo globalId.
 *
 * Covers acceptance criteria from docs/features/0034-contact-merge-globalid/SPEC.md:
 *   AC-0002 / AC-0003 / AC-0004 — inbound globalId propagation policy (BR-0002).
 *   AC-0005 / AC-0006        — globalId_exact detection + cluster shape.
 *   AC-0007                  — merge carries globalId per BR-0005.
 *
 * AC-0001 (schema migration) and AC-0008 (build pass) are verified by the
 * separate `pnpm prisma db push` + `tsc --noEmit` steps in CI.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;
const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: loggerMock,
}));
vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));
// Feature 0027 — neutralise the mirror so the dedupe / content tests below
// keep their original Zalo URLs untouched.
vi.mock('../../src/shared/storage/download-mirror.js', () => ({
  mirrorAttachment: vi.fn().mockResolvedValue(null),
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

beforeEach(async () => {
  await resetDb(prisma);
  loggerMock.warn.mockClear();
});

async function seedOrgAndAccount() {
  const org = await prisma.organization.create({ data: { name: 'Org-0034' } });
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
    data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
  });
  return { org, owner, account };
}

function makeInboundMsg(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'unset',
    senderUid: 'uid-A',
    senderName: 'Alice',
    content: 'hello',
    contentType: 'text',
    msgId: `mid-${Date.now()}-${Math.random()}`,
    timestamp: Date.now(),
    isSelf: false,
    threadId: 'uid-A',
    threadType: 'user' as const,
    attachments: [],
    ...overrides,
  };
}

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { duplicateRoutes } = await import(
    '../../src/modules/contacts/duplicate-routes.js'
  );
  await app.register(duplicateRoutes);
  return app;
}

describe('Feature 0034 — inbound globalId propagation (BR-0002)', () => {
  it('AC-0002: new contact gets zaloGlobalId set on create', async () => {
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const { account, org } = await seedOrgAndAccount();

    const result = await handleIncomingMessage(
      makeInboundMsg({
        accountId: account.id,
        senderUid: 'uid-fresh',
        threadId: 'uid-fresh',
        senderGlobalId: 'gid-1',
      }),
    );
    expect(result).not.toBeNull();
    const contact = await prisma.contact.findFirstOrThrow({
      where: { orgId: org.id, zaloUid: 'uid-fresh' },
    });
    expect(contact.zaloGlobalId).toBe('gid-1');
  });

  it('AC-0003: existing contact with NULL globalId gets backfilled', async () => {
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const { account, org } = await seedOrgAndAccount();

    // Pre-existing contact (e.g. created by an earlier inbound that did not
    // carry a globalId — older zca-js payload, EC-0001).
    const seeded = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-existing',
        fullName: 'Existing',
      },
    });
    expect(seeded.zaloGlobalId).toBeNull();

    const result = await handleIncomingMessage(
      makeInboundMsg({
        accountId: account.id,
        senderUid: 'uid-existing',
        threadId: 'uid-existing',
        senderGlobalId: 'gid-backfill',
      }),
    );
    expect(result).not.toBeNull();
    const after = await prisma.contact.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(after.zaloGlobalId).toBe('gid-backfill');
  });

  it('AC-0004: incoming globalId different from existing → no overwrite + warning log', async () => {
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const { account, org } = await seedOrgAndAccount();

    const seeded = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-stable',
        fullName: 'Stable',
        zaloGlobalId: 'gid-original',
      },
    });

    await handleIncomingMessage(
      makeInboundMsg({
        accountId: account.id,
        senderUid: 'uid-stable',
        threadId: 'uid-stable',
        senderGlobalId: 'gid-IMPOSTER',
      }),
    );
    const after = await prisma.contact.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(after.zaloGlobalId).toBe('gid-original');
    // Defensive warning so ops can inspect.
    const warned = loggerMock.warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('globalId conflict'),
    );
    expect(warned).toBe(true);
  });

  it('EC-0001: incoming message without globalId → existing globalId untouched', async () => {
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const { account, org } = await seedOrgAndAccount();
    const seeded = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-noglobalid',
        fullName: 'NoGid',
        zaloGlobalId: 'gid-keep',
      },
    });

    await handleIncomingMessage(
      makeInboundMsg({
        accountId: account.id,
        senderUid: 'uid-noglobalid',
        threadId: 'uid-noglobalid',
        // senderGlobalId intentionally omitted (older payload shape).
      }),
    );
    const after = await prisma.contact.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(after.zaloGlobalId).toBe('gid-keep');
  });

  it('same globalId on existing contact → no-op (no warning, no UPDATE)', async () => {
    const { handleIncomingMessage } = await import(
      '../../src/modules/chat/message-handler.js'
    );
    const { account, org } = await seedOrgAndAccount();
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-same',
        fullName: 'Same',
        zaloGlobalId: 'gid-same',
      },
    });

    await handleIncomingMessage(
      makeInboundMsg({
        accountId: account.id,
        senderUid: 'uid-same',
        threadId: 'uid-same',
        senderGlobalId: 'gid-same',
      }),
    );

    const warned = loggerMock.warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('globalId conflict'),
    );
    expect(warned).toBe(false);
  });
});

describe('Feature 0034 — detection + cluster (AC-0005 / AC-0006)', () => {
  it('AC-0005: 2 contacts same globalId, different zaloUid → globalId_exact group', async () => {
    const { org } = await seedOrgAndAccount();
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-old',
        fullName: 'Old nick',
        zaloGlobalId: 'gid-canonical',
      },
    });
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-new',
        fullName: 'New nick',
        zaloGlobalId: 'gid-canonical',
      },
    });

    const { scanDuplicates } = await import(
      '../../src/modules/contacts/duplicate-service.js'
    );
    await scanDuplicates(org.id);

    const groups = await prisma.duplicateGroup.findMany({
      where: { orgId: org.id, level: 'globalId_exact' },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe(1.0);
    expect((groups[0].contactIds as string[]).length).toBe(2);
  });

  it('AC-0006: GET /duplicate-groups returns the globalId_exact cluster', async () => {
    const { org, owner } = await seedOrgAndAccount();
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-a',
        fullName: 'A',
        zaloGlobalId: 'gid-shared',
      },
    });
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-b',
        fullName: 'B',
        zaloGlobalId: 'gid-shared',
      },
    });
    const { scanDuplicates } = await import(
      '../../src/modules/contacts/duplicate-service.js'
    );
    await scanDuplicates(org.id);

    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/duplicate-groups?level=globalId_exact',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].level).toBe('globalId_exact');
    expect(body.groups[0].confidence).toBe(1.0);
    await app.close();
  });

  it('EC-0002: 3 contacts share globalId → single cluster of 3', async () => {
    const { org } = await seedOrgAndAccount();
    const created = await Promise.all(
      ['uid-1', 'uid-2', 'uid-3'].map((u) =>
        prisma.contact.create({
          data: {
            orgId: org.id,
            zaloUid: u,
            fullName: u,
            zaloGlobalId: 'gid-trio',
          },
        }),
      ),
    );
    const { scanDuplicates } = await import(
      '../../src/modules/contacts/duplicate-service.js'
    );
    await scanDuplicates(org.id);
    const group = await prisma.duplicateGroup.findFirstOrThrow({
      where: { orgId: org.id, level: 'globalId_exact' },
    });
    expect((group.contactIds as string[]).sort()).toEqual(
      created.map((c) => c.id).sort(),
    );
  });

  it('EC-0003: contacts already merged (mergedIntoId set) are skipped', async () => {
    const { org } = await seedOrgAndAccount();
    const primary = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-keep',
        fullName: 'Keep',
        zaloGlobalId: 'gid-merged',
      },
    });
    // Already-merged tombstone — must NOT appear in any new cluster.
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-old',
        fullName: 'Old',
        zaloGlobalId: 'gid-merged',
        mergedIntoId: primary.id,
        mergedAt: new Date(),
        status: 'merged',
      },
    });
    const { scanDuplicates } = await import(
      '../../src/modules/contacts/duplicate-service.js'
    );
    const result = await scanDuplicates(org.id);
    expect(result.groupsCreated).toBe(0);
  });
});

describe('Feature 0034 — merge carries globalId (AC-0007 / BR-0005)', () => {
  it('AC-0007a: primary NULL + secondary has globalId → primary inherits', async () => {
    const { org, owner } = await seedOrgAndAccount();
    const primary = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-primary',
        fullName: 'Primary',
        phone: '0901234567',
      },
    });
    const secondary = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-secondary',
        fullName: 'Secondary',
        phone: '+84 901 234 567',
        zaloGlobalId: 'gid-carried',
      },
    });
    const { scanDuplicates, mergeContacts } = await import(
      '../../src/modules/contacts/duplicate-service.js'
    );
    await scanDuplicates(org.id);
    const group = await prisma.duplicateGroup.findFirstOrThrow({
      where: { orgId: org.id, status: 'pending' },
    });

    const result = await mergeContacts(
      org.id,
      group.id,
      primary.id,
      {},
      owner.id,
    );
    expect('status' in result && result.status === 'merged').toBe(true);

    const primaryAfter = await prisma.contact.findUniqueOrThrow({
      where: { id: primary.id },
    });
    expect(primaryAfter.zaloGlobalId).toBe('gid-carried');
    const secondaryAfter = await prisma.contact.findUniqueOrThrow({
      where: { id: secondary.id },
    });
    expect(secondaryAfter.mergedIntoId).toBe(primary.id);
  });

  it('AC-0007b: primary has globalId → it is kept (not overwritten by secondary)', async () => {
    const { org, owner } = await seedOrgAndAccount();
    const primary = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-primary',
        fullName: 'Primary',
        phone: '0901234567',
        zaloGlobalId: 'gid-PRIMARY',
      },
    });
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-secondary',
        fullName: 'Secondary',
        phone: '+84 901 234 567',
        zaloGlobalId: 'gid-SECONDARY',
      },
    });
    const { scanDuplicates, mergeContacts } = await import(
      '../../src/modules/contacts/duplicate-service.js'
    );
    await scanDuplicates(org.id);
    const group = await prisma.duplicateGroup.findFirstOrThrow({
      where: { orgId: org.id, status: 'pending' },
    });

    await mergeContacts(org.id, group.id, primary.id, {}, owner.id);

    const primaryAfter = await prisma.contact.findUniqueOrThrow({
      where: { id: primary.id },
    });
    expect(primaryAfter.zaloGlobalId).toBe('gid-PRIMARY');
    // Warning log emitted so ops can inspect the discarded secondary identity.
    const warned = loggerMock.warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('globalId conflict on merge'),
    );
    expect(warned).toBe(true);
  });

  it('AC-0007c: both NULL → primary stays NULL after merge', async () => {
    const { org, owner } = await seedOrgAndAccount();
    const primary = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-primary',
        fullName: 'Primary',
        phone: '0901234567',
      },
    });
    await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-secondary',
        fullName: 'Secondary',
        phone: '+84 901 234 567',
      },
    });
    const { scanDuplicates, mergeContacts } = await import(
      '../../src/modules/contacts/duplicate-service.js'
    );
    await scanDuplicates(org.id);
    const group = await prisma.duplicateGroup.findFirstOrThrow({
      where: { orgId: org.id, status: 'pending' },
    });

    await mergeContacts(org.id, group.id, primary.id, {}, owner.id);

    const primaryAfter = await prisma.contact.findUniqueOrThrow({
      where: { id: primary.id },
    });
    expect(primaryAfter.zaloGlobalId).toBeNull();
  });
});
