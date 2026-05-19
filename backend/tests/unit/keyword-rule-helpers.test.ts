import { describe, it, expect } from 'vitest';
import {
  validateRuleInput,
  matchKeywords,
  shouldUpgradeStatus,
} from '../../src/modules/keyword-rules/keyword-rule-helpers.js';

describe('validateRuleInput', () => {
  const valid = {
    name: 'Hỏi giá',
    keywords: ['bảng giá'],
    addTag: 'hỏi-giá',
  };

  it('accepts minimum valid payload', () => {
    const r = validateRuleInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.enabled).toBe(true);
      expect(r.value.keywords).toEqual(['bảng giá']);
    }
  });

  it('rejects when no action set', () => {
    expect(validateRuleInput({ ...valid, addTag: '' }).ok).toBe(false);
  });

  it('rejects empty keywords', () => {
    expect(validateRuleInput({ ...valid, keywords: [] }).ok).toBe(false);
  });

  it('trims and drops empty keyword strings', () => {
    const r = validateRuleInput({ ...valid, keywords: ['  giá  ', '', '  '] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.keywords).toEqual(['giá']);
  });

  it('rejects non-array keywords', () => {
    expect(validateRuleInput({ ...valid, keywords: 'giá' as any }).ok).toBe(false);
  });

  it('rejects empty name', () => {
    expect(validateRuleInput({ ...valid, name: '' }).ok).toBe(false);
  });

  it('rejects bad setStatus', () => {
    expect(validateRuleInput({ ...valid, setStatus: 'banana' }).ok).toBe(false);
  });

  it('accepts setStatus from enum', () => {
    const r = validateRuleInput({ ...valid, addTag: null, setStatus: 'interested' });
    expect(r.ok).toBe(true);
  });

  it('accepts assignToUserId only (no other action)', () => {
    const r = validateRuleInput({ ...valid, addTag: null, assignToUserId: 'u-1' });
    expect(r.ok).toBe(true);
  });

  it('normalizes addTag whitespace; null when empty', () => {
    const r = validateRuleInput({ ...valid, addTag: '   ' });
    expect(r.ok).toBe(false); // becomes null → no action
  });
});

describe('matchKeywords', () => {
  it('matches case-insensitive substring', () => {
    expect(matchKeywords('Cho em BẢNG GIÁ nhé', ['bảng giá'])).toBe('bảng giá');
  });

  it('returns first match in array order, not content order', () => {
    // Content has both 'giá' and 'bảng giá' substrings.
    // We iterate keywords[] in order — first one that matches wins,
    // regardless of where in the content it appears.
    expect(matchKeywords('cho em xin bảng giá nhé', ['báo giá', 'bảng giá', 'giá'])).toBe('bảng giá');
    // Reordering the keyword array changes which one is returned.
    expect(matchKeywords('cho em xin bảng giá nhé', ['giá', 'bảng giá'])).toBe('giá');
  });

  it('returns null when no keyword matches', () => {
    expect(matchKeywords('chào buổi sáng', ['bảng giá'])).toBeNull();
  });

  it('returns null for null/empty content', () => {
    expect(matchKeywords(null, ['x'])).toBeNull();
    expect(matchKeywords('', ['x'])).toBeNull();
  });

  it('returns null for empty keyword list', () => {
    expect(matchKeywords('hello', [])).toBeNull();
  });
});

describe('shouldUpgradeStatus', () => {
  it.each([
    [null, 'new', true],
    ['new', 'contacted', true],
    ['contacted', 'interested', true],
    ['interested', 'converted', true],
    ['converted', 'interested', false],
    ['interested', 'new', false],
    ['new', 'new', false],
    ['converted', 'converted', false],
    ['lost', 'new', true],
    [undefined, 'interested', true],
  ])('current=%s, target=%s → %s', (current, target, expected) => {
    expect(shouldUpgradeStatus(current as any, target)).toBe(expected);
  });
});
