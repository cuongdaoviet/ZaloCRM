/**
 * Zalo account management routes.
 * All endpoints require authentication via authMiddleware.
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { zaloPool } from './zalo-pool.js';
import { prisma } from '../../shared/database/prisma-client.js';
import {
  validateAndNormalizeProxyUrl,
  isAdminRole,
  maskProxyUrl,
} from '../../shared/network/proxy-agent.js';
import { logger } from '../../shared/utils/logger.js';

export async function zaloRoutes(app: FastifyInstance): Promise<void> {
  // All routes in this plugin require auth
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/zalo-accounts — list accounts with live status from pool.
  // Feature 0035 BR-0005: include `proxyUrl` only for owner/admin callers.
  app.get('/api/v1/zalo-accounts', async (request) => {
    const user = request.user!;
    const accounts = await prisma.zaloAccount.findMany({
      where: { orgId: user.orgId },
      select: {
        id: true,
        zaloUid: true,
        displayName: true,
        avatarUrl: true,
        phone: true,
        status: true,
        lastConnectedAt: true,
        createdAt: true,
        proxyUrl: true,
        owner: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const isAdmin = isAdminRole(user.role);
    return accounts.map((a) => {
      // Strip proxyUrl for non-admin (BR-0005).
      const { proxyUrl, ...rest } = a;
      return {
        ...rest,
        ...(isAdmin ? { proxyUrl } : {}),
        liveStatus: zaloPool.getStatus(a.id),
      };
    });
  });

  // POST /api/v1/zalo-accounts — create a new account record
  app.post<{ Body: { displayName?: string } }>(
    '/api/v1/zalo-accounts',
    async (request, reply) => {
      const user = request.user!;
      const { displayName } = request.body ?? {};

      const account = await prisma.zaloAccount.create({
        data: {
          orgId: user.orgId,
          ownerUserId: user.id,
          displayName: displayName ?? null,
          status: 'qr_pending',
        },
      });

      return reply.status(201).send(account);
    },
  );

  // POST /api/v1/zalo-accounts/:id/login — initiate QR login
  app.post<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/login',
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      // Fire-and-forget — QR delivered via Socket.IO
      zaloPool.loginQR(id).catch(() => {
        // errors are emitted via socket; no need to crash here
      });

      return { message: 'QR login initiated — subscribe to account:' + id + ' socket room' };
    },
  );

  // POST /api/v1/zalo-accounts/:id/reconnect — force reconnect using saved session
  app.post<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/reconnect',
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      const session = account.sessionData as {
        cookie: any;
        imei: string;
        userAgent: string;
      } | null;

      if (!session?.imei) {
        return reply.status(400).send({ error: 'No saved session — please login with QR first' });
      }

      // Fire-and-forget — result emitted via Socket.IO
      zaloPool.reconnect(id, session).catch(() => {});

      return { message: 'Reconnect initiated' };
    },
  );

  // DELETE /api/v1/zalo-accounts/:id — disconnect and delete record
  app.delete<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id',
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      zaloPool.disconnect(id);
      await prisma.zaloAccount.delete({ where: { id } });

      return reply.status(204).send();
    },
  );

  // GET /api/v1/zalo-accounts/:id/status — live status from pool
  app.get<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/status',
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, status: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      return { accountId: id, liveStatus: zaloPool.getStatus(id) };
    },
  );

  // GET /api/v1/zalo-accounts/:id — single account.
  // Feature 0035 BR-0005: include proxyUrl only for owner/admin.
  app.get<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id',
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;
      const isAdmin = isAdminRole(user.role);

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: {
          id: true,
          zaloUid: true,
          displayName: true,
          avatarUrl: true,
          phone: true,
          status: true,
          lastConnectedAt: true,
          createdAt: true,
          proxyUrl: true,
          owner: { select: { id: true, fullName: true, email: true } },
        },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      const { proxyUrl, ...rest } = account;
      return {
        ...rest,
        ...(isAdmin ? { proxyUrl } : {}),
        liveStatus: zaloPool.getStatus(id),
      };
    },
  );

  // PUT /api/v1/zalo-accounts/:id — update account fields.
  // Feature 0035: accept `proxyUrl` (Owner/Admin only).
  // BR-0003: backend-authoritative validation.
  // BR-0007: return `requiresReconnect: true` when proxyUrl changes AND the
  //          account is currently connected (no auto-reconnect).
  app.put<{
    Params: { id: string };
    Body: { proxyUrl?: string | null; displayName?: string | null };
  }>(
    '/api/v1/zalo-accounts/:id',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;
      const body = request.body ?? {};

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, status: true, proxyUrl: true, displayName: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      const updateData: { proxyUrl?: string | null; displayName?: string | null } = {};
      let proxyUrlChanged = false;
      let newProxyUrl: string | null | undefined = undefined;

      if (Object.prototype.hasOwnProperty.call(body, 'proxyUrl')) {
        const result = validateAndNormalizeProxyUrl(body.proxyUrl);
        if (!result.valid) {
          return reply.status(400).send({
            error: 'Định dạng proxy không hợp lệ',
            code: 'invalid_proxy_format',
          });
        }
        newProxyUrl = result.normalized ?? null;
        if (newProxyUrl !== account.proxyUrl) {
          proxyUrlChanged = true;
          updateData.proxyUrl = newProxyUrl;
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
        // displayName is optional UX field — accept any string or null/empty
        // (treat empty as null).
        const raw = body.displayName;
        const normalized =
          typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
        if (normalized !== account.displayName) {
          updateData.displayName = normalized;
        }
      }

      // Live status from pool is authoritative for "currently connected".
      const liveStatus = zaloPool.getStatus(id);
      const isConnected = liveStatus === 'connected';

      let updated = account;
      if (Object.keys(updateData).length > 0) {
        updated = await prisma.zaloAccount.update({
          where: { id },
          data: updateData,
          select: { id: true, status: true, proxyUrl: true, displayName: true },
        });

        if (proxyUrlChanged) {
          logger.info(
            `[zalo:${id}] proxy updated to ${maskProxyUrl(updated.proxyUrl)} by user ${user.id}`,
          );
        }
      }

      const requiresReconnect = proxyUrlChanged && isConnected;

      return {
        ...updated,
        liveStatus,
        requiresReconnect,
      };
    },
  );
}
