/**
 * lead-score-helpers.ts — Pure scoring + config validation helpers.
 *
 * Split out from lead-score-service.ts so unit tests can import these without
 * triggering the Prisma client module (which requires DATABASE_URL).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecencyBucket {
  /** Upper bound in hours. Last inbound ≤ this many hours scores `points`. */
  hours: number;
  points: number;
}

export interface AppointmentBucket {
  /** Upper bound in days. Soonest upcoming ≤ this many days scores `points`. */
  daysWindow: number;
  points: number;
}

export interface LeadScoreConfig {
  /**
   * Buckets evaluated in order, first match wins. Sorted ascending by `hours`.
   * A contact with no inbound message scores 0 on this component.
   */
  recencyBuckets: RecencyBucket[];
  /** 1 point per inbound message in the last 30 days, capped at this value. */
  engagementCap: number;
  /** Points per pipeline status code. Unknown statuses score 0. */
  statusPoints: Record<string, number>;
  /**
   * Buckets evaluated in order, first match wins. Sorted ascending by
   * `daysWindow`. Only `scheduled` appointments in the future count.
   */
  appointmentBuckets: AppointmentBucket[];
}

export interface LeadScoreBreakdown {
  recency: number;
  engagement: number;
  status: number;
  appointment: number;
}

export interface LeadScoreResult {
  score: number;
  breakdown: LeadScoreBreakdown;
}

// ── Defaults (BR-0001..BR-0004 + BR-0007) ────────────────────────────────────

export const DEFAULT_LEAD_SCORE_CONFIG: LeadScoreConfig = {
  recencyBuckets: [
    { hours: 1, points: 40 },
    { hours: 24, points: 30 },
    { hours: 24 * 7, points: 20 },
    { hours: 24 * 30, points: 10 },
  ],
  engagementCap: 30,
  statusPoints: {
    interested: 20,
    contacted: 10,
    new: 5,
    converted: 0,
    lost: 0,
  },
  appointmentBuckets: [
    { daysWindow: 7, points: 10 },
    { daysWindow: 30, points: 5 },
  ],
};

export const MAX_SCORE = 100;

// ── Config validation (EC-0003) ──────────────────────────────────────────────

export interface ConfigValidationOk {
  ok: true;
  value: LeadScoreConfig;
}
export interface ConfigValidationErr {
  ok: false;
  error: string;
}
export type ConfigValidationResult = ConfigValidationOk | ConfigValidationErr;

/**
 * Validate an unknown JSON payload as a LeadScoreConfig. Used by the PUT
 * endpoint AND defensively by the loader (corrupt DB rows fall back to
 * defaults rather than throwing). Negative weights are rejected (AC-0009).
 */
export function validateLeadScoreConfig(input: unknown): ConfigValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Config phải là một object JSON' };
  }
  const obj = input as Record<string, unknown>;

  // recencyBuckets
  if (!Array.isArray(obj.recencyBuckets) || obj.recencyBuckets.length === 0) {
    return { ok: false, error: 'recencyBuckets phải là mảng không rỗng' };
  }
  const recencyBuckets: RecencyBucket[] = [];
  for (const raw of obj.recencyBuckets) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'Mỗi recency bucket phải là object' };
    }
    const b = raw as Record<string, unknown>;
    if (typeof b.hours !== 'number' || !Number.isFinite(b.hours) || b.hours <= 0) {
      return { ok: false, error: 'recency bucket.hours phải > 0' };
    }
    if (typeof b.points !== 'number' || !Number.isFinite(b.points) || b.points < 0) {
      return { ok: false, error: 'recency bucket.points không được âm' };
    }
    recencyBuckets.push({ hours: b.hours, points: b.points });
  }

  // engagementCap
  if (
    typeof obj.engagementCap !== 'number' ||
    !Number.isFinite(obj.engagementCap) ||
    obj.engagementCap < 0
  ) {
    return { ok: false, error: 'engagementCap không được âm' };
  }

  // statusPoints
  if (
    typeof obj.statusPoints !== 'object' ||
    obj.statusPoints === null ||
    Array.isArray(obj.statusPoints)
  ) {
    return { ok: false, error: 'statusPoints phải là object' };
  }
  const statusPoints: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj.statusPoints as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return { ok: false, error: `statusPoints['${k}'] không được âm` };
    }
    statusPoints[k] = v;
  }

  // appointmentBuckets
  if (!Array.isArray(obj.appointmentBuckets)) {
    return { ok: false, error: 'appointmentBuckets phải là mảng' };
  }
  const appointmentBuckets: AppointmentBucket[] = [];
  for (const raw of obj.appointmentBuckets) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'Mỗi appointment bucket phải là object' };
    }
    const b = raw as Record<string, unknown>;
    if (typeof b.daysWindow !== 'number' || !Number.isFinite(b.daysWindow) || b.daysWindow <= 0) {
      return { ok: false, error: 'appointment bucket.daysWindow phải > 0' };
    }
    if (typeof b.points !== 'number' || !Number.isFinite(b.points) || b.points < 0) {
      return { ok: false, error: 'appointment bucket.points không được âm' };
    }
    appointmentBuckets.push({ daysWindow: b.daysWindow, points: b.points });
  }

  return {
    ok: true,
    value: {
      recencyBuckets: [...recencyBuckets].sort((a, b) => a.hours - b.hours),
      engagementCap: obj.engagementCap,
      statusPoints,
      appointmentBuckets: [...appointmentBuckets].sort((a, b) => a.daysWindow - b.daysWindow),
    },
  };
}

/** Pure helper: parse JSON value → LeadScoreConfig (or defaults if invalid). */
export function resolveLeadScoreConfig(stored: unknown): LeadScoreConfig {
  if (stored === null || stored === undefined) return DEFAULT_LEAD_SCORE_CONFIG;
  const parsed = validateLeadScoreConfig(stored);
  return parsed.ok ? parsed.value : DEFAULT_LEAD_SCORE_CONFIG;
}

// ── Pure scoring (unit-testable) ─────────────────────────────────────────────

export interface ContactScoringInput {
  /** ms since epoch of last inbound message, or null if none. */
  lastInboundAt: number | null;
  /** Count of inbound messages in the last 30 days. */
  inboundLast30d: number;
  /** Pipeline status. Null/missing scores 0. */
  status: string | null;
  /** Soonest upcoming `scheduled` appointment timestamp (ms), or null. */
  nextAppointmentAt: number | null;
  /** "now" timestamp (ms) for deterministic testing. */
  now: number;
}

export function computeRecencyPoints(
  lastInboundAt: number | null,
  now: number,
  config: LeadScoreConfig,
): number {
  if (lastInboundAt === null) return 0;
  const ageHours = (now - lastInboundAt) / (1000 * 60 * 60);
  if (ageHours < 0) return config.recencyBuckets[0]?.points ?? 0;
  for (const bucket of config.recencyBuckets) {
    if (ageHours <= bucket.hours) return bucket.points;
  }
  return 0;
}

export function computeEngagementPoints(count: number, config: LeadScoreConfig): number {
  if (count <= 0) return 0;
  return Math.min(count, config.engagementCap);
}

export function computeStatusPoints(
  status: string | null,
  config: LeadScoreConfig,
): number {
  if (!status) return 0;
  return config.statusPoints[status] ?? 0;
}

export function computeAppointmentPoints(
  nextAppointmentAt: number | null,
  now: number,
  config: LeadScoreConfig,
): number {
  if (nextAppointmentAt === null || nextAppointmentAt < now) return 0;
  const daysAhead = (nextAppointmentAt - now) / (1000 * 60 * 60 * 24);
  for (const bucket of config.appointmentBuckets) {
    if (daysAhead <= bucket.daysWindow) return bucket.points;
  }
  return 0;
}

export function scoreFromInputs(
  input: ContactScoringInput,
  config: LeadScoreConfig,
): LeadScoreResult {
  const recency = computeRecencyPoints(input.lastInboundAt, input.now, config);
  const engagement = computeEngagementPoints(input.inboundLast30d, config);
  const status = computeStatusPoints(input.status, config);
  const appointment = computeAppointmentPoints(input.nextAppointmentAt, input.now, config);
  const raw = recency + engagement + status + appointment;
  // BR-0005: cap at MAX_SCORE.
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(raw)));
  return {
    score,
    breakdown: { recency, engagement, status, appointment },
  };
}

// ── Display helper (shared with FE via API response shape) ───────────────────

export type LeadScoreBand = 'hot' | 'warm' | 'normal' | 'cold';

/** Score band per BR-0011. */
export function bandForScore(score: number): LeadScoreBand {
  if (score >= 80) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 20) return 'normal';
  return 'cold';
}
