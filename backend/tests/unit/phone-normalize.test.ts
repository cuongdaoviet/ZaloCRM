import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../../src/modules/contacts/phone-normalize.js';

describe('normalizePhone (BR-0001)', () => {
  it('strips whitespace, dashes, dots, parens', () => {
    expect(normalizePhone(' 84 901-234.567 ')).toBe('84901234567');
    expect(normalizePhone('(84) 901 234 567')).toBe('84901234567');
  });

  it('converts 0-prefix 10-digit to 84-prefix', () => {
    expect(normalizePhone('0901234567')).toBe('84901234567');
  });

  it('drops the + sign on +84 numbers', () => {
    expect(normalizePhone('+84901234567')).toBe('84901234567');
    expect(normalizePhone('+84 901 234 567')).toBe('84901234567');
  });

  it('keeps already-84-prefixed strings', () => {
    expect(normalizePhone('84901234567')).toBe('84901234567');
  });

  it('returns null for non-digit gunk', () => {
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('090abc1234')).toBeNull();
  });

  it('returns null when result < 9 digits', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('00000')).toBeNull();
    expect(normalizePhone('+')).toBeNull();
  });

  it('returns null for empty / whitespace / nullish input', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('()')).toBeNull();
  });

  it('two different formats of the same number normalize to the same value', () => {
    const a = normalizePhone('0901234567');
    const b = normalizePhone('+84 901-234-567');
    const c = normalizePhone('84901234567');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('84901234567');
  });
});
