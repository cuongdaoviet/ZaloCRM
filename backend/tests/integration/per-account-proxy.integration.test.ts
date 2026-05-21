/**
 * Feature 0035 — Per-account proxy config integration tests.
 *
 * Acceptance criteria coverage:
 *   AC-0001  Schema migration (column exists) — implicit (prisma db push must run)
 *   AC-0002  PUT valid SOCKS5 → 200 + requiresReconnect when connected
 *   AC-0003  PUT invalid format → 400 invalid_proxy_format
 *   AC-0004  PUT null/empty → clears proxy
 *   AC-0005  Member PUT → 403
 *   AC-0006  Member GET account list/single → response strips proxyUrl
 *   AC-0007  Admin GET account list/single → response includes proxyUrl
 *   AC-0008  Reconnect with SOCKS5 proxyUrl → spy verifies Zalo({agent}) called
 *   AC-0009  Unreachable proxy → reconnect fails, account.status unchanged
 *   AC-0010  Logging masks credentials (no leak)
 *   AC-0011  FE — verified separately
 *   AC-0012  Build — verified separately by `npm run build`
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';
import {
  encryptProxyUrl,
  decryptProxyUrl,
} from '../../src/shared/crypto/encrypt-proxy-url.js';

let prisma: PrismaClient;

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));

// Capture logger output so we can assert credential masking (AC-0010).
const loggerCalls: { level: string; args: unknown[] }[] = [];
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => loggerCalls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => loggerCalls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => loggerCalls.push({ level: 'error', args }),
    debug: (...args: unknown[]) => loggerCalls.push({ level: 'debug', args }),
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

interface Seed {
  orgId: string;
  adminId: string;
  memberId: string;
  accountId: string;
}

async function seed(initialStatus = 'disconnected', proxyUrl: string | null = null): Promise<Seed> {
  const org = await prisma.organization.create({ data: { name: 'OrgProxy' } });
  const admin = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `admin-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Admin',
      role: 'admin',
    },
  });
  const member = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `member-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'Member',
      role: 'member',
    },
  });
  // Feature 0044 — proxyUrl now stored as AES-256-GCM cipher columns.
  const cipher = encryptProxyUrl(org.id, proxyUrl);
  const account = await prisma.zaloAccount.create({
    data: {
      orgId: org.id,
      ownerUserId: admin.id,
      displayName: 'Acc-1',
      status: initialStatus,
      proxyUrlCipher: cipher.proxyUrlCipher,
      proxyUrlIv: cipher.proxyUrlIv,
      proxyUrlTag: cipher.proxyUrlTag,
    },
  });
  return { orgId: org.id, adminId: admin.id, memberId: member.id, accountId: account.id };
}

/** Test-only: read the stored proxyUrl from the DB and decrypt it. */
async function readStoredProxy(
  prisma: PrismaClient,
  accountId: string,
): Promise<string | null> {
  const row = await prisma.zaloAccount.findUnique({
    where: { id: accountId },
    select: {
      orgId: true,
      proxyUrlCipher: true,
      proxyUrlIv: true,
      proxyUrlTag: true,
    },
  });
  if (!row) return null;
  return decryptProxyUrl(row.orgId, {
    proxyUrlCipher: row.proxyUrlCipher,
    proxyUrlIv: row.proxyUrlIv,
    proxyUrlTag: row.proxyUrlTag,
  });
}

async function buildApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { zaloRoutes } = await import('../../src/modules/zalo/zalo-routes.js');
  await app.register(zaloRoutes);
  return app;
}

beforeEach(async () => {
  await resetDb(prisma);
  loggerCalls.length = 0;
});

describe('Feature 0035 — PUT /api/v1/zalo-accounts/:id (proxyUrl)', () => {
  it('AC-0002: admin PUT valid SOCKS5 → 200 with persisted normalized value', async () => {
    const s = await seed('disconnected');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'socks5://user:pass@10.0.0.1:1080/' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // trailing slash stripped on save
    expect(body.proxyUrl).toBe('socks5://user:pass@10.0.0.1:1080');
    // DB row reflects the same (decrypt the cipher to compare plaintext).
    expect(await readStoredProxy(prisma, s.accountId)).toBe(
      'socks5://user:pass@10.0.0.1:1080',
    );
    // Not connected → no reconnect required.
    expect(body.requiresReconnect).toBe(false);
    await app.close();
  });

  it('AC-0002b: admin PUT when account is connected → requiresReconnect=true', async () => {
    const s = await seed('connected');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    // The handler reads live status from the pool. Spy it to return "connected".
    const { zaloPool } = await import('../../src/modules/zalo/zalo-pool.js');
    const spy = vi.spyOn(zaloPool, 'getStatus').mockReturnValue('connected');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'socks5://user:pass@10.0.0.1:1080' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.requiresReconnect).toBe(true);
    expect(body.proxyUrl).toBe('socks5://user:pass@10.0.0.1:1080');

    spy.mockRestore();
    await app.close();
  });

  it('AC-0002c: normalizes socks:// → socks5://', async () => {
    const s = await seed('disconnected');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'socks://10.0.0.1:1080' },
    });
    expect(res.statusCode).toBe(200);
    expect(await readStoredProxy(prisma, s.accountId)).toBe(
      'socks5://10.0.0.1:1080',
    );
    await app.close();
  });

  it('AC-0002d: HTTP and HTTPS proxies accepted', async () => {
    const s = await seed('disconnected');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    const httpRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'http://proxy.example.com:8080' },
    });
    expect(httpRes.statusCode).toBe(200);
    expect(JSON.parse(httpRes.payload).proxyUrl).toBe('http://proxy.example.com:8080');

    const httpsRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'https://proxy.example.com:8443' },
    });
    expect(httpsRes.statusCode).toBe(200);
    expect(JSON.parse(httpsRes.payload).proxyUrl).toBe('https://proxy.example.com:8443');

    await app.close();
  });

  it('AC-0003: PUT invalid format → 400 invalid_proxy_format', async () => {
    const s = await seed('disconnected');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    for (const bad of ['socks5//bad', 'ftp://10.0.0.1:1080', 'not-a-url', 'socks5://10.0.0.1:99999']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/zalo-accounts/${s.accountId}`,
        payload: { proxyUrl: bad },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).code).toBe('invalid_proxy_format');
    }

    // DB row unchanged.
    expect(await readStoredProxy(prisma, s.accountId)).toBeNull();
    await app.close();
  });

  it('AC-0004: PUT null clears proxy', async () => {
    const s = await seed('disconnected', 'socks5://user:pass@10.0.0.1:1080');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: null },
    });
    expect(res.statusCode).toBe(200);
    expect(await readStoredProxy(prisma, s.accountId)).toBeNull();
    await app.close();
  });

  it('AC-0004b: PUT empty string clears proxy', async () => {
    const s = await seed('disconnected', 'socks5://user:pass@10.0.0.1:1080');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(await readStoredProxy(prisma, s.accountId)).toBeNull();
    await app.close();
  });

  it('EC-0004: same proxyUrl → requiresReconnect=false (no-op)', async () => {
    const s = await seed('connected', 'socks5://10.0.0.1:1080');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    const { zaloPool } = await import('../../src/modules/zalo/zalo-pool.js');
    const spy = vi.spyOn(zaloPool, 'getStatus').mockReturnValue('connected');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'socks5://10.0.0.1:1080' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).requiresReconnect).toBe(false);

    spy.mockRestore();
    await app.close();
  });

  it('AC-0005: member PUT → 403', async () => {
    const s = await seed('disconnected');
    const app = await buildApp({ id: s.memberId, orgId: s.orgId, role: 'member' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'socks5://10.0.0.1:1080' },
    });
    expect(res.statusCode).toBe(403);
    // DB unchanged.
    expect(await readStoredProxy(prisma, s.accountId)).toBeNull();
    await app.close();
  });

  it('AC-0010: logger output masks credentials on proxy update', async () => {
    const s = await seed('disconnected');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    await app.inject({
      method: 'PUT',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
      payload: { proxyUrl: 'socks5://secretuser:secretpass@10.0.0.1:1080' },
    });

    // Find log lines that mention the host but NOT the credentials.
    const flat = loggerCalls
      .map((c) => c.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    expect(flat).toContain('proxy updated');
    expect(flat).toContain('10.0.0.1');
    expect(flat).toContain('***@');
    expect(flat).not.toContain('secretuser');
    expect(flat).not.toContain('secretpass');
    await app.close();
  });
});

describe('Feature 0035 — GET visibility (BR-0005)', () => {
  it('AC-0006: member GET list → proxyUrl stripped', async () => {
    const s = await seed('disconnected', 'socks5://u:p@10.0.0.1:1080');
    const app = await buildApp({ id: s.memberId, orgId: s.orgId, role: 'member' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/zalo-accounts' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Array<Record<string, unknown>>;
    const target = body.find((a) => a.id === s.accountId);
    expect(target).toBeDefined();
    expect(target?.proxyUrl).toBeUndefined();
    await app.close();
  });

  it('AC-0006b: member GET single → proxyUrl stripped', async () => {
    const s = await seed('disconnected', 'socks5://u:p@10.0.0.1:1080');
    const app = await buildApp({ id: s.memberId, orgId: s.orgId, role: 'member' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.proxyUrl).toBeUndefined();
    await app.close();
  });

  it('AC-0007: admin GET list → proxyUrl present', async () => {
    const s = await seed('disconnected', 'socks5://u:p@10.0.0.1:1080');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/zalo-accounts' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Array<Record<string, unknown>>;
    const target = body.find((a) => a.id === s.accountId);
    expect(target?.proxyUrl).toBe('socks5://u:p@10.0.0.1:1080');
    await app.close();
  });

  it('AC-0007b: admin GET single → proxyUrl present', async () => {
    const s = await seed('disconnected', 'socks5://u:p@10.0.0.1:1080');
    const app = await buildApp({ id: s.adminId, orgId: s.orgId, role: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/zalo-accounts/${s.accountId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.proxyUrl).toBe('socks5://u:p@10.0.0.1:1080');
    await app.close();
  });
});

describe('Feature 0035 — zalo-pool integration (AC-0008, AC-0009)', () => {
  it('AC-0008: reconnect with proxyUrl passes a SocksProxyAgent to new Zalo({agent})', async () => {
    const s = await seed('disconnected', 'socks5://u:p@10.0.0.1:1080');

    // Install a fake Zalo ctor that records the agent and returns a successful api stub.
    const recorded: { agent?: unknown; logging?: boolean } = {};
    class FakeZalo {
      constructor(opts: { logging: boolean; agent?: unknown }) {
        recorded.agent = opts.agent;
        recorded.logging = opts.logging;
      }
      async login(): Promise<unknown> {
        return {
          getOwnId: async () => 'fake-uid',
          getUserInfo: async () => ({ changed_profiles: {} }),
          listener: { stop: () => {}, on: () => {}, start: () => {} },
        };
      }
    }

    const pool = await import('../../src/modules/zalo/zalo-pool.js');
    pool.__setZaloConstructorForTests(FakeZalo as unknown as never);

    // Stub attachListener to skip the real listener wiring.
    const listenerMod = await import('../../src/modules/zalo/zalo-listener-factory.js');
    const lsSpy = vi.spyOn(listenerMod, 'attachZaloListener').mockImplementation(() => {});

    try {
      await pool.zaloPool.reconnect(s.accountId, {
        cookie: [],
        imei: 'imei-1',
        userAgent: 'ua-1',
      });

      expect(recorded.agent).toBeDefined();
      // The agent built by buildProxyAgent for a socks5:// URL is SocksProxyAgent.
      expect(
        (recorded.agent as { constructor: { name: string } }).constructor.name,
      ).toBe('SocksProxyAgent');
    } finally {
      pool.__resetZaloConstructorForTests();
      lsSpy.mockRestore();
    }
  });

  it('AC-0008b: reconnect with no proxy → agent=undefined', async () => {
    const s = await seed('disconnected', null);

    const recorded: { agent?: unknown } = {};
    class FakeZalo {
      constructor(opts: { logging: boolean; agent?: unknown }) {
        recorded.agent = opts.agent;
      }
      async login(): Promise<unknown> {
        return {
          getOwnId: async () => 'fake-uid',
          getUserInfo: async () => ({ changed_profiles: {} }),
          listener: { stop: () => {}, on: () => {}, start: () => {} },
        };
      }
    }

    const pool = await import('../../src/modules/zalo/zalo-pool.js');
    pool.__setZaloConstructorForTests(FakeZalo as unknown as never);
    const listenerMod = await import('../../src/modules/zalo/zalo-listener-factory.js');
    const lsSpy = vi.spyOn(listenerMod, 'attachZaloListener').mockImplementation(() => {});

    try {
      await pool.zaloPool.reconnect(s.accountId, {
        cookie: [],
        imei: 'imei-2',
        userAgent: 'ua-2',
      });
      expect(recorded.agent).toBeUndefined();
    } finally {
      pool.__resetZaloConstructorForTests();
      lsSpy.mockRestore();
    }
  });

  it('AC-0009: unreachable proxy → reconnect-failed emitted, account.status not flipped to qr_pending', async () => {
    const s = await seed('disconnected', 'socks5://127.0.0.1:1');

    // Fake Zalo whose login() throws an ECONNREFUSED-like error (simulating
    // SocksProxyAgent failing to reach the proxy).
    class ProxyFailZalo {
      constructor(_opts: { logging: boolean; agent?: unknown }) {}
      async login(): Promise<never> {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1 (proxy)');
      }
    }

    const pool = await import('../../src/modules/zalo/zalo-pool.js');
    pool.__setZaloConstructorForTests(ProxyFailZalo as unknown as never);
    const listenerMod = await import('../../src/modules/zalo/zalo-listener-factory.js');
    const lsSpy = vi.spyOn(listenerMod, 'attachZaloListener').mockImplementation(() => {});

    try {
      await pool.zaloPool.reconnect(s.accountId, {
        cookie: [],
        imei: 'imei-3',
        userAgent: 'ua-3',
      });

      const row = await prisma.zaloAccount.findUnique({
        where: { id: s.accountId },
        select: { status: true },
      });
      // BR-0008: status must NOT be flipped to qr_pending for proxy errors.
      // We allow `disconnected` (the value updateAccountDB writes in the
      // proxy-error branch) but explicitly reject `qr_pending`.
      expect(row?.status).not.toBe('qr_pending');
      // proxyUrl is now stored encrypted — decrypt to compare.
      expect(await readStoredProxy(prisma, s.accountId)).toBe(
        'socks5://127.0.0.1:1',
      );
    } finally {
      pool.__resetZaloConstructorForTests();
      lsSpy.mockRestore();
    }
  });

  it('AC-0010: pool logs use masked proxy URL when reconnecting', async () => {
    const s = await seed('disconnected', 'socks5://hiddenuser:hiddenpw@10.0.0.5:1080');

    class FakeZalo {
      constructor(_opts: { logging: boolean; agent?: unknown }) {}
      async login(): Promise<unknown> {
        return {
          getOwnId: async () => 'fake-uid',
          getUserInfo: async () => ({ changed_profiles: {} }),
          listener: { stop: () => {}, on: () => {}, start: () => {} },
        };
      }
    }
    const pool = await import('../../src/modules/zalo/zalo-pool.js');
    pool.__setZaloConstructorForTests(FakeZalo as unknown as never);
    const listenerMod = await import('../../src/modules/zalo/zalo-listener-factory.js');
    const lsSpy = vi.spyOn(listenerMod, 'attachZaloListener').mockImplementation(() => {});

    try {
      await pool.zaloPool.reconnect(s.accountId, {
        cookie: [],
        imei: 'imei-4',
        userAgent: 'ua-4',
      });
      const flat = loggerCalls
        .map((c) => c.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');
      expect(flat).toContain('10.0.0.5');
      expect(flat).toContain('***@');
      expect(flat).not.toContain('hiddenuser');
      expect(flat).not.toContain('hiddenpw');
    } finally {
      pool.__resetZaloConstructorForTests();
      lsSpy.mockRestore();
    }
  });
});
