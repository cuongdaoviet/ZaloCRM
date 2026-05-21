/**
 * Unit tests for lead-score-service pure scoring helpers + config validator.
 * No DB — these are the formula / validation primitives.
 *
 * Covers BR-0001..BR-0005, BR-0007, BR-0011, EC-0001..EC-0003.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LEAD_SCORE_CONFIG,
  bandForScore,
  computeAppointmentPoints,
  computeEngagementPoints,
  computeRecencyPoints,
  computeStatusPoints,
  resolveLeadScoreConfig,
  scoreFromInputs,
  validateLeadScoreConfig,
} from '../../src/modules/contacts/lead-score-helpers.js';

const NOW_MS = new Date('2026-05-21T12:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('computeRecencyPoints (BR-0001)', () => {
  const c = DEFAULT_LEAD_SCORE_CONFIG;

  it('no inbound → 0', () => {
    expect(computeRecencyPoints(null, NOW_MS, c)).toBe(0);
  });

  it('inbound 30 minutes ago → 40 (≤ 1h bucket)', () => {
    expect(computeRecencyPoints(NOW_MS - 30 * 60 * 1000, NOW_MS, c)).toBe(40);
  });

  it('inbound 12 hours ago → 30 (≤ 24h bucket)', () => {
    expect(computeRecencyPoints(NOW_MS - 12 * HOUR, NOW_MS, c)).toBe(30);
  });

  it('inbound 3 days ago → 20 (≤ 7d bucket)', () => {
    expect(computeRecencyPoints(NOW_MS - 3 * DAY, NOW_MS, c)).toBe(20);
  });

  it('inbound 15 days ago → 10 (≤ 30d bucket)', () => {
    expect(computeRecencyPoints(NOW_MS - 15 * DAY, NOW_MS, c)).toBe(10);
  });

  it('inbound 60 days ago → 0 (past last bucket)', () => {
    expect(computeRecencyPoints(NOW_MS - 60 * DAY, NOW_MS, c)).toBe(0);
  });

  it('exactly on boundary uses inclusive ≤', () => {
    expect(computeRecencyPoints(NOW_MS - 1 * HOUR, NOW_MS, c)).toBe(40);
    expect(computeRecencyPoints(NOW_MS - 24 * HOUR, NOW_MS, c)).toBe(30);
  });
});

describe('computeEngagementPoints (BR-0002)', () => {
  it('0 inbound → 0', () => {
    expect(computeEngagementPoints(0, DEFAULT_LEAD_SCORE_CONFIG)).toBe(0);
  });
  it('5 inbound → 5 (1 point each)', () => {
    expect(computeEngagementPoints(5, DEFAULT_LEAD_SCORE_CONFIG)).toBe(5);
  });
  it('caps at engagementCap=30', () => {
    expect(computeEngagementPoints(50, DEFAULT_LEAD_SCORE_CONFIG)).toBe(30);
  });
  it('negative count guarded → 0', () => {
    expect(computeEngagementPoints(-3, DEFAULT_LEAD_SCORE_CONFIG)).toBe(0);
  });
});

describe('computeStatusPoints (BR-0003)', () => {
  const c = DEFAULT_LEAD_SCORE_CONFIG;

  it('interested → 20', () => {
    expect(computeStatusPoints('interested', c)).toBe(20);
  });
  it('contacted → 10', () => {
    expect(computeStatusPoints('contacted', c)).toBe(10);
  });
  it('new → 5', () => {
    expect(computeStatusPoints('new', c)).toBe(5);
  });
  it('converted → 0 (AC-0005)', () => {
    expect(computeStatusPoints('converted', c)).toBe(0);
  });
  it('lost → 0', () => {
    expect(computeStatusPoints('lost', c)).toBe(0);
  });
  it('null status → 0', () => {
    expect(computeStatusPoints(null, c)).toBe(0);
  });
  it('unknown status → 0', () => {
    expect(computeStatusPoints('xyz', c)).toBe(0);
  });
});

describe('computeAppointmentPoints (BR-0004)', () => {
  const c = DEFAULT_LEAD_SCORE_CONFIG;

  it('no appointment → 0', () => {
    expect(computeAppointmentPoints(null, NOW_MS, c)).toBe(0);
  });
  it('appointment 3 days away → 10', () => {
    expect(computeAppointmentPoints(NOW_MS + 3 * DAY, NOW_MS, c)).toBe(10);
  });
  it('appointment 7 days away (boundary) → 10', () => {
    expect(computeAppointmentPoints(NOW_MS + 7 * DAY, NOW_MS, c)).toBe(10);
  });
  it('appointment 15 days away → 5', () => {
    expect(computeAppointmentPoints(NOW_MS + 15 * DAY, NOW_MS, c)).toBe(5);
  });
  it('appointment 45 days away → 0', () => {
    expect(computeAppointmentPoints(NOW_MS + 45 * DAY, NOW_MS, c)).toBe(0);
  });
  it('past appointment → 0', () => {
    expect(computeAppointmentPoints(NOW_MS - DAY, NOW_MS, c)).toBe(0);
  });
});

describe('scoreFromInputs (composition + BR-0005 cap)', () => {
  it('AC-0004: 1h inbound + 5 engagement + interested + 3d appt = 75', () => {
    const r = scoreFromInputs(
      {
        lastInboundAt: NOW_MS - 30 * 60 * 1000,
        inboundLast30d: 5,
        status: 'interested',
        nextAppointmentAt: NOW_MS + 3 * DAY,
        now: NOW_MS,
      },
      DEFAULT_LEAD_SCORE_CONFIG,
    );
    expect(r.breakdown).toEqual({
      recency: 40,
      engagement: 5,
      status: 20,
      appointment: 10,
    });
    expect(r.score).toBe(75);
  });

  it('caps at 100', () => {
    const r = scoreFromInputs(
      {
        lastInboundAt: NOW_MS - 5 * 60 * 1000,
        inboundLast30d: 50, // capped at 30
        status: 'interested',
        nextAppointmentAt: NOW_MS + DAY,
        now: NOW_MS,
      },
      DEFAULT_LEAD_SCORE_CONFIG,
    );
    expect(r.score).toBe(100);
    expect(r.breakdown.engagement).toBe(30);
  });

  it('EC-0001: new contact with no inbound → status=5 only', () => {
    const r = scoreFromInputs(
      {
        lastInboundAt: null,
        inboundLast30d: 0,
        status: 'new',
        nextAppointmentAt: null,
        now: NOW_MS,
      },
      DEFAULT_LEAD_SCORE_CONFIG,
    );
    expect(r.score).toBe(5);
  });

  it('converted contact w/ recent activity still scores 0 on status', () => {
    const r = scoreFromInputs(
      {
        lastInboundAt: NOW_MS - 30 * 60 * 1000,
        inboundLast30d: 10,
        status: 'converted',
        nextAppointmentAt: NOW_MS + 2 * DAY,
        now: NOW_MS,
      },
      DEFAULT_LEAD_SCORE_CONFIG,
    );
    expect(r.breakdown.status).toBe(0);
    expect(r.score).toBe(40 + 10 + 0 + 10);
  });
});

describe('validateLeadScoreConfig (EC-0003)', () => {
  it('accepts the default config', () => {
    const r = validateLeadScoreConfig(DEFAULT_LEAD_SCORE_CONFIG);
    expect(r.ok).toBe(true);
  });

  it('AC-0009: rejects negative recency points', () => {
    const r = validateLeadScoreConfig({
      ...DEFAULT_LEAD_SCORE_CONFIG,
      recencyBuckets: [{ hours: 1, points: -5 }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects negative engagementCap', () => {
    const r = validateLeadScoreConfig({
      ...DEFAULT_LEAD_SCORE_CONFIG,
      engagementCap: -1,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects negative status points', () => {
    const r = validateLeadScoreConfig({
      ...DEFAULT_LEAD_SCORE_CONFIG,
      statusPoints: { interested: -3 },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects empty recencyBuckets', () => {
    const r = validateLeadScoreConfig({
      ...DEFAULT_LEAD_SCORE_CONFIG,
      recencyBuckets: [],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects null / non-object', () => {
    expect(validateLeadScoreConfig(null).ok).toBe(false);
    expect(validateLeadScoreConfig('hi').ok).toBe(false);
    expect(validateLeadScoreConfig([]).ok).toBe(false);
  });

  it('sorts buckets ascending on success', () => {
    const r = validateLeadScoreConfig({
      recencyBuckets: [
        { hours: 24, points: 30 },
        { hours: 1, points: 40 },
      ],
      engagementCap: 30,
      statusPoints: { interested: 20 },
      appointmentBuckets: [
        { daysWindow: 30, points: 5 },
        { daysWindow: 7, points: 10 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recencyBuckets.map((b) => b.hours)).toEqual([1, 24]);
      expect(r.value.appointmentBuckets.map((b) => b.daysWindow)).toEqual([7, 30]);
    }
  });
});

describe('resolveLeadScoreConfig (BR-0007 + EC-0003)', () => {
  it('null stored → defaults', () => {
    expect(resolveLeadScoreConfig(null)).toEqual(DEFAULT_LEAD_SCORE_CONFIG);
  });
  it('undefined stored → defaults', () => {
    expect(resolveLeadScoreConfig(undefined)).toEqual(DEFAULT_LEAD_SCORE_CONFIG);
  });
  it('invalid stored (corrupt DB row) → defaults', () => {
    expect(resolveLeadScoreConfig({ recencyBuckets: 'oops' })).toEqual(
      DEFAULT_LEAD_SCORE_CONFIG,
    );
  });
});

describe('bandForScore (BR-0011)', () => {
  it('80-100 → hot', () => {
    expect(bandForScore(100)).toBe('hot');
    expect(bandForScore(85)).toBe('hot');
    expect(bandForScore(80)).toBe('hot');
  });
  it('50-79 → warm', () => {
    expect(bandForScore(79)).toBe('warm');
    expect(bandForScore(50)).toBe('warm');
  });
  it('20-49 → normal', () => {
    expect(bandForScore(49)).toBe('normal');
    expect(bandForScore(20)).toBe('normal');
  });
  it('0-19 → cold', () => {
    expect(bandForScore(19)).toBe('cold');
    expect(bandForScore(0)).toBe('cold');
  });
});
