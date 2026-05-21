/**
 * Integration tests for Feature 0036 — AI reply suggestions (BYOK).
 *
 * Coverage of ACs:
 *   AC-0001 schema     — implicitly via every query below
 *   AC-0002 PUT valid  — config persists with encrypted cipher; GET excludes apiKey
 *   AC-0003 PUT invalid → 400
 *   AC-0004 member PUT → 403
 *   AC-0005 POST → 3 suggestions when last inbound within 24h
 *   AC-0006 cache hit on second call within 5min
 *   AC-0007 enabled=false → 412 ai_disabled
 *   AC-0008 org daily cap exceeded → 429 + Retry-After
 *   AC-0009 user hourly cap exceeded → 429
 *   AC-0010 AiSuggestionLog row written without content
 *   AC-0011 provider switching works
 *   AC-0012 logger never sees plaintext apiKey
 *
 * Mocking strategy: we replace global.fetch so no real provider call is made.
 * The provider registry imports the adapters which use fetch internally — we
 * just script the response we want for each test.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const loggerSink: string[] = [];

// Capture EVERY log line so AC-0012 can grep them for raw key fragments.
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => loggerSink.push('[INFO] ' + args.map(stringify).join(' ')),
    warn: (...args: unknown[]) => loggerSink.push('[WARN] ' + args.map(stringify).join(' ')),
    error: (...args: unknown[]) => loggerSink.push('[ERROR] ' + args.map(stringify).join(' ')),
    debug: (...args: unknown[]) => loggerSink.push('[DEBUG] ' + args.map(stringify).join(' ')),
  },
}));

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  get prisma() {
    return prisma;
  },
}));

// We let the auth middleware pass through using a request decorator each test.
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async () => {},
}));

// Zalo access middleware — short-circuit when role is admin/owner; otherwise
// fall back to a DB lookup which our test seeds.
vi.mock('../../src/modules/zalo/zalo-access-middleware.js', async () => {
  return {
    requireZaloAccess: () => async (req: any, reply: any) => {
      const user = req.user;
      if (!user) return reply.status(401).send({ error: 'no user' });
      if (['owner', 'admin'].includes(user.role)) return;
      const params = req.params as Record<string, string>;
      const conv = await prisma.conversation.findFirst({
        where: { id: params.id, orgId: user.orgId },
        select: { zaloAccountId: true },
      });
      if (!conv) return reply.status(404).send({ error: 'nf' });
      const access = await prisma.zaloAccountAccess.findFirst({
        where: { zaloAccountId: conv.zaloAccountId, userId: user.id },
      });
      if (!access) return reply.status(403).send({ error: 'no access' });
    },
  };
});

beforeAll(async () => {
  prisma = await setupDb();
  // Make sure encrypt-config uses a stable test master key. We assign onto
  // the config object after import to avoid module-init ordering quirks.
  const { config } = await import('../../src/config/index.js');
  (config as { aiConfigMasterKey: string }).aiConfigMasterKey = 'ab'.repeat(32);
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seedOrg() {
  const org = await prisma.organization.create({ data: { name: 'AI Org' } });
  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `a-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Admin',
      role: 'admin',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `m-${Date.now()}-${Math.random()}@t.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: admin.id,
      status: 'connected',
      zaloUid: 'self-uid',
    },
  });
  await prisma.zaloAccountAccess.create({
    data: {
      zaloAccountId: account.id,
      userId: member.id,
      permission: 'chat',
    },
  });
  const contact = await prisma.contact.create({
    data: { orgId: org.id, zaloUid: 'c-1', fullName: 'KH A', status: 'new' },
  });
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contact.id,
      externalThreadId: `t-${Date.now()}-${Math.random()}`,
      threadType: 'user',
      unreadCount: 0,
    },
  });
  const inbound = await prisma.message.create({
    data: {
      conversationId: conv.id,
      senderType: 'contact',
      senderName: 'KH A',
      content: 'Cho em hỏi giá nha',
      sentAt: new Date(),
    },
  });
  return { org, admin, member, account, contact, conv, inbound };
}

async function buildConfigApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    (req as any).user = user;
  });
  const { aiConfigRoutes } = await import('../../src/modules/ai/ai-config-routes.js');
  await app.register(aiConfigRoutes);
  return app;
}

async function buildSuggestApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    (req as any).user = user;
  });
  const { aiSuggestionRoutes } = await import('../../src/modules/ai/ai-suggestion-routes.js');
  await app.register(aiSuggestionRoutes);
  return app;
}

async function buildUsageApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    (req as any).user = user;
  });
  const { aiUsageRoutes } = await import('../../src/modules/ai/ai-usage-routes.js');
  await app.register(aiUsageRoutes);
  return app;
}

function mockAnthropic(ok = true, body?: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    json: async () =>
      body ??
      (ok
        ? {
            content: [{ type: 'text', text: '["Gợi ý 1", "Gợi ý 2", "Gợi ý 3"]' }],
            usage: { input_tokens: 50, output_tokens: 20 },
          }
        : { error: { message: 'unauthorized' } }),
    text: async () =>
      JSON.stringify(
        body ??
          (ok
            ? {
                content: [{ type: 'text', text: '["Gợi ý 1", "Gợi ý 2", "Gợi ý 3"]' }],
                usage: { input_tokens: 50, output_tokens: 20 },
              }
            : 'unauthorized'),
      ),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
  return fetchMock;
}

async function persistConfig(orgId: string, opts: Partial<{
  provider: string;
  enabled: boolean;
  maxSuggestionsPerDay: number;
  model: string;
  apiKey: string;
}> = {}) {
  const { encryptForOrg } = await import('../../src/shared/crypto/encrypt-config.js');
  const key = opts.apiKey ?? 'sk-ant-test-key-9999';
  const blob = encryptForOrg(orgId, key);
  return prisma.aiConfig.upsert({
    where: { orgId },
    create: {
      orgId,
      provider: opts.provider ?? 'anthropic',
      apiKeyCipher: blob.cipher,
      apiKeyIv: blob.iv,
      apiKeyTag: blob.tag,
      model: opts.model ?? 'claude-haiku-4-5',
      systemPrompt: null,
      enabled: opts.enabled ?? true,
      maxSuggestionsPerDay: opts.maxSuggestionsPerDay ?? 1000,
    },
    update: {
      provider: opts.provider ?? 'anthropic',
      apiKeyCipher: blob.cipher,
      apiKeyIv: blob.iv,
      apiKeyTag: blob.tag,
      model: opts.model ?? 'claude-haiku-4-5',
      enabled: opts.enabled ?? true,
      maxSuggestionsPerDay: opts.maxSuggestionsPerDay ?? 1000,
    },
  });
}

beforeEach(async () => {
  await resetDb(prisma);
  loggerSink.length = 0;
  vi.clearAllMocks();
  // Reset the in-memory suggestion cache between tests.
  const { clearSuggestionCache } = await import(
    '../../src/modules/ai/ai-suggestion-service.js'
  );
  clearSuggestionCache();
});

describe('AI config CRUD', () => {
  it('AC-0002: PUT with valid key → 200, cipher stored, GET hides apiKey', async () => {
    const { org, admin } = await seedOrg();
    mockAnthropic(true); // for the test-connection call
    const app = await buildConfigApp({ id: admin.id, orgId: org.id, role: 'admin' });

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai-config',
      payload: {
        provider: 'anthropic',
        apiKey: 'sk-ant-real-key-XXXX',
        model: 'claude-haiku-4-5',
        enabled: true,
      },
    });
    expect(putRes.statusCode).toBe(200);
    const body = JSON.parse(putRes.payload);
    expect(body.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-ant-real-key-XXXX');

    const row = await prisma.aiConfig.findUnique({ where: { orgId: org.id } });
    expect(row?.apiKeyCipher).toBeTruthy();
    expect(row?.apiKeyCipher).not.toContain('sk-ant-real');

    const getRes = await app.inject({ method: 'GET', url: '/api/v1/settings/ai-config' });
    expect(getRes.statusCode).toBe(200);
    const got = JSON.parse(getRes.payload);
    expect(got.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(got)).not.toContain('sk-ant-real-key-XXXX');
    await app.close();
  });

  it('AC-0003: PUT with invalid key → 400 with provider error', async () => {
    const { org, admin } = await seedOrg();
    mockAnthropic(false);
    const app = await buildConfigApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai-config',
      payload: {
        provider: 'anthropic',
        apiKey: 'sk-ant-bad',
        model: 'claude-haiku-4-5',
        enabled: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/test failed/);
    await app.close();
  });

  it('AC-0004: member PUT → 403', async () => {
    const { org, member } = await seedOrg();
    const app = await buildConfigApp({ id: member.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai-config',
      payload: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('DELETE clears the cipher + disables', async () => {
    const { org, admin } = await seedOrg();
    await persistConfig(org.id);
    const app = await buildConfigApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/settings/ai-config' });
    expect(res.statusCode).toBe(204);
    const row = await prisma.aiConfig.findUnique({ where: { orgId: org.id } });
    expect(row?.enabled).toBe(false);
    expect(row?.apiKeyCipher).toBe('');
    await app.close();
  });

  it('AC-0011: provider switching works (anthropic → openai)', async () => {
    const { org, admin } = await seedOrg();
    // First PUT anthropic with test mock OK
    mockAnthropic(true);
    const app = await buildConfigApp({ id: admin.id, orgId: org.id, role: 'admin' });
    let res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai-config',
      payload: {
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-haiku-4-5',
        enabled: true,
      },
    });
    expect(res.statusCode).toBe(200);
    let row = await prisma.aiConfig.findUnique({ where: { orgId: org.id } });
    expect(row?.provider).toBe('anthropic');

    // Now switch to openai. Re-mock fetch to OpenAI response shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () => 'ok',
    });
    res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/ai-config',
      payload: {
        provider: 'openai',
        apiKey: 'sk-proj-test',
        model: 'gpt-4o-mini',
        enabled: true,
      },
    });
    expect(res.statusCode).toBe(200);
    row = await prisma.aiConfig.findUnique({ where: { orgId: org.id } });
    expect(row?.provider).toBe('openai');
    expect(row?.model).toBe('gpt-4o-mini');
    await app.close();
  });
});

describe('AI suggestion endpoint', () => {
  it('AC-0005 + AC-0010 + AC-0012: POST returns 3 suggestions, logs row sans content', async () => {
    const { org, admin, conv } = await seedOrg();
    await persistConfig(org.id);

    const fetchMock = mockAnthropic(true);
    const app = await buildSuggestApp({ id: admin.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.suggestions).toHaveLength(3);
    expect(body.fromCache).toBe(false);
    expect(body.provider).toBe('anthropic');

    // AC-0010 — log row written, content NOT stored
    const logs = await prisma.aiSuggestionLog.findMany({ where: { orgId: org.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].errorCode).toBeNull();
    expect(logs[0].tokensIn).toBeGreaterThan(0);
    // Schema has no content column — verify via field shape.
    expect((logs[0] as Record<string, unknown>).content).toBeUndefined();
    expect((logs[0] as Record<string, unknown>).suggestion).toBeUndefined();

    // AC-0012 — logger sink does not contain the raw key
    expect(loggerSink.join('\n')).not.toContain('sk-ant-test-key-9999');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('AC-0006: second call within 5 minutes hits cache (no provider call)', async () => {
    const { org, admin, conv } = await seedOrg();
    await persistConfig(org.id);
    const fetchMock = mockAnthropic(true);
    const app = await buildSuggestApp({ id: admin.id, orgId: org.id, role: 'admin' });

    const r1 = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.payload).fromCache).toBe(false);

    const r2 = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(r2.statusCode).toBe(200);
    const body = JSON.parse(r2.payload);
    expect(body.fromCache).toBe(true);
    expect(body.suggestions).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not called twice
    await app.close();
  });

  it('AC-0007: enabled=false → 412 ai_disabled', async () => {
    const { org, admin, conv } = await seedOrg();
    await persistConfig(org.id, { enabled: false });
    mockAnthropic(true);
    const app = await buildSuggestApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.payload).error).toBe('ai_disabled');
    await app.close();
  });

  it('AC-0008: org daily cap exceeded → 429 with Retry-After', async () => {
    const { org, admin, conv } = await seedOrg();
    await persistConfig(org.id, { maxSuggestionsPerDay: 2 });
    // Pre-fill the log so we're already over the cap.
    for (let i = 0; i < 2; i++) {
      await prisma.aiSuggestionLog.create({
        data: {
          orgId: org.id,
          userId: admin.id,
          conversationId: conv.id,
          triggerMsgId: 'trig',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          tokensIn: 1,
          tokensOut: 1,
          costEstimate: 0,
          latencyMs: 0,
        },
      });
    }
    mockAnthropic(true);
    const app = await buildSuggestApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.payload).error).toBe('rate_limit_org');
    expect(res.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('AC-0009: per-user hourly cap exceeded → 429', async () => {
    const { org, admin, conv } = await seedOrg();
    await persistConfig(org.id, { maxSuggestionsPerDay: 100_000 });
    // Use a relatively high cap so we don't hammer the DB. The service uses
    // PER_USER_HOURLY_CAP=100 — write 100 rows for the same user.
    const rows = Array.from({ length: 100 }, () => ({
      orgId: org.id,
      userId: admin.id,
      conversationId: conv.id,
      triggerMsgId: 'trig',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokensIn: 0,
      tokensOut: 0,
      costEstimate: 0,
      latencyMs: 0,
    }));
    await prisma.aiSuggestionLog.createMany({ data: rows });
    mockAnthropic(true);
    const app = await buildSuggestApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.payload).error).toBe('rate_limit_user');
    await app.close();
  });

  it('EC-0003: provider 401 → 502 + AiConfig auto-disabled', async () => {
    const { org, admin, conv } = await seedOrg();
    await persistConfig(org.id);
    mockAnthropic(false);
    const app = await buildSuggestApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.payload).error).toBe('provider_401');
    const row = await prisma.aiConfig.findUnique({ where: { orgId: org.id } });
    expect(row?.enabled).toBe(false);
    await app.close();
  });

  it('rejects when last message is older than 24h', async () => {
    const { org, admin, conv, inbound } = await seedOrg();
    await persistConfig(org.id);
    // Push the message into the past.
    await prisma.message.update({
      where: { id: inbound.id },
      data: { sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    mockAnthropic(true);
    const app = await buildSuggestApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/ai-suggestions`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('no_inbound');
    await app.close();
  });
});

describe('AI usage aggregate', () => {
  it('returns totals + topUsers + byProvider', async () => {
    const { org, admin, conv } = await seedOrg();
    await prisma.aiSuggestionLog.createMany({
      data: [
        {
          orgId: org.id,
          userId: admin.id,
          conversationId: conv.id,
          triggerMsgId: 't',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          tokensIn: 100,
          tokensOut: 50,
          costEstimate: 0.001,
          latencyMs: 200,
        },
        {
          orgId: org.id,
          userId: admin.id,
          conversationId: conv.id,
          triggerMsgId: 't',
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          tokensIn: 80,
          tokensOut: 40,
          costEstimate: 0.0008,
          latencyMs: 180,
          errorCode: 'provider_5xx',
        },
      ],
    });
    const app = await buildUsageApp({ id: admin.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings/ai-usage' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.total).toBe(2);
    expect(body.totalTokensIn).toBe(180);
    expect(body.errorCount).toBe(1);
    expect(body.topUsers[0]).toEqual({ userId: admin.id, count: 2 });
    expect(body.byProvider[0]).toEqual({ provider: 'anthropic', count: 2 });
    await app.close();
  });
});
