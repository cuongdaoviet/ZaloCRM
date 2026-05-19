/**
 * Pure helpers for the KPI module: date range resolution and percent delta.
 * No Prisma, no Fastify — easy to unit-test.
 */

export type Period =
  | 'today'
  | 'yesterday'
  | 'last7days'
  | 'last30days'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';

export const VALID_PERIODS: ReadonlySet<Period> = new Set<Period>([
  'today',
  'yesterday',
  'last7days',
  'last30days',
  'thisMonth',
  'lastMonth',
  'custom',
]);

export const VALID_METRICS = new Set([
  'messagesSent',
  'revenue',
  'ordersCount',
  'newContacts',
]);

const MAX_RANGE_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DateRange {
  from: Date;
  to: Date;
  label: string;
  previous: { from: Date; to: Date };
}

export interface ResolveInput {
  period?: string;
  from?: string;
  to?: string;
}

/**
 * Convert a period preset (or a custom from/to pair) into concrete UTC dates,
 * plus the matching previous range of the same length for trend comparison.
 */
export function resolveDateRange(
  input: ResolveInput,
  now: Date,
): { ok: true; value: DateRange } | { ok: false; error: string } {
  const period = (input.period ?? 'last7days') as Period;
  if (!VALID_PERIODS.has(period)) {
    return { ok: false, error: `period không hợp lệ: ${period}` };
  }

  let from: Date;
  let to: Date;
  let label: string;

  if (period === 'custom') {
    if (!input.from || !input.to) {
      return { ok: false, error: 'custom yêu cầu from và to' };
    }
    const f = new Date(input.from);
    const t = new Date(input.to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
      return { ok: false, error: 'from/to phải là ISO date hợp lệ' };
    }
    if (f.getTime() > t.getTime()) {
      return { ok: false, error: 'from phải <= to' };
    }
    const days = Math.ceil((t.getTime() - f.getTime()) / MS_PER_DAY);
    if (days > MAX_RANGE_DAYS) {
      return { ok: false, error: `khoảng tối đa ${MAX_RANGE_DAYS} ngày` };
    }
    from = f;
    to = t;
    label = `${f.toISOString().slice(0, 10)} → ${t.toISOString().slice(0, 10)}`;
  } else {
    const resolved = resolvePreset(period, now);
    from = resolved.from;
    to = resolved.to;
    label = resolved.label;
  }

  // Previous range = same length, immediately preceding `from`.
  const span = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - span);

  return {
    ok: true,
    value: { from, to, label, previous: { from: prevFrom, to: prevTo } },
  };
}

function resolvePreset(
  period: Exclude<Period, 'custom'>,
  now: Date,
): { from: Date; to: Date; label: string } {
  switch (period) {
    case 'today': {
      const from = startOfDayUTC(now);
      const to = endOfDayUTC(now);
      return { from, to, label: 'Hôm nay' };
    }
    case 'yesterday': {
      const y = addDays(now, -1);
      return { from: startOfDayUTC(y), to: endOfDayUTC(y), label: 'Hôm qua' };
    }
    case 'last7days': {
      const from = startOfDayUTC(addDays(now, -6));
      const to = endOfDayUTC(now);
      return { from, to, label: '7 ngày qua' };
    }
    case 'last30days': {
      const from = startOfDayUTC(addDays(now, -29));
      const to = endOfDayUTC(now);
      return { from, to, label: '30 ngày qua' };
    }
    case 'thisMonth': {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const to = endOfDayUTC(now);
      return { from, to, label: 'Tháng này' };
    }
    case 'lastMonth': {
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const from = new Date(Date.UTC(year, month - 1, 1));
      // Day 0 of `month` = last day of previous month
      const to = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
      return { from, to, label: 'Tháng trước' };
    }
  }
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

/**
 * Percent change from `previous` to `current`. Returns `null` when previous
 * is 0 (the change is undefined / infinite — the frontend renders "—").
 * Otherwise returns a number rounded to one decimal.
 */
export function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
