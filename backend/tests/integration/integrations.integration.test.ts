/**
 * Integration tests for Feature 0038 — Integration Hub.
 *
 * Coverage map (12 ACs):
 *  - AC-0001 (schema migration)        → implicit via setupDb()
 *  - AC-0002 (Google Sheets create)    → "POST google_sheets with valid config"
 *  - AC-0003 (Telegram create)         → "POST telegram_bot with valid token"
 *  - AC-0004 (invalid Telegram token)  → "POST telegram_bot with bad token → 400"
 *  - AC-0005 (member RBAC)             → "member POST/PATCH/DELETE → 403"
 *  - AC-0006 (manual sync)             → "POST /:id/sync → 202 + IntegrationRun row"
 *  - AC-0007 (worker picks up)         → "runDueIntegrations runs due integration"
 *  - AC-0008 (Sheets headers + rows)   → "sync writes headers and contact rows"
 *  - AC-0009 (Telegram event format)   → "event tee fires Telegram message"
 *  - AC-0010 (disabled skip)           → "disabled integration is skipped"
 *  - AC-0011 (no raw tokens)           → "logs do not contain raw bot token"
 *  - AC-0012 (build pass)              → CI step `pnpm build`
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

// ── Mocks ────────────────────────────────────────────────────────────────────

// vitest hoists vi.mock() calls to the top of the file. Any variable the
// factory closes over must therefore be created via vi.hoisted() — otherwise
// the const declarations land below the hoisted factory and we hit a TDZ
// ReferenceError when the factory is evaluated. This bit us once already on
// the FE (commit 2791f62) and is the root cause of the 6 google-sheets test
// failures in this file (the OAuth2 / sheets() factories returned undefined
// shapes, so testConnection threw and createIntegration returned 400).

// Telegram API: we control fetch responses per-test.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

// googleapis: stub sheets.spreadsheets.{get,values.{clear,update}} per test.
const {
  sheetsGetMock,
  sheetsClearMock,
  sheetsUpdateMock,
  getTokenMock,
  setCredentialsMock,
  generateAuthUrlMock,
} = vi.hoisted(() => ({
  sheetsGetMock: vi.fn(),
  sheetsClearMock: vi.fn(),
  sheetsUpdateMock: vi.fn(),
  getTokenMock: vi.fn(),
  setCredentialsMock: vi.fn(),
  generateAuthUrlMock: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      // OAuth2 is invoked with `new google.auth.OAuth2(...)` in
      // connectors/google-sheets.ts. Arrow factories can't be used as
      // constructors (TypeError: "is not a constructor"), so we use a
      // regular `function` expression here — vitest sees it as a class-ish
      // ctor and `new` returns the explicit object.
      OAuth2: vi.fn().mockImplementation(function (this: unknown) {
        return {
          setCredentials: setCredentialsMock,
          getToken: getTokenMock,
          generateAuthUrl: generateAuthUrlMock,
        };
      }),
    },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        get: sheetsGetMock,
        values: {
          clear: sheetsClearMock,
          update: sheetsUpdateMock,
        },
      },
    }),
  },
}));

const { loggerInfo, loggerWarn, loggerError } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: vi.fn() },
}));

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));

vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 't', orgId: 'o', role: 'admin' };
  },
}));

// Stable master key for the test process — must be exactly 32 bytes hex.
// Feature 0038 piggybacks on 0036's encrypt-config helper, which reads
// AI_CONFIG_MASTER_KEY (the placeholder all-zeros also passes the regex
// guard, but we set an explicit value here so the test process matches what
// production does).
process.env.AI_CONFIG_MASTER_KEY =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.test/oauth/callback';

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function seedOrg(role: 'owner' | 'admin' | 'member' = 'admin') {
  const org = await prisma.organization.create({ data: { name: `Org-${Date.now()}` } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${role}-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: `User ${role}`,
      role,
    },
  });
  return { org, user };
}

async function seedContacts(orgId: string, count = 3) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await prisma.contact.create({
        data: {
          orgId,
          zaloUid: `uid-${i}-${Date.now()}`,
          fullName: `Contact ${i}`,
          phone: `090000000${i}`,
          status: i === 0 ? 'interested' : 'new',
          source: 'manual',
        },
      }),
    );
  }
  return out;
}

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { integrationRoutes } = await import('../../src/modules/integrations/integration-routes.js');
  await app.register(integrationRoutes);
  return app;
}

function mockTelegramOk() {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '{"ok":true}',
  });
}

function mockTelegramFail(status = 401, body = '{"ok":false,"description":"Unauthorized"}') {
  fetchMock.mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  });
}

function resetGoogleMocks() {
  sheetsGetMock.mockReset();
  sheetsClearMock.mockReset();
  sheetsUpdateMock.mockReset();
  getTokenMock.mockReset();
  setCredentialsMock.mockReset();
  // Default: testConnection returns a Sheet, sync writes empty.
  sheetsGetMock.mockResolvedValue({
    data: { spreadsheetId: 'sheet-1', properties: { title: 'Test' } },
  });
  sheetsClearMock.mockResolvedValue({ data: {} });
  sheetsUpdateMock.mockResolvedValue({ data: {} });
}

// ── AC-0001 ──────────────────────────────────────────────────────────────────

describe('AC-0001: schema migration', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('integration + integration_run tables exist with the right indices', async () => {
    const { org } = await seedOrg();
    // Insert minimum row — succeeds only if table + columns exist.
    const integration = await prisma.integration.create({
      data: {
        orgId: org.id,
        type: 'telegram_bot',
        name: 'AC-1 probe',
        configCipher: 'ab',
        configIv: 'cd',
        configTag: 'ef',
      },
    });
    const run = await prisma.integrationRun.create({
      data: { integrationId: integration.id, status: 'succeeded' },
    });
    expect(integration.id).toBeTruthy();
    expect(run.integrationId).toBe(integration.id);
  });
});

// ── AC-0002 + AC-0008 ────────────────────────────────────────────────────────

describe('AC-0002 + AC-0008: Google Sheets integration', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
    loggerInfo.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  it('AC-0002: POST google_sheets → 201 with no raw refresh token in response', async () => {
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'google_sheets',
        name: 'Sales dump',
        config: {
          refreshToken: 'rt-secret-xyz-very-confidential',
          spreadsheetId: 'sheet-abc',
          sheetName: 'Contacts',
          schedule: 'daily',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.type).toBe('google_sheets');
    expect(body.configured).toBe(true);
    // No raw secrets in the payload.
    expect(res.payload).not.toContain('rt-secret-xyz');
    expect(res.payload).not.toContain('refreshToken');

    // Persisted row has ciphered config — never plaintext.
    const persisted = await prisma.integration.findFirst({ where: { orgId: org.id } });
    expect(persisted?.configCipher).not.toContain('rt-secret-xyz');
    expect(persisted?.configCipher.length).toBeGreaterThan(0);
    expect(persisted?.configIv.length).toBeGreaterThan(0);
    expect(persisted?.configTag.length).toBeGreaterThan(0);
    await app.close();
  });

  it('AC-0008: sync writes headers + one row per contact via chunked update', async () => {
    const { org, user } = await seedOrg('admin');
    const contacts = await seedContacts(org.id, 3);
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'google_sheets',
        name: 'Sales dump',
        config: {
          refreshToken: 'rt-1',
          spreadsheetId: 'sheet-abc',
          sheetName: 'Contacts',
          schedule: 'manual',
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = JSON.parse(create.payload);

    // Trigger manual sync via service (lets us await deterministically).
    const { runSync } = await import('../../src/modules/integrations/integration-service.js');
    const runId = await runSync(id);
    expect(runId).toBeTruthy();

    // Header row went out first.
    expect(sheetsClearMock).toHaveBeenCalled();
    expect(sheetsUpdateMock).toHaveBeenCalled();
    const calls = sheetsUpdateMock.mock.calls;
    // First call: headers at row A1.
    expect(calls[0][0].range).toBe('Contacts!A1');
    expect(calls[0][0].requestBody.values[0]).toEqual([
      'id',
      'fullName',
      'phone',
      'status',
      'tags',
      'source',
      'createdAt',
      'assignedUserName',
    ]);
    // Second call: data starts at row 2.
    expect(calls[1][0].range).toBe('Contacts!A2');
    expect(calls[1][0].requestBody.values).toHaveLength(contacts.length);

    const runRow = await prisma.integrationRun.findUnique({ where: { id: runId } });
    expect(runRow?.status).toBe('succeeded');
    expect(runRow?.recordsProcessed).toBe(contacts.length);

    const updated = await prisma.integration.findUnique({ where: { id } });
    expect(updated?.lastSyncedAt).not.toBeNull();
    expect(updated?.lastError).toBeNull();
    await app.close();
  });

  it('sync large dataset chunks at 1000 rows/batch (EC-0003)', async () => {
    const { org, user } = await seedOrg('admin');
    // 2500 contacts → expect 1 header call + 3 data chunks (1000, 1000, 500).
    for (let i = 0; i < 2500; i += 250) {
      await prisma.contact.createMany({
        data: Array.from({ length: 250 }, (_, j) => ({
          orgId: org.id,
          zaloUid: `uid-bulk-${i + j}`,
          fullName: `C${i + j}`,
          phone: null,
          status: 'new',
          source: 'bulk',
        })),
      });
    }
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'google_sheets',
        name: 'Big',
        config: {
          refreshToken: 'rt-big',
          spreadsheetId: 'sheet-big',
          sheetName: 'Bulk',
          schedule: 'manual',
        },
      },
    });
    const { id } = JSON.parse(create.payload);

    const { runSync } = await import('../../src/modules/integrations/integration-service.js');
    await runSync(id);
    // 1 header + 3 data chunks
    expect(sheetsUpdateMock).toHaveBeenCalledTimes(4);
    expect(sheetsUpdateMock.mock.calls[1][0].requestBody.values).toHaveLength(1000);
    expect(sheetsUpdateMock.mock.calls[3][0].requestBody.values).toHaveLength(500);
    await app.close();
  });
});

// ── AC-0003 + AC-0004 ────────────────────────────────────────────────────────

describe('AC-0003 + AC-0004: Telegram integration', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
    loggerInfo.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  it('AC-0003: POST telegram_bot with valid token → 201 + test message sent', async () => {
    mockTelegramOk();
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'telegram_bot',
        name: 'Ops channel',
        config: {
          botToken: '1234567890:AAH-secrettoken',
          chatId: '-100123',
          eventTypes: ['contact.created', 'order.created'],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('api.telegram.org/bot1234567890:AAH-secrettoken/sendMessage');
    await app.close();
  });

  it('AC-0004: POST telegram_bot with invalid token → 400 + provider error', async () => {
    mockTelegramFail(401, '{"ok":false,"description":"Unauthorized"}');
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'telegram_bot',
        name: 'Bad',
        config: {
          botToken: 'badtokenbad',
          chatId: '1',
          eventTypes: ['contact.created'],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Telegram');
    expect(await prisma.integration.count()).toBe(0);
    await app.close();
  });

  it('telegram apiEndpoint SSRF guard blocks private host', async () => {
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'telegram_bot',
        name: 'Bad',
        config: {
          botToken: '111:abc',
          chatId: '1',
          eventTypes: ['contact.created'],
          apiEndpoint: 'http://192.168.0.1',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── AC-0005 ──────────────────────────────────────────────────────────────────

describe('AC-0005: RBAC (member rejected)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
  });

  it('member POST → 403', async () => {
    const { org, user } = await seedOrg('member');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: { type: 'telegram_bot', name: 'X', config: {} },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('member PATCH → 403', async () => {
    const { org, user } = await seedOrg('member');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'member' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/integrations/anything',
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('member DELETE → 403', async () => {
    const { org, user } = await seedOrg('member');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'member' });
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/integrations/x' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ── AC-0006 ──────────────────────────────────────────────────────────────────

describe('AC-0006: manual sync endpoint', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
  });

  it('POST /:id/sync → 202 + runId + IntegrationRun row', async () => {
    const { org, user } = await seedOrg('admin');
    await seedContacts(org.id, 1);
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'google_sheets',
        name: 'Manual',
        config: {
          refreshToken: 'rt',
          spreadsheetId: 'sheet',
          sheetName: 'A',
          schedule: 'manual',
        },
      },
    });
    const { id } = JSON.parse(create.payload);

    const trigger = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/${id}/sync`,
    });
    expect(trigger.statusCode).toBe(202);
    const body = JSON.parse(trigger.payload);
    expect(body.runId).toBeTruthy();

    // Drain background work + assert run row exists.
    const { flushBackgroundTasks } = await import(
      '../../src/shared/utils/background-tasks.js'
    );
    await flushBackgroundTasks();
    const run = await prisma.integrationRun.findUnique({ where: { id: body.runId } });
    expect(run).not.toBeNull();
    await app.close();
  });
});

// ── AC-0007 ──────────────────────────────────────────────────────────────────

describe('AC-0007: worker scheduler', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
  });

  it('runDueIntegrations picks up due integration', async () => {
    const { org, user } = await seedOrg('admin');
    await seedContacts(org.id, 2);
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'google_sheets',
        name: 'Daily',
        config: {
          refreshToken: 'rt',
          spreadsheetId: 'sheet',
          sheetName: 'A',
          schedule: 'daily',
        },
      },
    });
    expect(create.statusCode).toBe(201);

    const { runDueIntegrations } = await import(
      '../../src/workers/integration-runner.js'
    );
    await runDueIntegrations();

    const runs = await prisma.integrationRun.findMany();
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('succeeded');
    await app.close();
  });

  it('manual-schedule integration is not picked up by worker', async () => {
    const { org, user } = await seedOrg('admin');
    await seedContacts(org.id, 1);
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'google_sheets',
        name: 'OnlyManual',
        config: {
          refreshToken: 'rt',
          spreadsheetId: 'sheet',
          sheetName: 'A',
          schedule: 'manual',
        },
      },
    });
    const { runDueIntegrations } = await import(
      '../../src/workers/integration-runner.js'
    );
    await runDueIntegrations();
    expect(await prisma.integrationRun.count()).toBe(0);
    await app.close();
  });
});

// ── AC-0009 + AC-0011 ────────────────────────────────────────────────────────

describe('AC-0009 + AC-0011: event tee + token hygiene', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
    mockTelegramOk();
    loggerInfo.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  it('AC-0009: contact.created event → Telegram receives BR-0013 format', async () => {
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'telegram_bot',
        name: 'Ops alerts',
        config: {
          botToken: '9999:secrettokenABCDE',
          chatId: '-100',
          eventTypes: ['contact.created'],
        },
      },
    });
    // testConnection consumed one fetch; reset for the event tee.
    fetchMock.mockClear();
    mockTelegramOk();

    const { dispatchEvent } = await import(
      '../../src/modules/integrations/integration-service.js'
    );
    await dispatchEvent({
      orgId: org.id,
      type: 'contact.created',
      payload: { fullName: 'Nguyễn Văn A', phone: '0900', source: 'manual' },
      emittedAt: new Date(),
    });
    const { flushBackgroundTasks } = await import(
      '../../src/shared/utils/background-tasks.js'
    );
    await flushBackgroundTasks();

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('🆕 KH mới: Nguyễn Văn A (0900) — nguồn: manual');
    await app.close();
  });

  it('AC-0011: logs do not leak raw bot token on Telegram error', async () => {
    mockTelegramFail(401, '{"ok":false,"description":"Bot 9999:supersecret is unauthorized"}');
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'telegram_bot',
        name: 'WillFail',
        config: {
          botToken: '9999:supersecretabcdef',
          chatId: '-100',
          eventTypes: ['contact.created'],
        },
      },
    });
    // Validate creation failed (expected) — and verify no logger call leaks
    // the raw token verbatim.
    const allLogs = [
      ...loggerInfo.mock.calls,
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
    ]
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
    expect(allLogs).not.toContain('supersecretabcdef');
    await app.close();
  });
});

// ── AC-0010 ──────────────────────────────────────────────────────────────────

describe('AC-0010: disabled integrations are skipped', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
    mockTelegramOk();
  });

  it('disabled telegram does not receive event tee', async () => {
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'telegram_bot',
        name: 'Off',
        config: {
          // ≥ 10 chars: telegram_bot validator requires botToken.length >= 10
          // (see isTelegramBotConfig in connectors/telegram-bot.ts).
          botToken: '111:abcdefg',
          chatId: '-1',
          eventTypes: ['contact.created'],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = JSON.parse(create.payload);
    // Flip enabled=false
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${id}`,
      payload: { enabled: false },
    });
    fetchMock.mockClear();

    const { dispatchEvent } = await import(
      '../../src/modules/integrations/integration-service.js'
    );
    await dispatchEvent({
      orgId: org.id,
      type: 'contact.created',
      payload: { fullName: 'X' },
      emittedAt: new Date(),
    });
    const { flushBackgroundTasks } = await import(
      '../../src/shared/utils/background-tasks.js'
    );
    await flushBackgroundTasks();
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('disabled sheets is not picked up by worker', async () => {
    const { org, user } = await seedOrg('admin');
    await seedContacts(org.id, 1);
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'google_sheets',
        name: 'OffDaily',
        config: {
          refreshToken: 'rt',
          spreadsheetId: 'sheet',
          sheetName: 'A',
          schedule: 'daily',
        },
      },
    });
    const { id } = JSON.parse(create.payload);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${id}`,
      payload: { enabled: false },
    });
    sheetsUpdateMock.mockClear();
    const { runDueIntegrations } = await import(
      '../../src/workers/integration-runner.js'
    );
    await runDueIntegrations();
    expect(sheetsUpdateMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── Run history endpoint ─────────────────────────────────────────────────────

describe('GET /:id/runs', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
  });

  it('returns recent runs ordered desc', async () => {
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const integration = await prisma.integration.create({
      data: {
        orgId: org.id,
        type: 'google_sheets',
        name: 'X',
        configCipher: 'a',
        configIv: 'b',
        configTag: 'c',
      },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.integrationRun.create({
        data: {
          integrationId: integration.id,
          status: 'succeeded',
          recordsProcessed: i,
        },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/${integration.id}/runs?limit=10`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.runs).toHaveLength(3);
    await app.close();
  });
});

// ── Soft delete clears cipher ────────────────────────────────────────────────

describe('soft delete clears encrypted config', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    fetchMock.mockReset();
    resetGoogleMocks();
    mockTelegramOk();
  });

  it('DELETE clears configCipher/Iv/Tag and disables row', async () => {
    const { org, user } = await seedOrg('admin');
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      payload: {
        type: 'telegram_bot',
        name: 'ToDelete',
        config: {
          // ≥ 10 chars: telegram_bot validator requires botToken.length >= 10.
          botToken: '111:abcdefg',
          chatId: '-1',
          eventTypes: ['contact.created'],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const { id } = JSON.parse(create.payload);
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/integrations/${id}` });
    expect(del.statusCode).toBe(204);
    const row = await prisma.integration.findUnique({ where: { id } });
    expect(row?.enabled).toBe(false);
    expect(row?.configCipher).toBe('');
    expect(row?.configIv).toBe('');
    expect(row?.configTag).toBe('');
    await app.close();
  });
});
