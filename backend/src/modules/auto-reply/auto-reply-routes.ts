/**
 * Auto-reply rule management — feature 0005.
 *
 * The rule is keyed 1-1 to a ZaloAccount, so all routes nest under
 * /api/v1/zalo-accounts/:id/auto-reply. Owners/admins of the CRM bypass the
 * account-level access check; members need 'admin' permission on the Zalo
 * account itself.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { validateRuleInput } from './auto-reply-helpers.js';

export async function autoReplyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET — fetch current rule (404 if none configured yet)
  app.get<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/auto-reply',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      // Guard cross-org access (requireZaloAccess already restricts members,
      // but the org scope check here is cheap and clear).
      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account không tồn tại' });

      const rule = await prisma.autoReplyRule.findUnique({
        where: { zaloAccountId: id },
      });
      if (!rule) return reply.status(404).send({ error: 'Chưa cấu hình auto-reply' });
      return rule;
    },
  );

  // PUT — upsert. SPEC §5 validation rules live in validateRuleInput.
  app.put<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/auto-reply',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account không tồn tại' });

      const validated = validateRuleInput(request.body);
      if (!validated.ok) return reply.status(400).send({ error: validated.error });
      const v = validated.value;

      const rule = await prisma.autoReplyRule.upsert({
        where: { zaloAccountId: id },
        create: {
          id: randomUUID(),
          zaloAccountId: id,
          enabled: v.enabled,
          daysOfWeek: v.daysOfWeek,
          startMinute: v.startMinute,
          endMinute: v.endMinute,
          timezone: v.timezone,
          message: v.message,
          cooldownMinutes: v.cooldownMinutes,
        },
        update: {
          enabled: v.enabled,
          daysOfWeek: v.daysOfWeek,
          startMinute: v.startMinute,
          endMinute: v.endMinute,
          timezone: v.timezone,
          message: v.message,
          cooldownMinutes: v.cooldownMinutes,
        },
      });

      logger.info(
        `[auto-reply] User ${user.id} upsert rule for account ${id} (enabled=${rule.enabled})`,
      );
      return rule;
    },
  );

  // DELETE — drop the rule (cascade clears history rows too)
  app.delete<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/auto-reply',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account không tồn tại' });

      await prisma.autoReplyRule.deleteMany({ where: { zaloAccountId: id } });
      logger.info(`[auto-reply] User ${user.id} deleted rule for account ${id}`);
      return reply.status(204).send();
    },
  );
}
