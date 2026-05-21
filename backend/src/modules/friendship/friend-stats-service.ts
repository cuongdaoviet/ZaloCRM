/**
 * Friend stats — feature 0033.
 *
 * Aggregates two counts per ZaloAccount in an org:
 *   - acceptedNicksCount: rows in `friends` for that zaloAccountId
 *   - chattingNicksCount: DISTINCT friend.contactId where an inbound message
 *     (senderType='contact') exists on the same conversation within the
 *     configurable active window (default 7 days).
 *
 * Why on-demand instead of denormalized counters:
 *   Friend rows churn (Feature 0020 daily refresh) and message activity
 *   shifts hourly. Denormalized counters drift constantly; a 60s cache on a
 *   cheap aggregate gives the same UX without the bookkeeping cost.
 *
 * Performance:
 *   - acceptedNicksCount: a single grouped scan of `friends` filtered by
 *     `(orgId, zaloAccountId IN (..))`. Uses `(orgId, createdAt DESC)` index
 *     well enough at our scale; if it ever doesn't, add `(orgId, zaloAccountId)`.
 *   - chattingNicksCount: joined on `conversations.contactId`. The new
 *     `(conversationId, senderType, sentAt DESC)` index makes the message
 *     side an index range scan instead of a seq scan.
 *
 * Cache: in-memory Map keyed by (orgId, userId). 60s TTL satisfies BR-0007
 * without bringing in Redis. Tests can drop the cache directly.
 *
 * Permission filter (BR-0004 / BR-0005): the route resolves which
 * ZaloAccount ids the caller can see (owner/admin → all in org, member → only
 * those they have an ACL row for). This module receives the resolved id list
 * and never trusts the role on its own.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { config } from '../../config/index.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface AccountStat {
  zaloAccountId: string;
  displayName: string | null;
  acceptedNicksCount: number;
  chattingNicksCount: number;
}

export interface FriendStatsResponse {
  byAccount: AccountStat[];
  totals: {
    acceptedNicksCount: number;
    chattingNicksCount: number;
  };
  windowDays: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cache (BR-0007 — 60s in-memory)
// ──────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  expiresAt: number;
  payload: FriendStatsResponse;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

function readCache(orgId: string, userId: string): FriendStatsResponse | null {
  const entry = cache.get(cacheKey(orgId, userId));
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(cacheKey(orgId, userId));
    return null;
  }
  return entry.payload;
}

function writeCache(orgId: string, userId: string, payload: FriendStatsResponse): void {
  cache.set(cacheKey(orgId, userId), {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload,
  });
}

/** Test/admin helper: drop the entire cache. Not exposed through HTTP. */
export function clearFriendStatsCache(): void {
  cache.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// Permission resolution
// ──────────────────────────────────────────────────────────────────────────────

interface VisibleAccount {
  id: string;
  displayName: string | null;
}

async function resolveVisibleAccounts(
  orgId: string,
  userId: string,
  role: string,
): Promise<VisibleAccount[]> {
  if (role === 'owner' || role === 'admin') {
    return prisma.zaloAccount.findMany({
      where: { orgId },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
  }
  // Member — return only accounts the user has any ACL row for.
  return prisma.zaloAccount.findMany({
    where: {
      orgId,
      access: { some: { userId } },
    },
    select: { id: true, displayName: true },
    orderBy: { displayName: 'asc' },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Aggregate queries (raw SQL — easier to reason about EXPLAIN and forces the
// query planner to pick a stable plan; Prisma's groupBy would emit subtly
// different SQL across versions).
// ──────────────────────────────────────────────────────────────────────────────

interface AcceptedRow {
  zalo_account_id: string;
  accepted: bigint;
}

interface ChattingRow {
  zalo_account_id: string;
  chatting: bigint;
}

async function countAccepted(
  orgId: string,
  accountIds: string[],
): Promise<Map<string, number>> {
  if (accountIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<AcceptedRow[]>`
    SELECT zalo_account_id, COUNT(*)::bigint AS accepted
    FROM friends
    WHERE org_id = ${orgId}
      AND zalo_account_id = ANY(${accountIds}::text[])
    GROUP BY zalo_account_id
  `;
  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.zalo_account_id, Number(row.accepted));
  }
  return out;
}

async function countChatting(
  orgId: string,
  accountIds: string[],
  windowDays: number,
): Promise<Map<string, number>> {
  if (accountIds.length === 0) return new Map();
  // BR-0002: chatting = distinct friend.contactId where there's an inbound
  // message in the window on the conversation linking that contact ↔ the
  // friend's zaloAccount.
  // BR-0003: friends with contactId NULL are excluded here (cannot identify
  // a conversation), so they only show up in `acceptedNicksCount`.
  const rows = await prisma.$queryRaw<ChattingRow[]>`
    SELECT f.zalo_account_id, COUNT(DISTINCT f.contact_id)::bigint AS chatting
    FROM friends f
    JOIN conversations c
      ON c.contact_id = f.contact_id
     AND c.zalo_account_id = f.zalo_account_id
    JOIN messages m
      ON m.conversation_id = c.id
     AND m.sender_type = 'contact'
     AND m.sent_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
    WHERE f.org_id = ${orgId}
      AND f.zalo_account_id = ANY(${accountIds}::text[])
      AND f.contact_id IS NOT NULL
    GROUP BY f.zalo_account_id
  `;
  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.zalo_account_id, Number(row.chatting));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

export interface ComputeInput {
  orgId: string;
  userId: string;
  role: string;
}

export async function computeFriendStats(input: ComputeInput): Promise<FriendStatsResponse> {
  const cached = readCache(input.orgId, input.userId);
  if (cached) return cached;

  const accounts = await resolveVisibleAccounts(input.orgId, input.userId, input.role);
  const accountIds = accounts.map((a) => a.id);
  const windowDays = config.friendActiveWindowDays;

  const [acceptedMap, chattingMap] = await Promise.all([
    countAccepted(input.orgId, accountIds),
    countChatting(input.orgId, accountIds, windowDays),
  ]);

  const byAccount: AccountStat[] = accounts.map((a) => ({
    zaloAccountId: a.id,
    displayName: a.displayName,
    acceptedNicksCount: acceptedMap.get(a.id) ?? 0,
    chattingNicksCount: chattingMap.get(a.id) ?? 0,
  }));

  const totals = byAccount.reduce(
    (acc, row) => ({
      acceptedNicksCount: acc.acceptedNicksCount + row.acceptedNicksCount,
      chattingNicksCount: acc.chattingNicksCount + row.chattingNicksCount,
    }),
    { acceptedNicksCount: 0, chattingNicksCount: 0 },
  );

  const payload: FriendStatsResponse = {
    byAccount,
    totals,
    windowDays,
  };
  writeCache(input.orgId, input.userId, payload);
  return payload;
}
