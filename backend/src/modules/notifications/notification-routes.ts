/**
 * Notification routes — computed on-the-fly notifications for the authenticated user.
 * Sources: unreplied conversations, today/tomorrow appointments, disconnected Zalo accounts.
 */
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { zaloPool } from '../zalo/zalo-pool.js';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  detail: string;
  priority: string;
  createdAt: string;
}

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/notifications', async (request) => {
    const user = request.user!;
    const notifications: NotificationItem[] = [];

    // 1. Unreplied conversations > 30 min
    const thirtyMinAgo = new Date(Date.now() - 30 * 60000);
    const unreplied = await prisma.conversation.count({
      where: { orgId: user.orgId, isReplied: false, lastMessageAt: { lt: thirtyMinAgo } },
    });
    if (unreplied > 0) {
      notifications.push({
        id: 'unreplied',
        type: 'warning',
        priority: 'high',
        title: `${unreplied} cuộc trò chuyện chưa trả lời`,
        detail: 'Có tin nhắn chưa phản hồi quá 30 phút',
        createdAt: new Date().toISOString(),
      });
    }

    // 2. Today's appointments
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const todayApts = await prisma.appointment.findMany({
      where: {
        orgId: user.orgId,
        appointmentDate: { gte: todayStart, lt: todayEnd },
        status: 'scheduled',
      },
      include: { contact: { select: { fullName: true } } },
      take: 5,
    });
    for (const apt of todayApts) {
      notifications.push({
        id: `apt-${apt.id}`,
        type: 'info',
        priority: 'medium',
        title: `Lịch hẹn: ${apt.contact?.fullName || 'KH'}`,
        detail: `${apt.appointmentTime || ''} - ${apt.notes || 'Tái khám'}`,
        createdAt: apt.appointmentDate.toISOString(),
      });
    }

    // 3. Tomorrow's appointments
    const tomorrowStart = new Date(todayEnd);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

    const tmrApts = await prisma.appointment.count({
      where: {
        orgId: user.orgId,
        appointmentDate: { gte: tomorrowStart, lt: tomorrowEnd },
        status: 'scheduled',
      },
    });
    if (tmrApts > 0) {
      notifications.push({
        id: 'tmr-apts',
        type: 'info',
        priority: 'low',
        title: `${tmrApts} lịch hẹn ngày mai`,
        detail: 'Chuẩn bị cho ngày mai',
        createdAt: new Date().toISOString(),
      });
    }

    // 4. Disconnected Zalo accounts — Feature 0053 F18.
    //
    // The previous query emitted a notification for EVERY account whose
    // `zaloPool.getStatus()` wasn't 'connected'. That returns 'disconnected'
    // for two completely different states:
    //   (a) Account was logged in earlier, then dropped — real notification.
    //   (b) Account was just created and has never been QR-scanned —
    //       expected state, NOT a notification.
    // The bell would show a stale "1" on a fresh org because of (b).
    //
    // Two fixes:
    //   - Only flag accounts with non-null `sessionData` (= they were
    //     connected at some point, so a drop is meaningful).
    //   - For members, only flag accounts they actually have access to via
    //     the zalo_account_access ACL; otherwise the bell shows alerts about
    //     accounts the member can't even see.
    const accountWhere: Prisma.ZaloAccountWhereInput = {
      orgId: user.orgId,
      sessionData: { not: Prisma.JsonNull },
    };
    if (user.role === 'member') {
      const accessRows = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      accountWhere.id = { in: accessRows.map((a) => a.zaloAccountId) };
    }
    const accounts = await prisma.zaloAccount.findMany({
      where: accountWhere,
      select: { id: true, displayName: true },
    });
    for (const acc of accounts) {
      const status = zaloPool.getStatus(acc.id);
      if (status !== 'connected') {
        notifications.push({
          id: `zalo-${acc.id}`,
          type: 'error',
          priority: 'high',
          title: `Zalo "${acc.displayName}" mất kết nối`,
          detail: `Trạng thái: ${status}`,
          createdAt: new Date().toISOString(),
        });
      }
    }

    return { notifications };
  });
}
