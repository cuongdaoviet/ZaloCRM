/**
 * Pure helpers for the analytics module — feature 0041.
 * No Prisma, no Fastify; safely unit-testable.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 365;

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Parse + validate a `?dateFrom=&dateTo=` pair. Defaults to the last 30 days
 * when either is missing (matches funnel UX — "show me the current state").
 *
 * Rules:
 *  - Both must be ISO-parseable.
 *  - `from` must be <= `to`.
 *  - Range capped at 365 days to keep aggregate queries predictable.
 */
export function parseDateRange(
  raw: { dateFrom?: string; dateTo?: string },
  now: Date,
): { ok: true; value: DateRange } | { ok: false; error: string } {
  let from: Date;
  let to: Date;

  if (!raw.dateFrom && !raw.dateTo) {
    to = endOfDayUTC(now);
    from = startOfDayUTC(addDays(now, -29));
  } else if (raw.dateFrom && raw.dateTo) {
    const f = new Date(raw.dateFrom);
    const t = new Date(raw.dateTo);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
      return { ok: false, error: 'dateFrom/dateTo phải là ISO date hợp lệ' };
    }
    if (f.getTime() > t.getTime()) {
      return { ok: false, error: 'dateFrom phải <= dateTo' };
    }
    from = f;
    to = t;
  } else {
    return { ok: false, error: 'phải cung cấp cả dateFrom và dateTo' };
  }

  const days = Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);
  if (days > MAX_RANGE_DAYS) {
    return { ok: false, error: `khoảng tối đa ${MAX_RANGE_DAYS} ngày` };
  }

  return { ok: true, value: { from, to } };
}

/**
 * Funnel stages — linear progression. `lost` is an exit branch surfaced
 * separately in the response so the UI can render it as a side note rather
 * than a stage on the funnel chart.
 */
export const FUNNEL_STAGES = ['new', 'contacted', 'interested', 'converted'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelStageRow {
  name: FunnelStage;
  count: number;
  /** Percent of contacts that flowed into this stage from the previous one.
   *  `null` for the first stage and when previous-stage count is 0. */
  conversionRate: number | null;
}

/**
 * Compute next-stage conversion rates from raw stage counts.
 *
 * BR-0003: `rate(i) = count(i) / count(i-1) * 100`, rounded to integer,
 * clamped to [0, 100]. The first stage always reports `null` (no preceding
 * stage to convert from).
 *
 * EC-0001: when previous count is 0 we surface `null` — division is undefined,
 * and "0%" would mislead readers into thinking the stage performed poorly.
 */
export function computeFunnelRates(
  counts: Record<FunnelStage, number>,
): FunnelStageRow[] {
  const rows: FunnelStageRow[] = [];
  let prevCount: number | null = null;
  for (const stage of FUNNEL_STAGES) {
    const count = counts[stage] ?? 0;
    let rate: number | null;
    if (prevCount === null || prevCount === 0) {
      rate = null;
    } else {
      const raw = (count / prevCount) * 100;
      rate = Math.max(0, Math.min(100, Math.round(raw)));
    }
    rows.push({ name: stage, count, conversionRate: rate });
    prevCount = count;
  }
  return rows;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function endOfDayUTC(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  );
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}
