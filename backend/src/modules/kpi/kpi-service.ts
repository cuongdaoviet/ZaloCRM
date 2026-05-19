/**
 * KPI aggregation queries. Reads directly from Message / Order / Contact —
 * we don't try to populate DailyMessageStat since nothing currently writes to
 * it and realtime queries are fine at our current volume.
 */
import { prisma } from '../../shared/database/prisma-client.js';

/** Money / count totals for an org over [from, to] inclusive. */
export interface PeriodMetrics {
  messagesSent: number;
  messagesReceived: number;
  newContacts: number;
  convertedContacts: number;
  ordersCount: number;
  revenue: number;
}

const COUNTED_ORDER_STATUSES = ['paid', 'shipped', 'completed'];

export async function getMetricsForRange(
  orgId: string,
  from: Date,
  to: Date,
): Promise<PeriodMetrics> {
  const dateFilter = { gte: from, lte: to };

  const [
    messagesSent,
    messagesReceived,
    newContacts,
    convertedContacts,
    orderAgg,
  ] = await Promise.all([
    // BR-0005: real staff-sent messages only (auto-reply has repliedByUserId=null)
    prisma.message.count({
      where: {
        conversation: { orgId },
        senderType: 'self',
        repliedByUserId: { not: null },
        sentAt: dateFilter,
        isDeleted: false,
      },
    }),
    prisma.message.count({
      where: {
        conversation: { orgId },
        senderType: 'contact',
        sentAt: dateFilter,
        isDeleted: false,
      },
    }),
    prisma.contact.count({
      where: { orgId, createdAt: dateFilter },
    }),
    prisma.contact.count({
      // BR-0007: proxy — contact reached 'converted' status during the range
      where: { orgId, status: 'converted', updatedAt: dateFilter },
    }),
    // Aggregate orders in one trip
    prisma.order.aggregate({
      where: {
        orgId,
        status: { in: COUNTED_ORDER_STATUSES },
        createdAt: dateFilter,
      },
      _count: { id: true },
      _sum: { totalAmount: true },
    }),
  ]);

  return {
    messagesSent,
    messagesReceived,
    newContacts,
    convertedContacts,
    ordersCount: orderAgg._count.id,
    revenue: orderAgg._sum.totalAmount ?? 0,
  };
}

export type LeaderboardMetric =
  | 'messagesSent'
  | 'revenue'
  | 'ordersCount'
  | 'newContacts';

export interface LeaderboardRow {
  userId: string;
  fullName: string;
  email: string;
  value: number;
  rank: number;
}

/**
 * Top-N users for a given metric. Each metric has a different "who counts":
 *   messagesSent  → Message.repliedByUserId
 *   revenue/orders → Order.createdByUserId, status filtered
 *   newContacts   → Contact.assignedUserId
 */
export async function getLeaderboard(
  orgId: string,
  metric: LeaderboardMetric,
  from: Date,
  to: Date,
  limit: number,
): Promise<LeaderboardRow[]> {
  const dateFilter = { gte: from, lte: to };

  if (metric === 'messagesSent') {
    const grouped = await prisma.message.groupBy({
      by: ['repliedByUserId'],
      where: {
        conversation: { orgId },
        senderType: 'self',
        repliedByUserId: { not: null },
        sentAt: dateFilter,
        isDeleted: false,
      },
      _count: { _all: true },
      orderBy: { _count: { repliedByUserId: 'desc' } },
      take: limit,
    });
    return hydrateUsers(
      grouped
        .map((g) => ({ userId: g.repliedByUserId!, value: g._count._all }))
        .filter((g) => !!g.userId),
    );
  }

  if (metric === 'newContacts') {
    const grouped = await prisma.contact.groupBy({
      by: ['assignedUserId'],
      where: { orgId, createdAt: dateFilter, assignedUserId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { assignedUserId: 'desc' } },
      take: limit,
    });
    return hydrateUsers(
      grouped
        .map((g) => ({ userId: g.assignedUserId!, value: g._count._all }))
        .filter((g) => !!g.userId),
    );
  }

  // metric === 'revenue' or 'ordersCount' — both group on Order.createdByUserId
  const grouped = await prisma.order.groupBy({
    by: ['createdByUserId'],
    where: {
      orgId,
      status: { in: COUNTED_ORDER_STATUSES },
      createdAt: dateFilter,
    },
    _count: { _all: true },
    _sum: { totalAmount: true },
    // Note: orderBy with `_sum` requires the same field in `_sum`; the
    // generated client lets us do this when revenue is the metric.
    orderBy:
      metric === 'revenue'
        ? { _sum: { totalAmount: 'desc' } }
        : { _count: { createdByUserId: 'desc' } },
    take: limit,
  });

  return hydrateUsers(
    grouped.map((g) => ({
      userId: g.createdByUserId,
      value:
        metric === 'revenue' ? (g._sum.totalAmount ?? 0) : g._count._all,
    })),
  );
}

async function hydrateUsers(
  rows: { userId: string; value: number }[],
): Promise<LeaderboardRow[]> {
  if (rows.length === 0) return [];
  const userIds = rows.map((r) => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, fullName: true, email: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Drop rows where the user has been deleted (EC-0003)
  return rows
    .filter((r) => userMap.has(r.userId))
    .map((r, idx) => {
      const u = userMap.get(r.userId)!;
      return {
        userId: r.userId,
        fullName: u.fullName,
        email: u.email,
        value: r.value,
        rank: idx + 1,
      };
    });
}
