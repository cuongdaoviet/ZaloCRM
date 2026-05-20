/**
 * Integration tests for feature 0017 — POST /api/v1/appointments/parse.
 *
 * The route is pure compute (no DB writes / no FK lookups), but we still go
 * through the standard mock pattern so auth behaviour is exercised.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function buildAuthedApp(user: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  vi.doMock('../../src/modules/auth/auth-middleware.js', () => ({
    authMiddleware: async (req: any) => {
      if (!req.user) req.user = user;
    },
  }));
  vi.resetModules();
  const { appointmentParseRoutes } = await import(
    '../../src/modules/contacts/appointment-parse-routes.js'
  );
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  await app.register(appointmentParseRoutes);
  return app;
}

async function buildUnauthedApp(): Promise<FastifyInstance> {
  vi.doMock('../../src/modules/auth/auth-middleware.js', () => ({
    authMiddleware: async (_req: any, reply: any) => {
      return reply.status(401).send({ error: 'Unauthorized' });
    },
  }));
  vi.resetModules();
  const { appointmentParseRoutes } = await import(
    '../../src/modules/contacts/appointment-parse-routes.js'
  );
  const app = Fastify();
  await app.register(appointmentParseRoutes);
  return app;
}

describe('POST /api/v1/appointments/parse', () => {
  it('returns parsed result for Vietnamese appointment text', async () => {
    const app = await buildAuthedApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/parse',
      payload: { text: 'hẹn gặp 9h sáng mai nhé' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.matchedPhrase).toContain('9h sáng mai');
    expect(body.confidence).toBeGreaterThan(0);
    // date should be a parseable ISO string in JSON
    expect(new Date(body.date).getHours()).toBe(9);
    await app.close();
  });

  it('returns { result: null } when no intent is detected', async () => {
    const app = await buildAuthedApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/parse',
      payload: { text: 'abc xyz random text' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ result: null });
    await app.close();
  });

  it('returns 400 when text field is missing', async () => {
    const app = await buildAuthedApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/parse',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when text is not a string', async () => {
    const app = await buildAuthedApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/parse',
      payload: { text: 12345 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when text > 5000 chars', async () => {
    const app = await buildAuthedApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/parse',
      payload: { text: 'a'.repeat(5001) },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('accepts text at exactly the 5000 char boundary', async () => {
    const app = await buildAuthedApp({ id: 'u1', orgId: 'o1', role: 'owner' });
    // Pad an appointment phrase out to 5000 chars; intent should still be found.
    const phrase = 'hẹn gặp 14h ngày 20/5';
    const padding = ' '.repeat(5000 - phrase.length);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/parse',
      payload: { text: phrase + padding },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('unauthenticated request → 401', async () => {
    const app = await buildUnauthedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/appointments/parse',
      payload: { text: 'hẹn gặp 9h sáng mai nhé' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
