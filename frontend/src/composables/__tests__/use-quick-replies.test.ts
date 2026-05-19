import { describe, it, expect } from 'vitest';
import { substitutePlaceholders } from '@/composables/use-quick-replies';

describe('substitutePlaceholders', () => {
  it('replaces {{contactName}} with full name', () => {
    expect(
      substitutePlaceholders('Chào {{contactName}}', { fullName: 'Nguyễn Văn A' }),
    ).toBe('Chào Nguyễn Văn A');
  });

  it('replaces {{firstName}} with first whitespace-separated token', () => {
    expect(
      substitutePlaceholders('Hi {{firstName}}', { fullName: 'Nguyễn Văn A' }),
    ).toBe('Hi Nguyễn');
  });

  it('handles both placeholders in same template', () => {
    expect(
      substitutePlaceholders('Chào {{firstName}}, ký tên {{contactName}}', {
        fullName: 'Trần Thị B',
      }),
    ).toBe('Chào Trần, ký tên Trần Thị B');
  });

  it('replaces multiple occurrences of same placeholder', () => {
    expect(
      substitutePlaceholders('{{contactName}}, {{contactName}}!', { fullName: 'A' }),
    ).toBe('A, A!');
  });

  it('null contact → empty string substitution', () => {
    expect(substitutePlaceholders('Chào {{contactName}}', null)).toBe('Chào ');
  });

  it('undefined contact → empty string substitution', () => {
    expect(substitutePlaceholders('Hi {{firstName}}!', undefined)).toBe('Hi !');
  });

  it('contact with null fullName → empty string', () => {
    expect(substitutePlaceholders('Hi {{firstName}}!', { fullName: null })).toBe(
      'Hi !',
    );
  });

  it('content without placeholders unchanged', () => {
    expect(substitutePlaceholders('Plain text no placeholders', { fullName: 'X' })).toBe(
      'Plain text no placeholders',
    );
  });

  it('trims whitespace from fullName', () => {
    expect(
      substitutePlaceholders('Hi {{firstName}}', { fullName: '  Lan  ' }),
    ).toBe('Hi Lan');
  });
});
