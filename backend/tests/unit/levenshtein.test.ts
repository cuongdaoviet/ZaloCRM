import { describe, it, expect } from 'vitest';
import { levenshtein } from '../../src/modules/contacts/levenshtein.js';

describe('levenshtein (capped)', () => {
  it('identical strings → 0', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
  });

  it('one substitution → 1', () => {
    expect(levenshtein('kitten', 'kitten')).toBe(0);
    expect(levenshtein('hello', 'jello')).toBe(1);
  });

  it('classic kitten/sitting → 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('insertion at end → 1', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
  });

  it('deletion → 1', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  it('returns cap+1 instead of full distance when over cap', () => {
    expect(levenshtein('abcdefgh', 'zzzzzzzz', 3)).toBe(4);
  });

  it('respects length-difference short-circuit', () => {
    // a and b differ in length by 4 — cap is 2 → must return 3 (cap+1)
    expect(levenshtein('abc', 'abcdefg', 2)).toBe(3);
  });

  it('symmetric', () => {
    expect(levenshtein('nguyen', 'nguyne')).toBe(levenshtein('nguyne', 'nguyen'));
  });

  it('Vietnamese-normalized fuzzy pairs (typo) → ≤ 2', () => {
    // "Nguyễn Văn A" vs "Nguyen Van A" after BR-0002 → "nguyen van a"
    expect(levenshtein('nguyen van a', 'nguyen van a')).toBe(0);
    // Typo: extra space removed → 1-char swap
    expect(levenshtein('nguyen van a', 'nguyen van b')).toBe(1);
  });

  it('cap=0 means only equality returns 0', () => {
    expect(levenshtein('abc', 'abc', 0)).toBe(0);
    expect(levenshtein('abc', 'abd', 0)).toBe(1);
  });
});
