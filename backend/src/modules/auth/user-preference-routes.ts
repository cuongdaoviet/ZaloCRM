/**
 * Per-user preferences KV store — feature 0016.
 *
 * Server-side store for UI preferences (theme, density, sidebar state,
 * last-used filters, ...) so they follow the user across devices. Values are
 * arbitrary JSON; validation is by KEY allowlist (see user-preference-helpers).
 *
 * All endpoints are scoped to the authenticated user. No `orgId` filter is
 * needed since `userId = req.user.id` already locks the row to the caller.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from './auth-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import {
  ALLOWED_KEYS,
  validateKey,
  validateValueSize,
} from './user-preference-helpers.js';

export async function userPreferenceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/me/preferences — full map for the caller. Empty object if none.
  app.get('/api/v1/me/preferences', async (request) => {
    const user = request.user!;
    const rows = await prisma.userPreference.findMany({
      where: { userId: user.id },
      select: { key: true, value: true },
    });
    const map: Record<string, unknown> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return map;
  });

  // GET /api/v1/me/preferences/:key — single value lookup. 404 if unset.
  app.get<{ Params: { key: string } }>(
    '/api/v1/me/preferences/:key',
    async (request, reply) => {
      const user = request.user!;
      const { key } = request.params;
      // Validate the key shape so we never trip the DB with arbitrary garbage,
      // but treat "valid key not in allowlist" the same as "not set" on a read.
      const keyError = validateKey(key);
      if (keyError) {
        return reply.status(404).send({ error: 'Không tồn tại' });
      }
      const row = await prisma.userPreference.findUnique({
        where: { userId_key: { userId: user.id, key } },
        select: { key: true, value: true },
      });
      if (!row) {
        return reply.status(404).send({ error: 'Không tồn tại' });
      }
      return { key: row.key, value: row.value };
    },
  );

  // PUT /api/v1/me/preferences/:key — upsert arbitrary JSON value.
  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/api/v1/me/preferences/:key',
    async (request, reply) => {
      const user = request.user!;
      const { key } = request.params;

      const keyError = validateKey(key);
      if (keyError) {
        return reply.status(400).send({ error: keyError });
      }

      const body = request.body;
      if (typeof body !== 'object' || body === null || !('value' in body)) {
        return reply.status(400).send({ error: 'Body phải có field value' });
      }
      const value = (body as { value: unknown }).value;

      const sizeError = validateValueSize(value);
      if (sizeError) {
        return reply.status(400).send({ error: sizeError });
      }

      // Prisma's JSON columns reject `undefined`. Coerce to null explicitly
      // so callers can clear a value with `{ value: null }` or `{ value: undefined }`.
      const jsonValue = value === undefined ? null : value;

      const row = await prisma.userPreference.upsert({
        where: { userId_key: { userId: user.id, key } },
        create: {
          id: randomUUID(),
          userId: user.id,
          key,
          value: jsonValue as never,
        },
        update: { value: jsonValue as never },
        select: { id: true, userId: true, key: true, value: true, updatedAt: true },
      });

      logger.debug(`[user-preferences] user ${user.id} set ${key}`);
      return row;
    },
  );

  // DELETE /api/v1/me/preferences/:key — idempotent.
  app.delete<{ Params: { key: string } }>(
    '/api/v1/me/preferences/:key',
    async (request, reply) => {
      const user = request.user!;
      const { key } = request.params;

      // Validate shape only — if key is invalid we still 204 to keep DELETE
      // idempotent. Bad key obviously can't be present in the table.
      const keyError = validateKey(key);
      if (!keyError) {
        await prisma.userPreference.deleteMany({
          where: { userId: user.id, key },
        });
      }
      return reply.status(204).send();
    },
  );
}

// Re-export so other modules can introspect the allowlist if needed.
export { ALLOWED_KEYS };
