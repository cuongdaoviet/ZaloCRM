import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  prisma: { contact: { updateMany: vi.fn() } },
}));
vi.mock('../../src/modules/chat/message-handler.js', () => ({
  handleIncomingMessage: vi.fn(),
}));

const { detectContentType } = await import('../../src/modules/zalo/zalo-message-helpers.js');

describe('detectContentType', () => {
  it.each([
    ['photo', 'image'],
    ['image_url', 'image'],
    ['sticker', 'sticker'],
    ['video', 'video'],
    ['voice', 'voice'],
    ['gif', 'gif'],
    ['link', 'link'],
    ['location', 'location'],
    ['file', 'file'],
    ['doc', 'file'],
    ['recommended', 'contact_card'],
    ['card', 'contact_card'],
    ['webchat', 'text'],
    [undefined, 'text'],
  ])('msgType %s → %s', (msgType, expected) => {
    expect(detectContentType(msgType, 'any string')).toBe(expected);
  });

  it('returns "rich" when msgType is unknown AND content is a non-null object', () => {
    expect(detectContentType('unknown_type', { foo: 'bar' })).toBe('rich');
  });

  it('returns "text" when msgType is undefined regardless of content shape', () => {
    // Per implementation: !msgType short-circuits to 'text' before checking content
    expect(detectContentType(undefined, { foo: 'bar' })).toBe('text');
  });

  it('returns "text" for plain string content with no matching msgType', () => {
    expect(detectContentType('unknown_type', 'hello')).toBe('text');
  });

  // ── Feature 0029 — zinstant detection (AC-0001) ────────────────────────────
  describe('zinstant detection', () => {
    it('detects @@ZINSTANT@@ marker in string content', () => {
      expect(detectContentType('webchat', '@@ZINSTANT@@ payload')).toBe('zinstant');
    });

    it('detects JSON-shape zinstant with appId + params', () => {
      const json = JSON.stringify({
        appId: 'bank_card',
        params: { bankCode: 'BIDV', accountNumber: '12345678' },
      });
      expect(detectContentType('webchat', json)).toBe('zinstant');
    });

    it('detects zinstant object shape (already parsed)', () => {
      expect(
        detectContentType('webchat', { appId: 'bank_card', params: {} }),
      ).toBe('zinstant');
    });

    it('zinstant wins over generic card msgType', () => {
      expect(
        detectContentType('card_recommended', '{"appId":"bank","params":{}}'),
      ).toBe('zinstant');
    });

    it('non-zinstant JSON does not trigger zinstant', () => {
      expect(detectContentType('webchat', '{"foo":"bar"}')).toBe('text');
    });

    it('malformed JSON does not crash detection (BR-0004)', () => {
      expect(detectContentType('webchat', '{not json')).toBe('text');
    });
  });
});
