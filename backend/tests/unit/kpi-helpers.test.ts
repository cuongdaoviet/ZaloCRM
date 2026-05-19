import { describe, it, expect } from 'vitest';
import {
  resolveDateRange,
  percentDelta,
} from '../../src/modules/kpi/kpi-helpers.js';

const FIXED_NOW = new Date(Date.UTC(2026, 2, 15, 10, 30, 0)); // 2026-03-15 10:30 UTC

describe('resolveDateRange', () => {
  it('rejects unknown period', () => {
    const r = resolveDateRange({ period: 'forever' }, FIXED_NOW);
    expect(r.ok).toBe(false);
  });

  it('today: from start-of-day to end-of-day in UTC', () => {
    const r = resolveDateRange({ period: 'today' }, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.toISOString()).toBe('2026-03-15T00:00:00.000Z');
      expect(r.value.to.toISOString()).toBe('2026-03-15T23:59:59.999Z');
      expect(r.value.label).toBe('Hôm nay');
    }
  });

  it('yesterday: full prior day', () => {
    const r = resolveDateRange({ period: 'yesterday' }, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.toISOString()).toBe('2026-03-14T00:00:00.000Z');
      expect(r.value.to.toISOString()).toBe('2026-03-14T23:59:59.999Z');
    }
  });

  it('last7days spans 7 inclusive days ending today', () => {
    const r = resolveDateRange({ period: 'last7days' }, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 2026-03-09 .. 2026-03-15
      expect(r.value.from.toISOString().slice(0, 10)).toBe('2026-03-09');
      expect(r.value.to.toISOString().slice(0, 10)).toBe('2026-03-15');
    }
  });

  it('last30days spans 30 inclusive days', () => {
    const r = resolveDateRange({ period: 'last30days' }, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.toISOString().slice(0, 10)).toBe('2026-02-14');
    }
  });

  it('thisMonth: from day 1 of current month', () => {
    const r = resolveDateRange({ period: 'thisMonth' }, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.toISOString().slice(0, 10)).toBe('2026-03-01');
    }
  });

  it('lastMonth: covers Feb fully', () => {
    const r = resolveDateRange({ period: 'lastMonth' }, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.toISOString().slice(0, 10)).toBe('2026-02-01');
      expect(r.value.to.toISOString().slice(0, 10)).toBe('2026-02-28');
    }
  });

  it('lastMonth handles January → previous December', () => {
    const jan = new Date(Date.UTC(2026, 0, 10));
    const r = resolveDateRange({ period: 'lastMonth' }, jan);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.toISOString().slice(0, 10)).toBe('2025-12-01');
      expect(r.value.to.toISOString().slice(0, 10)).toBe('2025-12-31');
    }
  });

  it('custom needs both from and to', () => {
    expect(resolveDateRange({ period: 'custom', from: '2026-01-01' }, FIXED_NOW).ok).toBe(false);
    expect(resolveDateRange({ period: 'custom', to: '2026-01-01' }, FIXED_NOW).ok).toBe(false);
  });

  it('custom rejects bad date strings', () => {
    const r = resolveDateRange(
      { period: 'custom', from: 'nope', to: '2026-01-01' },
      FIXED_NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('custom rejects from > to', () => {
    const r = resolveDateRange(
      { period: 'custom', from: '2026-02-01', to: '2026-01-01' },
      FIXED_NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('custom rejects range > 365 days', () => {
    const r = resolveDateRange(
      { period: 'custom', from: '2024-01-01', to: '2026-01-01' },
      FIXED_NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('custom one-day range is valid', () => {
    const r = resolveDateRange(
      { period: 'custom', from: '2026-01-15', to: '2026-01-15' },
      FIXED_NOW,
    );
    expect(r.ok).toBe(true);
  });

  it('previous range immediately precedes current and matches span', () => {
    const r = resolveDateRange({ period: 'last7days' }, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const span = r.value.to.getTime() - r.value.from.getTime();
      const prevSpan = r.value.previous.to.getTime() - r.value.previous.from.getTime();
      // They should be within 1ms (we subtract 1ms for the inclusive boundary)
      expect(Math.abs(span - prevSpan)).toBeLessThanOrEqual(1);
      // previous.to is exactly 1ms before current.from
      expect(r.value.previous.to.getTime()).toBe(r.value.from.getTime() - 1);
    }
  });

  it('default period is last7days when nothing is passed', () => {
    const r = resolveDateRange({}, FIXED_NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.label).toBe('7 ngày qua');
  });
});

describe('percentDelta', () => {
  it('returns null when previous is 0', () => {
    expect(percentDelta(100, 0)).toBeNull();
    expect(percentDelta(0, 0)).toBeNull();
  });

  it('returns 0 for no change', () => {
    expect(percentDelta(100, 100)).toBe(0);
  });

  it('rounds to one decimal', () => {
    expect(percentDelta(123, 100)).toBe(23);
    expect(percentDelta(133, 100)).toBe(33);
    expect(percentDelta(112, 100)).toBe(12);
  });

  it('handles negative delta', () => {
    expect(percentDelta(80, 100)).toBe(-20);
  });

  it('handles current=0 with non-zero previous', () => {
    expect(percentDelta(0, 100)).toBe(-100);
  });
});
