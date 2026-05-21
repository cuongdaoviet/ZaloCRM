/**
 * Feature 0024 — Dual name display helpers.
 *
 * Verifies BR-0004 (primary fallback) and BR-0005 (muted secondary hidden
 * when names match case-insensitively, or when zaloDisplayName is empty).
 */
import { describe, it, expect } from 'vitest';
import { primaryContactName, secondaryZaloName } from '../use-contact-name';

describe('primaryContactName (BR-0004)', () => {
  it('returns fullName when set', () => {
    expect(
      primaryContactName({ fullName: 'Anh Tuấn', zaloDisplayName: 'Nguyễn T.' }),
    ).toBe('Anh Tuấn');
  });

  it('falls back to zaloDisplayName when fullName is null', () => {
    expect(
      primaryContactName({ fullName: null, zaloDisplayName: 'Nguyễn T.' }),
    ).toBe('Nguyễn T.');
  });

  it('falls back to zaloDisplayName when fullName is empty after trim', () => {
    expect(
      primaryContactName({ fullName: '   ', zaloDisplayName: 'Nguyễn T.' }),
    ).toBe('Nguyễn T.');
  });

  it('returns empty string when both are null', () => {
    expect(primaryContactName({ fullName: null, zaloDisplayName: null })).toBe('');
  });

  it('returns empty string for null contact', () => {
    expect(primaryContactName(null)).toBe('');
  });
});

describe('secondaryZaloName (BR-0005)', () => {
  it('returns zaloDisplayName when it differs from fullName', () => {
    expect(
      secondaryZaloName({ fullName: 'Anh Tuấn CFO', zaloDisplayName: 'Nguyễn Văn T.' }),
    ).toBe('Nguyễn Văn T.');
  });

  it('returns null when names are equal', () => {
    expect(
      secondaryZaloName({ fullName: 'Nguyễn T.', zaloDisplayName: 'Nguyễn T.' }),
    ).toBeNull();
  });

  it('returns null when names differ only in case', () => {
    expect(
      secondaryZaloName({ fullName: 'NGUYỄN T.', zaloDisplayName: 'nguyễn t.' }),
    ).toBeNull();
  });

  it('returns null when names differ only by surrounding whitespace', () => {
    expect(
      secondaryZaloName({ fullName: '  Anh Tuấn  ', zaloDisplayName: 'Anh Tuấn' }),
    ).toBeNull();
  });

  it('returns null when zaloDisplayName is empty / null', () => {
    expect(secondaryZaloName({ fullName: 'Anh Tuấn', zaloDisplayName: null })).toBeNull();
    expect(secondaryZaloName({ fullName: 'Anh Tuấn', zaloDisplayName: '' })).toBeNull();
  });

  it('returns null when fullName is empty (primary already falls back to zalo)', () => {
    expect(
      secondaryZaloName({ fullName: null, zaloDisplayName: 'Nguyễn T.' }),
    ).toBeNull();
  });

  it('returns null for null contact', () => {
    expect(secondaryZaloName(null)).toBeNull();
  });
});
