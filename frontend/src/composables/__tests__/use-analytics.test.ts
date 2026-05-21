import { describe, it, expect } from 'vitest';
import {
  formatCount,
  formatMinutes,
  formatRate,
  extractError,
} from '@/composables/use-analytics';

describe('formatCount', () => {
  it('formats zero', () => {
    expect(formatCount(0)).toBe('0');
  });

  it('adds Vietnamese thousand separators', () => {
    expect(formatCount(12_345)).toMatch(/12[., ]345/);
  });
});

describe('formatMinutes', () => {
  it('returns dash for null', () => {
    expect(formatMinutes(null)).toBe('—');
  });

  it('returns < 1 for sub-minute values', () => {
    expect(formatMinutes(0.4)).toBe('< 1');
  });

  it('formats whole minutes', () => {
    expect(formatMinutes(15)).toMatch(/15/);
  });

  it('preserves one decimal place', () => {
    expect(formatMinutes(12.4)).toMatch(/12[.,]4/);
  });
});

describe('formatRate', () => {
  it('returns dash for null (first stage / undefined division)', () => {
    expect(formatRate(null)).toBe('—');
  });

  it('renders integer percent suffix', () => {
    expect(formatRate(63)).toBe('63%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(100)).toBe('100%');
  });
});

describe('extractError', () => {
  it('reads axios-style response error', () => {
    const e = { response: { data: { error: 'không có quyền' } } };
    expect(extractError(e)).toBe('không có quyền');
  });

  it('falls back to message', () => {
    expect(extractError(new Error('boom'))).toBe('boom');
  });

  it('default fallback for unknown shape', () => {
    expect(extractError(null)).toBe('Đã xảy ra lỗi');
    expect(extractError('string')).toBe('Đã xảy ra lỗi');
  });
});
