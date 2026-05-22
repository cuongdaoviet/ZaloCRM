import { describe, it, expect } from 'vitest';
import {
  validateSearchInput,
  buildSnippet,
  stripJsonEnvelope,
} from '../../src/modules/search/search-helpers.js';

describe('validateSearchInput', () => {
  it('accepts a minimal valid query', () => {
    const r = validateSearchInput({ q: 'hi' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.q).toBe('hi');
      expect(r.value.page).toBe(1);
      expect(r.value.limit).toBe(30);
      expect(r.value.from).toBeNull();
      expect(r.value.to).toBeNull();
    }
  });

  it('rejects query shorter than 2 chars', () => {
    expect(validateSearchInput({ q: 'a' }).ok).toBe(false);
    expect(validateSearchInput({ q: '' }).ok).toBe(false);
    expect(validateSearchInput({ q: '   ' }).ok).toBe(false);
  });

  it('trims whitespace from query', () => {
    const r = validateSearchInput({ q: '  hello  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.q).toBe('hello');
  });

  it('caps limit at 100', () => {
    const r = validateSearchInput({ q: 'hi', limit: 500 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.limit).toBe(100);
  });

  it('parses ISO date range', () => {
    const r = validateSearchInput({
      q: 'hi',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(r.value.to?.toISOString()).toBe('2026-01-31T23:59:59.000Z');
    }
  });

  it('rejects invalid date strings', () => {
    expect(validateSearchInput({ q: 'hi', from: 'not-a-date' }).ok).toBe(false);
  });

  it('rejects from >= to', () => {
    const r = validateSearchInput({
      q: 'hi',
      from: '2026-02-01T00:00:00Z',
      to: '2026-01-01T00:00:00Z',
    });
    expect(r.ok).toBe(false);
  });

  it.each(['self', 'contact'])('accepts senderType=%s', (s) => {
    const r = validateSearchInput({ q: 'hi', senderType: s });
    expect(r.ok).toBe(true);
  });

  it('rejects bad senderType', () => {
    expect(validateSearchInput({ q: 'hi', senderType: 'bot' }).ok).toBe(false);
  });

  it('accepts known contentType', () => {
    const r = validateSearchInput({ q: 'hi', contentType: 'image' });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown contentType', () => {
    const r = validateSearchInput({ q: 'hi', contentType: 'executable' });
    expect(r.ok).toBe(false);
  });

  it('rejects non-positive page/limit', () => {
    expect(validateSearchInput({ q: 'hi', page: 0 }).ok).toBe(false);
    expect(validateSearchInput({ q: 'hi', page: -1 }).ok).toBe(false);
    expect(validateSearchInput({ q: 'hi', limit: 0 }).ok).toBe(false);
  });

  it('treats empty string filters as missing', () => {
    const r = validateSearchInput({ q: 'hi', accountId: '', conversationId: '   ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accountId).toBeNull();
      expect(r.value.conversationId).toBeNull();
    }
  });
});

describe('buildSnippet', () => {
  it('wraps the first match in **...**', () => {
    expect(buildSnippet('hello world', 'world')).toBe('hello **world**');
  });

  it('is case-insensitive but preserves source casing', () => {
    expect(buildSnippet('Hello World', 'WORLD')).toBe('Hello **World**');
  });

  it('returns the whole content when shorter than snippet length', () => {
    const s = buildSnippet('em hỏi bảng giá ạ', 'bảng giá');
    expect(s).toBe('em hỏi **bảng giá** ạ');
  });

  it('truncates with ellipsis when match is far from both ends', () => {
    const longBefore = 'x'.repeat(100);
    const longAfter = 'y'.repeat(100);
    const content = `${longBefore} bảng giá ${longAfter}`;
    const snippet = buildSnippet(content, 'bảng giá');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('**bảng giá**');
  });

  it('omits leading ellipsis when match is near the start', () => {
    const snippet = buildSnippet('Xin chào bảng giá ' + 'x'.repeat(100), 'bảng giá');
    expect(snippet.startsWith('…')).toBe(false);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('returns empty string for null/undefined content', () => {
    expect(buildSnippet(null, 'x')).toBe('');
    expect(buildSnippet(undefined, 'x')).toBe('');
  });

  it('falls back to truncation when query is absent (defensive)', () => {
    const long = 'x'.repeat(200);
    const s = buildSnippet(long, 'not-found-anywhere');
    expect(s.length).toBeLessThanOrEqual(81); // 80 + the ellipsis
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('stripJsonEnvelope', () => {
  it('returns plain text unchanged', () => {
    expect(stripJsonEnvelope('hello world')).toBe('hello world');
  });

  it('returns empty for null / undefined / empty', () => {
    expect(stripJsonEnvelope(null)).toBe('');
    expect(stripJsonEnvelope(undefined)).toBe('');
    expect(stripJsonEnvelope('')).toBe('');
  });

  it('extracts reminder title for msginfo.actionlist payloads', () => {
    const raw = JSON.stringify({ action: 'msginfo.actionlist', title: 'Họp 9 giờ' });
    expect(stripJsonEnvelope(raw)).toBe('Họp 9 giờ');
  });

  it('extracts generic title field from Zalo card payloads', () => {
    const raw = '{"title":"Thầy Việt xin phép gửi tới các bậc phụ huynh","action":"none"}';
    expect(stripJsonEnvelope(raw)).toBe('Thầy Việt xin phép gửi tới các bậc phụ huynh');
  });

  it('falls back to text/description/name when title missing', () => {
    expect(stripJsonEnvelope('{"text":"abc"}')).toBe('abc');
    expect(stripJsonEnvelope('{"description":"xyz"}')).toBe('xyz');
    expect(stripJsonEnvelope('{"name":"def"}')).toBe('def');
  });

  it('returns raw when JSON has no recognizable label fields', () => {
    const raw = '{"foo":"bar","baz":123}';
    expect(stripJsonEnvelope(raw)).toBe(raw);
  });

  it('returns raw when content starts with { but is not valid JSON', () => {
    const raw = '{not really json';
    expect(stripJsonEnvelope(raw)).toBe(raw);
  });

  it('ignores non-string title fields (guards against object/array)', () => {
    const raw = JSON.stringify({ title: { nested: 'yes' }, text: 'fallback' });
    expect(stripJsonEnvelope(raw)).toBe('fallback');
  });

  it('preserves leading whitespace check via trimStart', () => {
    const raw = '   {"title":"trimmed"}';
    expect(stripJsonEnvelope(raw)).toBe('trimmed');
  });
});

describe('buildSnippet — JSON envelope handling', () => {
  it('extracts the label before snippetting', () => {
    const raw = '{"title":"Chào buổi sáng anh chị nhé"}';
    const snippet = buildSnippet(raw, 'chào');
    // Should match against the extracted text, not the raw JSON
    expect(snippet).toContain('**Chào**');
    expect(snippet).not.toContain('{"title"');
  });
});
