/**
 * lead-score-service.ts — Feature 0040 lead scoring (rules-based, phase 1).
 *
 * DB-backed wrappers around the pure formula in `lead-score-helpers.ts`.
 *
 * Computes a 0-100 "lead heat" score per contact, on-demand. Components:
 *   - Recency of last inbound message     (max 40 points)
 *   - Engagement count last 30 days       (max 30 points)
 *   - Pipeline status                     (max 20 points)
 *   - Upcoming appointment proximity      (max 10 points)
 *
 * Score is NOT persisted (BR-0009). Per-org weights live in
 * `Organization.leadScoreConfig` JSON; when unset we fall back to defaults
 * documented in BR-0001..BR-0004 (see DEFAULT_LEAD_SCORE_CONFIG below).
 *
 * The batch entry point (`computeLeadScoresBatch`) is what list endpoints
 * call. It issues at most three aggregate queries regardless of contact
 * count:
 *   1. contacts.status — one findMany on the IN list
 *   2. messages JOIN conversations — recency + engagement per contact
 *   3. appointments — soonest upcoming per contact
 * No N+1, even on large contact pages (BR-0010 target: < 200ms / 100 contacts).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import {
  DEFAULT_LEAD_SCORE_CONFIG,
  resolveLeadScoreConfig,
  scoreFromInputs,
  type LeadScoreConfig,
  type LeadScoreResult,
} from './lead-score-helpers.js';

// Re-export the pure surface so callers can import everything from one spot.
export * from './lead-score-helpers.js';

/**
 * Load + parse the org's lead score config, falling back to defaults if
 * unset or corrupt (EC-0003). Pure read — never throws on invalid JSON.
 */
export async function loadLeadScoreConfig(orgId: string): Promise<LeadScoreConfig> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { leadScoreConfig: true },
  });
  return resolveLeadScoreConfig(org?.leadScoreConfig);
}

// ── DB-backed compute (single + batch) ───────────────────────────────────────

/**
 * Compute lead score for a single contact. Convenience wrapper around the
 * batch entry point — use the batch variant for lists.
 */
export async function computeLeadScore(
  contactId: string,
  config: LeadScoreConfig,
  now: Date = new Date(),
): Promise<LeadScoreResult> {
  const map = await computeLeadScoresBatch([contactId], config, now);
  return (
    map.get(contactId) ?? {
      score: 0,
      breakdown: { recency: 0, engagement: 0, status: 0, appointment: 0 },
    }
  );
}

/**
 * Batch compute — single aggregate query for each of the three inputs.
 *
 * `messages` aggregate computes BOTH lastInboundAt (MAX) and inboundLast30d
 * (COUNT FILTER … WHERE sentAt >= now-30d). The conversation join restricts
 * to the contact's threads; senderType='contact' restricts to inbound.
 *
 * Empty `contactIds` short-circuits to an empty map.
 */
export async function computeLeadScoresBatch(
  contactIds: string[],
  config: LeadScoreConfig,
  now: Date = new Date(),
): Promise<Map<string, LeadScoreResult>> {
  const out = new Map<string, LeadScoreResult>();
  if (contactIds.length === 0) return out;

  const nowMs = now.getTime();
  const thirtyDaysAgo = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);

  // Pull contact statuses first — we need them no matter what.
  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds } },
    select: { id: true, status: true },
  });
  const statusById = new Map<string, string | null>(
    contacts.map((c) => [c.id, c.status ?? null]),
  );

  // Single aggregate over messages JOIN conversations: per contact, compute
  // MAX(sentAt) over inbound and COUNT(*) FILTER WHERE sentAt >= now-30d.
  // Using $queryRaw for the conditional COUNT — Prisma's groupBy doesn't
  // support FILTER clauses. The IN list is bound as a typed array literal
  // (ANY(...::text[])) to keep the same prepared-statement shape across
  // any contactIds length — friend-stats-service uses the same pattern.
  const messageAgg = await prisma.$queryRaw<
    Array<{ contact_id: string; last_inbound_at: Date | null; engagement_count: bigint }>
  >`
    SELECT
      c.contact_id AS contact_id,
      MAX(m.sent_at) AS last_inbound_at,
      COUNT(*) FILTER (WHERE m.sent_at >= ${thirtyDaysAgo}) AS engagement_count
    FROM messages m
    INNER JOIN conversations c ON c.id = m.conversation_id
    WHERE c.contact_id = ANY(${contactIds}::text[])
      AND m.sender_type = 'contact'
      AND m.is_deleted = false
    GROUP BY c.contact_id
  `;
  const messageById = new Map<
    string,
    { lastInboundAt: number | null; engagementCount: number }
  >();
  for (const row of messageAgg) {
    messageById.set(row.contact_id, {
      lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at).getTime() : null,
      engagementCount: Number(row.engagement_count),
    });
  }

  // Soonest upcoming `scheduled` appointment per contact.
  const appointmentAgg = await prisma.$queryRaw<
    Array<{ contact_id: string; next_at: Date | null }>
  >`
    SELECT contact_id, MIN(appointment_date) AS next_at
    FROM appointments
    WHERE contact_id = ANY(${contactIds}::text[])
      AND status = 'scheduled'
      AND appointment_date >= ${now}
    GROUP BY contact_id
  `;
  const apptById = new Map<string, number | null>();
  for (const row of appointmentAgg) {
    apptById.set(row.contact_id, row.next_at ? new Date(row.next_at).getTime() : null);
  }

  for (const id of contactIds) {
    const msg = messageById.get(id) ?? { lastInboundAt: null, engagementCount: 0 };
    const result = scoreFromInputs(
      {
        lastInboundAt: msg.lastInboundAt,
        inboundLast30d: msg.engagementCount,
        status: statusById.get(id) ?? null,
        nextAppointmentAt: apptById.get(id) ?? null,
        now: nowMs,
      },
      config,
    );
    out.set(id, result);
  }

  return out;
}

// Re-export the DEFAULT for callers who only import from this file.
export { DEFAULT_LEAD_SCORE_CONFIG };
