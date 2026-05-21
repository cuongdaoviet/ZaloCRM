/**
 * Auth routes — setup, login, and profile endpoints.
 * Registered as a Fastify plugin via app.register(authRoutes).
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from './auth-middleware.js';
import {
  checkSetupStatus,
  setup,
  login,
  getProfile,
} from './auth-service.js';
import { check as checkLoginRate } from '../../shared/security/login-attempt-tracker.js';
import { logActivityAsync } from '../activity/activity-service.js';
import { logger } from '../../shared/utils/logger.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/setup/status — check if first-run setup is needed
  app.get('/api/v1/setup/status', async () => {
    return checkSetupStatus();
  });

  // POST /api/v1/setup — create org + owner user, return JWT
  app.post<{
    Body: { orgName: string; fullName: string; email: string; password: string };
  }>('/api/v1/setup', async (request, reply) => {
    const { orgName, fullName, email, password } = request.body;
    if (!orgName || !fullName || !email || !password) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }
    const payload = await setup(orgName, fullName, email, password);
    const token = app.jwt.sign(payload, { expiresIn: '7d' });
    return { token, user: payload };
  });

  // POST /api/v1/auth/login — verify credentials, return JWT
  //
  // Feature 0046 BR-0018/BR-0019 — per-email rate limit BEFORE bcrypt.
  // 5 failures in 15 minutes → 429 with Retry-After header. Don't burn
  // bcrypt CPU on a rate-limited account.
  app.post<{
    Body: { email: string; password: string };
  }>('/api/v1/auth/login', async (request, reply) => {
    const { email, password } = request.body;
    if (!email || !password) {
      return reply.status(400).send({ error: 'Missing email or password' });
    }

    // Pre-bcrypt rate limit check.
    const gate = checkLoginRate(email);
    if (!gate.allowed) {
      logger.warn(
        `[auth] login rate-limited for ${email} ip=${request.ip} retryAfter=${gate.retryAfterSeconds}s`,
      );
      reply.header('Retry-After', String(gate.retryAfterSeconds));
      return reply.status(429).send({
        error: 'Too many failed login attempts. Try again later.',
        retryAfterSeconds: gate.retryAfterSeconds,
      });
    }

    try {
      const payload = await login(email, password, request.ip);
      const token = app.jwt.sign(payload, { expiresIn: '7d' });
      // BR-0020 — successful logins are also audit-worthy (compare
      // against the failures stream). Fire-and-forget.
      logActivityAsync({
        orgId: payload.orgId,
        userId: payload.id,
        action: 'auth.login.succeeded',
        details: { email: payload.email, ip: request.ip },
      });
      return { token, user: payload };
    } catch (err) {
      // Failure logged inside login() — see auth-service.ts. Re-raise
      // for the Fastify error handler.
      throw err;
    }
  });

  // GET /api/v1/profile — return current user (requires auth)
  app.get('/api/v1/profile', { preHandler: authMiddleware }, async (request) => {
    const user = request.user as { id: string; email: string; role: string; orgId: string };
    return getProfile(user.id);
  });
}
