/**
 * Aggregate queries for feature 0041 — funnel + team performance.
 *
 * All queries are scoped by `orgId` and exclude soft-deleted / merged contacts
 * so the numbers match what Reps see in the CRM UI.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import {
  FUNNEL_STAGES,
  computeFunnelRates,
  type FunnelStage,
  type FunnelStageRow,
} from './analytics-helpers.js';

export interface FunnelFilter {
  orgId: string;
  from: Date;
  to: Date;
  teamId?: string;
  assignedUserId?: string;
}

export interface FunnelResult {
  stages: FunnelStageRow[];
  lost: { count: number };
  totalContacts: number;
}

/**
 * Snapshot funnel — counts contacts CURRENTLY in each status whose
 * `createdAt` falls in the window. (BR-0002: Phase 1 = snapshot view.)
 *
 * Note we deliberately filter `mergedIntoId IS NULL` so duplicates folded into
 * a primary contact don't double-count.
 */
export async function getFunnel(filter: FunnelFilter): Promise<FunnelResult> {
  const { orgId, from, to, teamId, assignedUserId } = filter;

  // Build the team scope as a discrete user-ID list. Doing one extra round-trip
  // here keeps the funnel query a simple GROUP BY rather than forcing a join.
  let userIdScope: string[] | undefined;
  if (teamId) {
    const users = await prisma.user.findMany({
      where: { orgId, teamId },
      select: { id: true },
    });
    userIdScope = users.map((u) => u.id);
    // If the team has no members we can short-circuit — nothing to count.
    if (userIdScope.length === 0) {
      return emptyFunnel();
    }
  }

  const where: Prisma.ContactWhereInput = {
    orgId,
    mergedIntoId: null,
    createdAt: { gte: from, lte: to },
  };
  if (assignedUserId) {
    where.assignedUserId = assignedUserId;
  } else if (userIdScope) {
    where.assignedUserId = { in: userIdScope };
  }

  const grouped = await prisma.contact.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  });

  // Normalise into a stage→count map. Postgres returns null status as a
  // separate group — we currently treat null as "new" in the UI elsewhere,
  // but for funnel clarity we only count rows that explicitly match a stage.
  const counts: Record<FunnelStage, number> = {
    new: 0,
    contacted: 0,
    interested: 0,
    converted: 0,
  };
  let lostCount = 0;
  let totalContacts = 0;
  for (const row of grouped) {
    const c = row._count._all;
    totalContacts += c;
    if (row.status === 'lost') {
      lostCount = c;
      continue;
    }
    if (row.status && (FUNNEL_STAGES as readonly string[]).includes(row.status)) {
      counts[row.status as FunnelStage] = c;
    } else if (row.status === null) {
      // Null status is treated as 'new' across the CRM — be consistent here.
      counts.new += c;
    }
  }

  return {
    stages: computeFunnelRates(counts),
    lost: { count: lostCount },
    totalContacts,
  };
}

function emptyFunnel(): FunnelResult {
  return {
    stages: computeFunnelRates({ new: 0, contacted: 0, interested: 0, converted: 0 }),
    lost: { count: 0 },
    totalContacts: 0,
  };
}

// ── Team performance ──────────────────────────────────────────────────────────

export interface TeamPerfFilter {
  orgId: string;
  from: Date;
  to: Date;
  teamId?: string;
}

export interface TeamPerfRow {
  userId: string;
  fullName: string;
  avgResponseTimeMinutes: number | null;
  outboundMessageCount: number;
  convertedContactsCount: number;
  activeConversationsCount: number;
}

export interface TeamPerfResult {
  byUser: TeamPerfRow[];
  totals: {
    outboundMessageCount: number;
    convertedContactsCount: number;
  };
}

/**
 * Compute per-rep performance for the period.
 *
 * Strategy: roster first (one user query), then issue narrow aggregate queries
 * for each metric and stitch the results together in JS. This keeps each query
 * SARGable against existing indexes and avoids a giant N+1 from `$queryRaw`.
 *
 * Response time uses a single CTE-style $queryRaw: for every inbound message
 * find the next outbound on the same conversation within the window, take the
 * delta, then average per-rep.
 */
export async function getTeamPerformance(
  filter: TeamPerfFilter,
): Promise<TeamPerfResult> {
  const { orgId, from, to, teamId } = filter;

  // 1. Roster — only active users; filter by team if requested.
  const users = await prisma.user.findMany({
    where: {
      orgId,
      isActive: true,
      ...(teamId ? { teamId } : {}),
    },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
  });
  if (users.length === 0) {
    return { byUser: [], totals: { outboundMessageCount: 0, convertedContactsCount: 0 } };
  }
  const userIds = users.map((u) => u.id);

  // 2. Outbound messages per rep in window — staff messages only.
  const outboundGrouped = await prisma.message.groupBy({
    by: ['repliedByUserId'],
    where: {
      conversation: { orgId },
      senderType: 'self',
      repliedByUserId: { in: userIds },
      sentAt: { gte: from, lte: to },
      isDeleted: false,
    },
    _count: { _all: true },
  });
  const outboundByUser = new Map<string, number>();
  for (const g of outboundGrouped) {
    if (g.repliedByUserId) outboundByUser.set(g.repliedByUserId, g._count._all);
  }

  // 3. Converted contacts per assignedUserId, updated in window.
  const convertedGrouped = await prisma.contact.groupBy({
    by: ['assignedUserId'],
    where: {
      orgId,
      status: 'converted',
      assignedUserId: { in: userIds },
      updatedAt: { gte: from, lte: to },
      mergedIntoId: null,
    },
    _count: { _all: true },
  });
  const convertedByUser = new Map<string, number>();
  for (const g of convertedGrouped) {
    if (g.assignedUserId) convertedByUser.set(g.assignedUserId, g._count._all);
  }

  // 4. Active conversations — last inbound within 7 days from `to`. Reuses
  //    Feature 0033's "active in 7 days" definition, anchored to the end of
  //    the selected period so historical snapshots stay meaningful.
  const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const activeCutoff = new Date(to.getTime() - ACTIVE_WINDOW_MS);
  const activeRows = await prisma.$queryRaw<{ assigned_user_id: string; count: bigint }[]>`
    SELECT c.assigned_user_id, COUNT(DISTINCT conv.id) AS count
    FROM contacts c
    JOIN conversations conv ON conv.contact_id = c.id
    JOIN messages m ON m.conversation_id = conv.id
    WHERE c.org_id = ${orgId}
      AND c.assigned_user_id = ANY(${userIds}::text[])
      AND c.merged_into_id IS NULL
      AND m.sender_type = 'contact'
      AND m.is_deleted = false
      AND m.sent_at >= ${activeCutoff}
      AND m.sent_at <= ${to}
    GROUP BY c.assigned_user_id
  `;
  const activeByUser = new Map<string, number>();
  for (const r of activeRows) {
    activeByUser.set(r.assigned_user_id, Number(r.count));
  }

  // 5. Avg response time per rep.
  //    For every inbound message, find the next outbound on the same
  //    conversation that was sent by ANY of our roster users — take the
  //    delta in seconds — attribute it to the rep who sent the outbound.
  //    Per-rep average is then `AVG(delta) / 60` in minutes.
  //
  //    EC-0003: contacts with no inbound → no rows → NULL avg.
  const responseRows = await prisma.$queryRaw<
    { user_id: string; avg_seconds: number | null }[]
  >`
    WITH inbound AS (
      SELECT m.id, m.conversation_id, m.sent_at
      FROM messages m
      JOIN conversations conv ON conv.id = m.conversation_id
      WHERE conv.org_id = ${orgId}
        AND m.sender_type = 'contact'
        AND m.is_deleted = false
        AND m.sent_at >= ${from}
        AND m.sent_at <= ${to}
    ),
    paired AS (
      SELECT
        i.conversation_id,
        i.sent_at AS inbound_at,
        (
          SELECT m2.sent_at
          FROM messages m2
          WHERE m2.conversation_id = i.conversation_id
            AND m2.sender_type = 'self'
            AND m2.is_deleted = false
            AND m2.replied_by_user_id = ANY(${userIds}::text[])
            AND m2.sent_at > i.sent_at
            AND m2.sent_at <= ${to}
          ORDER BY m2.sent_at ASC
          LIMIT 1
        ) AS replied_at,
        (
          SELECT m2.replied_by_user_id
          FROM messages m2
          WHERE m2.conversation_id = i.conversation_id
            AND m2.sender_type = 'self'
            AND m2.is_deleted = false
            AND m2.replied_by_user_id = ANY(${userIds}::text[])
            AND m2.sent_at > i.sent_at
            AND m2.sent_at <= ${to}
          ORDER BY m2.sent_at ASC
          LIMIT 1
        ) AS user_id
      FROM inbound i
    )
    SELECT user_id, AVG(EXTRACT(EPOCH FROM (replied_at - inbound_at)))::float8 AS avg_seconds
    FROM paired
    WHERE replied_at IS NOT NULL AND user_id IS NOT NULL
    GROUP BY user_id
  `;
  const avgRespByUser = new Map<string, number>();
  for (const r of responseRows) {
    if (r.avg_seconds !== null && Number.isFinite(r.avg_seconds)) {
      // Convert seconds → minutes with one decimal of precision.
      avgRespByUser.set(r.user_id, Math.round((r.avg_seconds / 60) * 10) / 10);
    }
  }

  // 6. Stitch.
  const byUser: TeamPerfRow[] = users.map((u) => ({
    userId: u.id,
    fullName: u.fullName,
    avgResponseTimeMinutes: avgRespByUser.get(u.id) ?? null,
    outboundMessageCount: outboundByUser.get(u.id) ?? 0,
    convertedContactsCount: convertedByUser.get(u.id) ?? 0,
    activeConversationsCount: activeByUser.get(u.id) ?? 0,
  }));

  const totals = byUser.reduce(
    (acc, r) => ({
      outboundMessageCount: acc.outboundMessageCount + r.outboundMessageCount,
      convertedContactsCount: acc.convertedContactsCount + r.convertedContactsCount,
    }),
    { outboundMessageCount: 0, convertedContactsCount: 0 },
  );

  return { byUser, totals };
}
