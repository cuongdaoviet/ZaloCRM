import { describe, it, expect } from 'vitest';
import {
  validatePayload,
  substitutePlaceholders,
} from '../../src/modules/quick-replies/quick-reply-helpers.js';

describe('validatePayload', () => {
  it('accepts a valid input', () => {
    const result = validatePayload(
      { shortcut: 'chao', content: 'Chào bạn', scope: 'user' },
      'member',
    );
    expect(result).toEqual({
      ok: true,
      value: { shortcut: 'chao', content: 'Chào bạn', scope: 'user' },
    });
  });

  it('lowercases and trims shortcut', () => {
    const result = validatePayload(
      { shortcut: '  HELLO_2  ', content: 'x' },
      'admin',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.shortcut).toBe('hello_2');
  });

  it.each([
    ['', 'empty'],
    ['a', 'single char'],
    ['Chào!', 'unicode + punctuation'],
    ['this-shortcut-is-way-too-long', 'over 20 chars'],
    ['has space', 'has space'],
  ])('rejects invalid shortcut: %s (%s)', (shortcut) => {
    const result = validatePayload({ shortcut, content: 'x' }, 'admin');
    expect(result.ok).toBe(false);
  });

  it('rejects empty content', () => {
    const result = validatePayload({ shortcut: 'ok', content: '' }, 'admin');
    expect(result.ok).toBe(false);
  });

  it('rejects content over 2000 chars', () => {
    const result = validatePayload(
      { shortcut: 'ok', content: 'x'.repeat(2001) },
      'admin',
    );
    expect(result.ok).toBe(false);
  });

  it('coerces member scope=org to scope=user', () => {
    const result = validatePayload(
      { shortcut: 'ok', content: 'x', scope: 'org' },
      'member',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scope).toBe('user');
  });

  it('lets admin keep scope=org', () => {
    const result = validatePayload(
      { shortcut: 'ok', content: 'x', scope: 'org' },
      'admin',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scope).toBe('org');
  });

  it('lets owner keep scope=org', () => {
    const result = validatePayload(
      { shortcut: 'ok', content: 'x', scope: 'org' },
      'owner',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scope).toBe('org');
  });

  it('defaults missing scope to user', () => {
    const result = validatePayload({ shortcut: 'ok', content: 'x' }, 'admin');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scope).toBe('user');
  });

  it('rejects non-object body', () => {
    expect(validatePayload(null, 'admin').ok).toBe(false);
    expect(validatePayload('string', 'admin').ok).toBe(false);
    expect(validatePayload(42, 'admin').ok).toBe(false);
  });
});

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

  it('handles multiple occurrences', () => {
    expect(
      substitutePlaceholders('{{contactName}}, {{contactName}}!', {
        fullName: 'An',
      }),
    ).toBe('An, An!');
  });

  it('substitutes empty string for null contact', () => {
    expect(substitutePlaceholders('Chào {{contactName}}', null)).toBe('Chào ');
  });

  it('substitutes empty string for contact without fullName', () => {
    expect(substitutePlaceholders('Hi {{firstName}}!', { fullName: null })).toBe(
      'Hi !',
    );
  });

  it('leaves content without placeholders unchanged', () => {
    expect(substitutePlaceholders('Plain content', { fullName: 'X' })).toBe('Plain content');
  });
});
