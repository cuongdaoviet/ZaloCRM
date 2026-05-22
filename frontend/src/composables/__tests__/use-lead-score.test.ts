/**
 * Frontend unit tests for use-lead-score helpers.
 *
 * Covers AC-0011 — badge color matches score band per BR-0011.
 */
import { describe, it, expect } from 'vitest';
import { bandForScore, bandMeta } from '@/composables/use-lead-score';

describe('bandForScore (BR-0011)', () => {
  // Feature 0049 F10 — palette pulled apart for visual distinctness.
  // The bucket cutoffs (80/50/20/0) and labels are unchanged; only the
  // Vuetify color tokens were re-tuned so the bands read distinct.
  it('80-100 → hot (red)', () => {
    expect(bandForScore(80)).toBe('hot');
    expect(bandForScore(100)).toBe('hot');
    expect(bandMeta.hot.color).toBe('red-darken-2');
    expect(bandMeta.hot.label).toBe('Nóng');
  });

  it('50-79 → warm (orange)', () => {
    expect(bandForScore(50)).toBe('warm');
    expect(bandForScore(79)).toBe('warm');
    expect(bandMeta.warm.color).toBe('orange-darken-1');
    expect(bandMeta.warm.label).toBe('Ấm');
  });

  it('20-49 → normal (blue-grey)', () => {
    expect(bandForScore(20)).toBe('normal');
    expect(bandForScore(49)).toBe('normal');
    expect(bandMeta.normal.color).toBe('blue-grey-lighten-1');
    expect(bandMeta.normal.label).toBe('Bình thường');
  });

  it('0-19 → cold (grey)', () => {
    expect(bandForScore(0)).toBe('cold');
    expect(bandForScore(19)).toBe('cold');
    expect(bandMeta.cold.color).toBe('grey-lighten-1');
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
