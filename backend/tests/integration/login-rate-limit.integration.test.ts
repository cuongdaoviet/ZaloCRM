/**
 * Integration tests for Feature 0046 login rate limiting.
 *
 * Covers SPEC §6:
 *  - AC-0008: 6th failed login for same email in <15 min → 429 with
 *    Retry-After.
 *  - AC-0009: success after 4 failures clears the tracker so the
 *    next failure is "1", not "5".
 *
 * Also exercises bcrypt-vs-no-user-found symmetry and per-email
 * isolation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import fastifyJwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';
import { __resetForTests as resetLoginTracker } from '../../src/shared/security/login-attempt-tracker.js';

let prisma: PrismaClient;

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
  vi.restoreAllMocks();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-only-for-integration-tests' });
  const { authRoutes } = await import('../../src/modules/auth/auth-routes.js');
  await app.register(authRoutes);
  return app;
}

async function seedUser(email: string, password: string) {
  const org = await prisma.organization.create({
    data: { name: `org-${Date.now()}-${Math.random()}` },
  });
  const passwordHash = await bcrypt.hash(password, 4);
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: email.toLowerCase(),
      passwordHash,
      fullName: 'Test User',
      role: 'owner',
    },
  });
  return { org, user };
}

describe('Login rate limit (Feature 0046)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    resetLoginTracker();
    vi.restoreAllMocks();
  });

  it('AC-0008: 6th failed login for same email returns 429 with Retry-After', async () => {
    await seedUser('victim@example.com', 'right-password');
    const app = await buildApp();

    // 5 failures — all 401, none rate-limited.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'victim@example.com', password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    }

    // 6th attempt — must be 429 even with the RIGHT password (no
    // bcrypt CPU spent).
    const res6 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'victim@example.com', password: 'right-password' },
    });
    expect(res6.statusCode).toBe(429);
    expect(res6.headers['retry-after']).toBeDefined();
    expect(Number(res6.headers['retry-after'])).toBeGreaterThan(0);
    const body = res6.json() as { retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(0);

    await app.close();
  });

  it('AC-0009: success after 4 failures clears tracker — next failure is fresh', async () => {
    await seedUser('alice@example.com', 'correct-horse');
    const app = await buildApp();

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'alice@example.com', password: 'nope' },
      });
      expect(res.statusCode).toBe(401);
    }

    // Now a success — should clear the tracker.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'alice@example.com', password: 'correct-horse' },
    });
    expect(ok.statusCode).toBe(200);

    // After clearing, 4 more failed attempts should NOT exceed the
    // budget (the tracker reset, so this is 4/5, not 8/5).
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'alice@example.com', password: 'nope' },
      });
      expect(res.statusCode).toBe(401);
    }

    await app.close();
  });

  it('different emails have independent budgets (per-email lockout)', async () => {
    await seedUser('a@example.com', 'pwA');
    await seedUser('b@example.com', 'pwB');
    const app = await buildApp();

    // Lock out A.
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'a@example.com', password: 'wrong' },
      });
    }
    const lockedA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@example.com', password: 'pwA' },
    });
    expect(lockedA.statusCode).toBe(429);

    // B can still log in.
    const okB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'b@example.com', password: 'pwB' },
    });
    expect(okB.statusCode).toBe(200);

    await app.close();
  });

  it('unknown-email failures count against the rate limit too', async () => {
    const app = await buildApp();

    // 5 failed attempts on a NEVER-REGISTERED email.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ghost@example.com', password: 'whatever' },
      });
      expect(res.statusCode).toBe(401);
    }
    const res6 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ghost@example.com', password: 'whatever' },
    });
    expect(res6.statusCode).toBe(429);

    await app.close();
  });
});
