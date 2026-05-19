import { describe, it, expect } from 'vitest';
import { formatVND, formatCount } from '@/composables/use-kpi';

describe('formatVND', () => {
  it('formats zero', () => {
    expect(formatVND(0)).toBe('0 ₫');
  });

  it('adds Vietnamese thousand separators', () => {
    // Vietnamese locale uses '.' for thousands
    const result = formatVND(1_234_567);
    expect(result).toMatch(/1[., ]234[., ]567 ₫/);
  });

  it('formats large numbers', () => {
    const result = formatVND(100_000_000);
    expect(result).toMatch(/100[., ]000[., ]000 ₫/);
  });

  it('handles negative numbers', () => {
    const result = formatVND(-50_000);
    expect(result).toContain('-');
    expect(result).toContain('₫');
  });
});

describe('formatCount', () => {
  it('formats zero', () => {
    expect(formatCount(0)).toBe('0');
  });

  it('adds Vietnamese thousand separators', () => {
    const result = formatCount(12_345);
    expect(result).toMatch(/12[., ]345/);
  });

  it('does not add currency suffix', () => {
    const result = formatCount(1000);
    expect(result).not.toContain('₫');
  });
});
