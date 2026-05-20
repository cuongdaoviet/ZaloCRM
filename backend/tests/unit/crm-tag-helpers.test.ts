/**
 * Pure-function unit tests for feature 0019 — CRM tag helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  validateColor,
  validateTagName,
} from '../../src/modules/crm-tags/crm-tag-helpers.js';

describe('normalizeName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeName('  VIP  ')).toBe('vip');
  });

  it('lowercases the entire string', () => {
    expect(normalizeName('VIP')).toBe('vip');
    expect(normalizeName('Vip')).toBe('vip');
    expect(normalizeName('vIp')).toBe('vip');
  });

  it('collapses display-vs-normalized for the case-collision test', () => {
    expect(normalizeName('VIP')).toBe(normalizeName('vip'));
    expect(normalizeName(' VIP ')).toBe(normalizeName('vip'));
  });

  it('preserves internal spaces — caller decides on spacing semantics', () => {
    expect(normalizeName('Khách VIP')).toBe('khách vip');
  });

  it('NFC-normalizes combining sequences before lowercasing', () => {
    // "é" can be one codepoint (U+00E9) OR e + U+0301.
    const composed = 'Café';
    const decomposed = 'Café';
    expect(normalizeName(composed)).toBe(normalizeName(decomposed));
  });
});

describe('validateColor', () => {
  it('accepts #RRGGBB hex (upper and lower case)', () => {
    expect(validateColor('#9E9E9E')).toBe(true);
    expect(validateColor('#9e9e9e')).toBe(true);
    expect(validateColor('#000000')).toBe(true);
    expect(validateColor('#FFFFFF')).toBe(true);
  });

  it('rejects #RGB shorthand', () => {
    expect(validateColor('#FFF')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(validateColor('#XYZ123')).toBe(false);
    expect(validateColor('#12345')).toBe(false);
    expect(validateColor('#1234567')).toBe(false);
    expect(validateColor('FFFFFF')).toBe(false);
    expect(validateColor('rgb(0,0,0)')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(validateColor(undefined as unknown as string)).toBe(false);
    expect(validateColor(null as unknown as string)).toBe(false);
    expect(validateColor(123 as unknown as string)).toBe(false);
  });
});

describe('validateTagName', () => {
  it('accepts a normal name and returns display + normalized', () => {
    const r = validateTagName('VIP');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.display).toBe('VIP');
      expect(r.normalized).toBe('vip');
    }
  });

  it('trims surrounding whitespace from the display value', () => {
    const r = validateTagName('  VIP  ');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.display).toBe('VIP');
      expect(r.normalized).toBe('vip');
    }
  });

  it('rejects empty string', () => {
    const r = validateTagName('');
    expect(r.ok).toBe(false);
  });

  it('rejects whitespace-only', () => {
    const r = validateTagName('     ');
    expect(r.ok).toBe(false);
  });

  it('rejects names longer than 50 characters', () => {
    const r = validateTagName('x'.repeat(51));
    expect(r.ok).toBe(false);
  });

  it('accepts exactly 50 characters', () => {
    const r = validateTagName('x'.repeat(50));
    expect(r.ok).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(validateTagName(undefined as unknown as string).ok).toBe(false);
    expect(validateTagName(null as unknown as string).ok).toBe(false);
    expect(validateTagName(42 as unknown as string).ok).toBe(false);
    expect(validateTagName({} as unknown as string).ok).toBe(false);
  });
});
