/**
 * Frontend unit tests for use-lead-score helpers.
 *
 * Covers AC-0011 — badge color matches score band per BR-0011.
 */
import { describe, it, expect } from 'vitest';
import { bandForScore, bandMeta } from '@/composables/use-lead-score';

describe('bandForScore (BR-0011)', () => {
  it('80-100 → hot (red)', () => {
    expect(bandForScore(80)).toBe('hot');
    expect(bandForScore(100)).toBe('hot');
    expect(bandMeta.hot.color).toBe('red');
    expect(bandMeta.hot.label).toBe('Nóng');
  });

  it('50-79 → warm (orange)', () => {
    expect(bandForScore(50)).toBe('warm');
    expect(bandForScore(79)).toBe('warm');
    expect(bandMeta.warm.color).toBe('orange');
    expect(bandMeta.warm.label).toBe('Ấm');
  });

  it('20-49 → normal (amber)', () => {
    expect(bandForScore(20)).toBe('normal');
    expect(bandForScore(49)).toBe('normal');
    expect(bandMeta.normal.color).toBe('amber');
    expect(bandMeta.normal.label).toBe('Bình thường');
  });

  it('0-19 → cold (grey)', () => {
    expect(bandForScore(0)).toBe('cold');
    expect(bandForScore(19)).toBe('cold');
    expect(bandMeta.cold.color).toBe('grey');
    expect(bandMeta.cold.label).toBe('Nguội');
  });

  it('AC-0011: each band has distinct color', () => {
    const colors = new Set([
      bandMeta.hot.color,
      bandMeta.warm.color,
      bandMeta.normal.color,
      bandMeta.cold.color,
    ]);
    expect(colors.size).toBe(4);
  });
});
