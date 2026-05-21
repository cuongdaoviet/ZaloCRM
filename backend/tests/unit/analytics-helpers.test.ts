/**
 * Unit tests for analytics-helpers — feature 0041.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDateRange,
  computeFunnelRates,
  FUNNEL_STAGES,
} from '../../src/modules/analytics/analytics-helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('parseDateRange', () => {
  it('defaults to last 30 days when no dates supplied', () => {
    const r = parseDateRange({}, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const days = Math.round(
        (r.value.to.getTime() - r.value.from.getTime()) / (24 * 60 * 60 * 1000),
      );
      expect(days).toBe(30);
    }
  });

  it('accepts a custom range', () => {
    const r = parseDateRange({ dateFrom: '2026-05-01', dateTo: '2026-05-31' }, NOW);
    expect(r.ok).toBe(true);
  });

  it('rejects malformed dates', () => {
    const r = parseDateRange({ dateFrom: 'banana', dateTo: '2026-05-31' }, NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects from > to', () => {
    const r = parseDateRange({ dateFrom: '2026-05-31', dateTo: '2026-05-01' }, NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects partial input (dateFrom without dateTo)', () => {
    const r = parseDateRange({ dateFrom: '2026-05-01' }, NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects ranges over 365 days', () => {
    const r = parseDateRange(
      { dateFrom: '2024-01-01', dateTo: '2026-01-01' },
      NOW,
    );
    expect(r.ok).toBe(false);
  });
});

describe('computeFunnelRates', () => {
  it('first stage always has null rate', () => {
    const rows = computeFunnelRates({ new: 100, contacted: 50, interested: 25, converted: 10 });
    expect(rows[0].name).toBe('new');
    expect(rows[0].conversionRate).toBeNull();
  });

  it('computes next-stage rates correctly', () => {
    const rows = computeFunnelRates({ new: 100, contacted: 50, interested: 25, converted: 5 });
    // 50/100 = 50, 25/50 = 50, 5/25 = 20
    expect(rows[1].conversionRate).toBe(50);
    expect(rows[2].conversionRate).toBe(50);
    expect(rows[3].conversionRate).toBe(20);
  });

  it('returns rate=null when previous stage is 0 (EC-0001)', () => {
    const rows = computeFunnelRates({ new: 0, contacted: 0, interested: 5, converted: 1 });
    expect(rows[1].conversionRate).toBeNull();
    expect(rows[2].conversionRate).toBeNull();
    // interested>0, so converted rate computes against it
    expect(rows[3].conversionRate).toBe(20);
  });

  it('clamps rate at 100 if downstream stage somehow exceeds previous', () => {
    // Snapshot view can produce this when contacts move forward at different rates
    const rows = computeFunnelRates({ new: 10, contacted: 50, interested: 10, converted: 1 });
    expect(rows[1].conversionRate).toBe(100);
  });

  it('always returns 4 stages in the expected order', () => {
    const rows = computeFunnelRates({ new: 1, contacted: 1, interested: 1, converted: 1 });
    expect(rows.map((r) => r.name)).toEqual([...FUNNEL_STAGES]);
  });
});
