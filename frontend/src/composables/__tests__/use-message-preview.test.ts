/**
 * Unit tests for the shared `formatMessagePreview` helper used by chat
 * list rows, global search dropdown, and message search results page.
 */
import { describe, it, expect } from 'vitest';
import { formatMessagePreview } from '@/composables/use-message-preview';

describe('formatMessagePreview', () => {
  it('returns empty string for null/undefined/empty content', () => {
    expect(formatMessagePreview(null)).toBe('');
    expect(formatMessagePreview(undefined)).toBe('');
    expect(formatMessagePreview('')).toBe('');
  });

  it('renders plain text unchanged when under max chars', () => {
    expect(formatMessagePreview('hello world')).toBe('hello world');
  });

  it('truncates plain text past max chars and appends ellipsis', () => {
    const long = 'x'.repeat(100);
    const out = formatMessagePreview(long, null, { maxChars: 60 });
    expect(out).toBe('x'.repeat(60) + '...');
  });

  it('short-circuits with attachment label when contentType matches', () => {
    expect(formatMessagePreview('whatever', 'image')).toBe('📷 Hình ảnh');
    expect(formatMessagePreview(null, 'sticker')).toBe('🏷️ Sticker');
    expect(formatMessagePreview('', 'voice')).toBe('🎤 Tin nhắn thoại');
    expect(formatMessagePreview('', 'video')).toBe('🎥 Video');
    expect(formatMessagePreview('', 'gif')).toBe('GIF');
    expect(formatMessagePreview('', 'file')).toBe('📎 Tệp đính kèm');
    expect(formatMessagePreview('', 'link')).toBe('🔗 Liên kết');
  });

  it('extracts title from Zalo card-style JSON payloads', () => {
    const raw = '{"title":"Thầy Việt xin phép gửi tới các bậc phụ huynh","action":"none"}';
    expect(formatMessagePreview(raw)).toBe('Thầy Việt xin phép gửi tới các bậc phụ huynh');
  });

  it('extracts reminder title for msginfo.actionlist with calendar emoji', () => {
    const raw = JSON.stringify({ action: 'msginfo.actionlist', title: 'Họp lúc 9 giờ' });
    expect(formatMessagePreview(raw)).toBe('📅 Họp lúc 9 giờ');
  });

  it('falls back to text/description/name fields in order', () => {
    expect(formatMessagePreview('{"text":"abc"}')).toBe('abc');
    expect(formatMessagePreview('{"description":"xyz"}')).toBe('xyz');
    expect(formatMessagePreview('{"name":"def"}')).toBe('def');
  });

  it('uses the fallback label when JSON has no recognized label fields', () => {
    expect(formatMessagePreview('{"foo":"bar","baz":1}')).toBe('[Tin nhắn dạng đặc biệt]');
  });

  it('respects custom fallbackLabel option', () => {
    const raw = '{"foo":"bar"}';
    const out = formatMessagePreview(raw, null, { fallbackLabel: '🎴 Card message' });
    expect(out).toBe('🎴 Card message');
  });

  it('returns raw text when content starts with { but is not valid JSON', () => {
    const raw = '{not really json';
    expect(formatMessagePreview(raw)).toBe(raw);
  });

  it('contentType attachment takes precedence over JSON body parse', () => {
    // Edge case: server returns contentType='image' AND a JSON-shaped content.
    // The attachment label wins because the content is metadata-only.
    expect(formatMessagePreview('{"url":"…"}', 'image')).toBe('📷 Hình ảnh');
  });

  it('truncates a long extracted JSON label with ellipsis', () => {
    const longTitle = 'A'.repeat(120);
    const raw = JSON.stringify({ title: longTitle });
    const out = formatMessagePreview(raw, null, { maxChars: 60 });
    expect(out).toBe('A'.repeat(60) + '...');
  });

  it('ignores non-string title (e.g. nested object) and tries other fields', () => {
    const raw = JSON.stringify({ title: { nested: 'no' }, text: 'fallback text' });
    expect(formatMessagePreview(raw)).toBe('fallback text');
  });
});
