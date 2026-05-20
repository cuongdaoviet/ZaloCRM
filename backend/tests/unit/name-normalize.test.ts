import { describe, it, expect } from 'vitest';
import { normalizeName } from '../../src/modules/contacts/name-normalize.js';

describe('normalizeName (BR-0002)', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Nguyen VAN A  ')).toBe('nguyen van a');
  });

  it('strips Vietnamese diacritics', () => {
    expect(normalizeName('Nguyễn Văn Á')).toBe('nguyen van a');
    expect(normalizeName('Trần Thị Hồng')).toBe('tran thi hong');
    expect(normalizeName('Lê Đức Anh')).toBe('le duc anh');
  });

  it('maps đ/Đ to d', () => {
    expect(normalizeName('Đinh Văn Đông')).toBe('dinh van dong');
    expect(normalizeName('đặng')).toBe('dang');
    expect(normalizeName('Đặng Đức')).toBe('dang duc');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeName('Nguyen     Van    A')).toBe('nguyen van a');
    expect(normalizeName('Nguyen\tVan\nA')).toBe('nguyen van a');
  });

  it('returns empty string for ≤ 2 chars after normalize', () => {
    expect(normalizeName('A')).toBe('');
    expect(normalizeName('Ab')).toBe('');
    expect(normalizeName('  a  ')).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
  });

  it('keeps 3+ char names', () => {
    expect(normalizeName('abc')).toBe('abc');
    expect(normalizeName('Hà')).toBe(''); // 2 chars after diacritic strip
    expect(normalizeName('Hà Hồ')).toBe('ha ho'); // 5 chars
  });

  it('handles already-normalized text', () => {
    expect(normalizeName('hello world')).toBe('hello world');
  });
});
