/**
 * Unit tests for feature 0016 — preference key + value validation.
 */
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_KEYS,
  VALUE_MAX_CHARS,
  validateKey,
  validateValueSize,
} from '../../src/modules/auth/user-preference-helpers.js';

describe('validateKey', () => {
  it('accepts every key in the allowlist', () => {
    for (const k of ALLOWED_KEYS) {
      expect(validateKey(k)).toBeNull();
    }
  });

  it('rejects empty string', () => {
    expect(validateKey('')).toBe('Key không hợp lệ');
  });

  it.each([
    ['Ui.theme', 'leading uppercase'],
    ['ui.Theme', 'uppercase in segment'],
    ['1ui.theme', 'starts with digit'],
    ['ui..theme', 'double dot'],
    ['.ui.theme', 'leading dot'],
    ['ui.theme.', 'trailing dot'],
    ['ui-theme', 'hyphen not allowed'],
    ['ui theme', 'space not allowed'],
    ['ui.théme', 'unicode not allowed'],
  ])('rejects malformed key: %s (%s)', (key) => {
    expect(validateKey(key)).toBe('Key không hợp lệ');
  });

  it('rejects well-formed but not-in-allowlist keys', () => {
    expect(validateKey('ui.unknown_setting')).toBe('Key không hợp lệ');
    expect(validateKey('analytics.tracked')).toBe('Key không hợp lệ');
  });

  it('rejects non-string input', () => {
    expect(validateKey(undefined)).toBe('Key không hợp lệ');
    expect(validateKey(null)).toBe('Key không hợp lệ');
    expect(validateKey(42)).toBe('Key không hợp lệ');
    expect(validateKey({})).toBe('Key không hợp lệ');
  });
});

describe('validateValueSize', () => {
  it('accepts a short string', () => {
    expect(validateValueSize('dark')).toBeNull();
  });

  it('accepts a small object', () => {
    expect(validateValueSize({ a: 1, b: [2, 3] })).toBeNull();
  });

  it('accepts null', () => {
    expect(validateValueSize(null)).toBeNull();
  });

  it('accepts undefined (coerced to null)', () => {
    expect(validateValueSize(undefined)).toBeNull();
  });

  it('accepts a value at the cap', () => {
    // The wrapping quotes count toward JSON.stringify length, so use cap - 2.
    const s = 'a'.repeat(VALUE_MAX_CHARS - 2);
    expect(validateValueSize(s)).toBeNull();
  });

  it('rejects a value over the cap', () => {
    const s = 'a'.repeat(VALUE_MAX_CHARS + 1);
    const result = validateValueSize(s);
    expect(result).toContain(String(VALUE_MAX_CHARS));
  });

  it('rejects a big object over the cap', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      big[`key_${i}`] = 'value_' + i;
    }
    expect(validateValueSize(big)).not.toBeNull();
  });
});
