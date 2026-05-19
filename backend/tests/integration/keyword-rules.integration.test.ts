/**
 * Integration tests for feature 0009 — keyword rule CRUD + service.
 * Real Postgres + Fastify inject.
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

async function seed() {
  const org = await prisma.organization.create({ data: { name: 'KW Org' } });
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `o-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Owner',
      role: 'owner',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
  });
  return { org, owner, member, account };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { keywordRuleRoutes } = await import(
    '../../src/modules/keyword-rules/keyword-rule-routes.js'
  );
  await app.register(keywordRuleRoutes);
  return app;
}

describe('Keyword rule CRUD routes', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('owner creates a rule', async () => {
    const { org, owner } = await seed();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keyword-rules',
      payload: {
        name: 'Hỏi giá',
        keywords: ['bảng giá', 'báo giá'],
        addTag: 'hỏi-giá',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).name).toBe('Hỏi giá');
    await app.close();
  });

  it('AC-0008: rule with no action → 400', async () => {
    const { org, owner } = await seed();
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keyword-rules',
      payload: { name: 'X', keywords: ['x'] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0010: member create/update/delete → 403', async () => {
    const { org, member } = await seed();
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keyword-rules',
      payload: { name: 'X', keywords: ['x'], addTag: 'y' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('member can list rules (read-only)', async () => {
    const { org, owner, member } = await seed();
    await prisma.keywordRule.create({
      data: { orgId: org.id, name: 'X', keywords: ['x'], addTag: 'y' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/keyword-rules' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).rules).toHaveLength(1);
    await app.close();
  });

  it('AC-0009: cross-org isolation', async () => {
    const { org: orgA, owner: ownerA } = await seed();
    const orgB = await prisma.organization.create({ data: { name: 'B' } });
    await prisma.keywordRule.create({
      data: { orgId: orgB.id, name: 'BRule', keywords: ['b'], addTag: 'b' },
    });
    const app = await buildApp({ id: ownerA.id, orgId: orgA.id, role: 'owner' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/keyword-rules' });
    expect(JSON.parse(res.payload).rules).toHaveLength(0);
    await app.close();
  });

  it('update rejects assignToUserId from another org', async () => {
    const { org, owner } = await seed();
    const orgB = await prisma.organization.create({ data: { name: 'B' } });
    const outsideUser = await prisma.user.create({
      data: { orgId: orgB.id, email: `x-${Date.now()}@x.local`, passwordHash: 'h', fullName: 'X', role: 'member' },
    });
    const app = await buildApp({ id: owner.id, orgId: org.id, role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keyword-rules',
      payload: {
        name: 'X', keywords: ['x'],
        assignToUserId: outsideUser.id,
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('processInboundForKeywordRules service', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  // `opts.addTag === null` explicitly means "no tag action" — use 'addTag' in opts to detect intent
  async function seedWithRule(opts: {
    enabled?: boolean;
    addTag?: string | null;
    setStatus?: string | null;
    assignToUserId?: string | null;
    contactStatus?: string;
    contactAssignedUserId?: string | null;
    contactTags?: string[];
  } = {}) {
    const { org, owner, account } = await seed();
    const contact = await prisma.contact.create({
      data: {
        orgId: org.id,
        zaloUid: 'uid-1',
        fullName: 'Khách A',
        status: opts.contactStatus ?? 'new',
        assignedUserId: opts.contactAssignedUserId ?? null,
        tags: opts.contactTags ?? [],
      },
    });
    const conv = await prisma.conversation.create({
      data: {
        orgId: org.id,
        zaloAccountId: account.id,
        contactId: contact.id,
        threadType: 'user',
        externalThreadId: 'uid-1',
      },
    });
    const rule = await prisma.keywordRule.create({
      data: {
        orgId: org.id,
        name: 'TestRule',
        enabled: opts.enabled !== false,
        keywords: ['bảng giá'],
        addTag: 'addTag' in opts ? opts.addTag : 'hỏi-giá',
        setStatus: opts.setStatus ?? null,
        assignToUserId: opts.assignToUserId ?? null,
      },
    });
    return { org, owner, contact, conv, rule };
  }

  it('AC-0001: addTag is applied when keyword matches', async () => {
    const { org, contact, conv } = await seedWithRule({ addTag: 'hỏi-giá' });
    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    await processInboundForKeywordRules({
      orgId: org.id,
      conversationId: conv.id,
      contactId: contact.id,
      threadType: 'user',
      isSelf: false,
      content: 'Cho em xin bảng giá ạ',
    });
    const after = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(after?.tags).toEqual(['hỏi-giá']);
  });

  it('AC-0002: setStatus upgrades pipeline', async () => {
    const { org, contact, conv } = await seedWithRule({
      addTag: null, setStatus: 'interested', contactStatus: 'new',
    });
    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    await processInboundForKeywordRules({
      orgId: org.id,
      conversationId: conv.id,
      contactId: contact.id,
      threadType: 'user',
      isSelf: false,
      content: 'Cho em xin bảng giá',
    });
    const after = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(after?.status).toBe('interested');
  });

  it('AC-0007: setStatus does NOT downgrade (converted → interested ignored)', async () => {
    const { org, contact, conv } = await seedWithRule({
      addTag: null, setStatus: 'interested', contactStatus: 'converted',
    });
    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    await processInboundForKeywordRules({
      orgId: org.id,
      conversationId: conv.id,
      contactId: contact.id,
      threadType: 'user',
      isSelf: false,
      content: 'bảng giá ạ',
    });
    const after = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(after?.status).toBe('converted'); // unchanged
  });

  it('AC-0003: second message in same conv → not fire again (dedup)', async () => {
    const { org, contact, conv, rule } = await seedWithRule({});
    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    const input = {
      orgId: org.id, conversationId: conv.id, contactId: contact.id,
      threadType: 'user' as const, isSelf: false,
      content: 'bảng giá xin',
    };
    await processInboundForKeywordRules(input);
    await processInboundForKeywordRules(input);
    const triggers = await prisma.keywordRuleTrigger.count({ where: { ruleId: rule.id } });
    expect(triggers).toBe(1);
  });

  it('AC-0004: self message → no fire', async () => {
    const { org, contact, conv, rule } = await seedWithRule({});
    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    await processInboundForKeywordRules({
      orgId: org.id, conversationId: conv.id, contactId: contact.id,
      threadType: 'user', isSelf: true,
      content: 'bảng giá test',
    });
    expect(await prisma.keywordRuleTrigger.count({ where: { ruleId: rule.id } })).toBe(0);
  });

  it('AC-0005: group thread → no fire', async () => {
    const { org, contact, conv, rule } = await seedWithRule({});
    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    await processInboundForKeywordRules({
      orgId: org.id, conversationId: conv.id, contactId: contact.id,
      threadType: 'group', isSelf: false,
      content: 'bảng giá',
    });
    expect(await prisma.keywordRuleTrigger.count({ where: { ruleId: rule.id } })).toBe(0);
  });

  it('AC-0006: disabled rule → no fire', async () => {
    const { org, contact, conv, rule } = await seedWithRule({ enabled: false });
    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    await processInboundForKeywordRules({
      orgId: org.id, conversationId: conv.id, contactId: contact.id,
      threadType: 'user', isSelf: false,
      content: 'bảng giá',
    });
    expect(await prisma.keywordRuleTrigger.count({ where: { ruleId: rule.id } })).toBe(0);
  });

  it('assignToUser only applies when contact unassigned', async () => {
    // Seed manually so we can keep all entities in the same org
    const org = await prisma.organization.create({ data: { name: 'O' } });
    const owner = await prisma.user.create({
      data: { orgId: org.id, email: `o-${Date.now()}@x.local`, passwordHash: 'h', fullName: 'Owner', role: 'owner' },
    });
    const otherUser = await prisma.user.create({
      data: { orgId: org.id, email: `u-${Date.now()}@x.local`, passwordHash: 'h', fullName: 'Other', role: 'member' },
    });
    const account = await prisma.zaloAccount.create({
      data: { orgId: org.id, ownerUserId: owner.id, status: 'connected' },
    });
    const contact = await prisma.contact.create({
      data: {
        orgId: org.id, zaloUid: 'uid-1', fullName: 'K',
        status: 'new', assignedUserId: owner.id, tags: [],
      },
    });
    const conv = await prisma.conversation.create({
      data: { orgId: org.id, zaloAccountId: account.id, contactId: contact.id, threadType: 'user', externalThreadId: 'uid-1' },
    });
    const rule = await prisma.keywordRule.create({
      data: {
        orgId: org.id, name: 'AssignRule',
        keywords: ['bảng giá'],
        addTag: null, setStatus: null,
        assignToUserId: otherUser.id,
      },
    });

    const { processInboundForKeywordRules } = await import(
      '../../src/modules/keyword-rules/keyword-rule-service.js'
    );
    await processInboundForKeywordRules({
      orgId: org.id, conversationId: conv.id, contactId: contact.id,
      threadType: 'user', isSelf: false,
      content: 'bảng giá xin',
    });
    const after = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(after?.assignedUserId).toBe(owner.id); // unchanged
    // But trigger ledger is still written so the dedup still works
    expect(await prisma.keywordRuleTrigger.count({ where: { ruleId: rule.id } })).toBe(1);
  });
});
