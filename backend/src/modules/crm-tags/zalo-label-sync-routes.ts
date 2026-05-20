/**
 * Phase A.1 — Zalo label sync endpoint.
 *
 *   POST /api/v1/zalo-accounts/:id/sync-labels
 *     Pulls the live Zalo label catalog for the given account, upserts it
 *     into ZaloLabel + CrmTagGroup + CrmTag(managedBy='zalo_sync'). Orphaned
 *     Zalo-managed tags (no longer in the upstream catalog) are archived.
 *
 * Owner/admin only. Cross-org → 404.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { logger } from '../../shared/utils/logger.js';
import { syncZaloLabels, type ZaloLabelDataInput } from './zalo-label-sync.js';

export async function zaloLabelSyncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.post<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/sync-labels',
    { preHandler: requireRole('owner', 'admin') },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      const { id: zaloAccountId } = request.params;

      // Org isolation — reject cross-org access cleanly with 404 (don't leak
      // existence of accounts in other orgs).
      const account = await prisma.zaloAccount.findFirst({
        where: { id: zaloAccountId, orgId: user.orgId },
        select: { id: true, displayName: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Tài khoản Zalo không tồn tại' });
      }

      const instance = zaloPool.getInstance(zaloAccountId);
      if (!instance?.api) {
        return reply.status(400).send({
          error: 'Tài khoản Zalo chưa kết nối',
          code: 'ZALO_NOT_LOGGED_IN',
        });
      }

      // Call zca-js. If it throws, surface as 502 — partner-side fault.
      let payload: { labelData: ZaloLabelDataInput[]; version: number };
      try {
        const resp = await (instance.api as any).getLabels();
        payload = {
          labelData: Array.isArray(resp?.labelData) ? resp.labelData : [],
          version: typeof resp?.version === 'number' ? resp.version : 0,
        };
      } catch (err) {
        logger.warn(`[zalo-label-sync] zca-js getLabels failed for ${zaloAccountId}:`, err);
        return reply.status(502).send({
          error: 'Không lấy được nhãn từ Zalo',
          code: 'ZALO_BRIDGE_ERROR',
        });
      }

      try {
        const result = await syncZaloLabels({
          orgId: user.orgId,
          zaloAccountId,
          labels: payload.labelData,
          version: payload.version,
          zaloAccountDisplayName: account.displayName,
        });
        logger.info(
          `[zalo-label-sync] account=${zaloAccountId} created=${result.labelsCreated} ` +
            `updated=${result.labelsUpdated} archived=${result.labelsArchived} ` +
            `adopted=${result.adopted}`,
        );
        return reply.send({ synced: result });
      } catch (err) {
        logger.error('[zalo-label-sync] persistence error:', err);
        return reply.status(500).send({ error: 'Không lưu được nhãn đồng bộ' });
      }
    },
  );
}
