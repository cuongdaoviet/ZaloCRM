/**
 * Unit tests — feature 0021 reaction mapping helpers.
 *
 * Covers the convert tables: UI emoji ↔ zca-js Reactions enum and rType ↔
 * UI emoji. The rType table is convention-based (see comment at top of
 * `reaction-mapping.ts`) so we lock in the expected mapping with explicit
 * test cases and let the runtime log surface any deviation.
 */
import { describe, it, expect } from 'vitest';
import {
  EMOJI_TO_REACTIONS_ENUM,
  REACTIONS_ENUM,
  RTYPE_TO_EMOJI,
  STANDARD_EMOJIS,
  emojiToZcaIcon,
  isStandardEmoji,
  rTypeToEmoji,
} from '../../src/modules/reactions/reaction-mapping.js';

describe('STANDARD_EMOJIS — the 6 UI picker emojis', () => {
  it('has exactly 6 distinct entries', () => {
    expect(STANDARD_EMOJIS).toHaveLength(6);
    expect(new Set(STANDARD_EMOJIS).size).toBe(6);
  });

  it('contains the spec-mandated set', () => {
    expect(STANDARD_EMOJIS).toEqual(['❤️', '👍', '😆', '😮', '😭', '😡']);
  });
});

describe('emojiToZcaIcon (UI → zca-js enum) — outbound mapping', () => {
  it.each([
    ['❤️', REACTIONS_ENUM.HEART],
    ['👍', REACTIONS_ENUM.LIKE],
    ['😆', REACTIONS_ENUM.HAHA],
    ['😮', REACTIONS_ENUM.WOW],
    ['😭', REACTIONS_ENUM.CRY],
    ['😡', REACTIONS_ENUM.ANGRY],
  ])('maps %s to %s', (emoji, code) => {
    expect(emojiToZcaIcon(emoji)).toBe(code);
  });

  it('throws on unknown emoji', () => {
    expect(() => emojiToZcaIcon('🤔')).toThrow();
    expect(() => emojiToZcaIcon('')).toThrow();
  });

  it('table is exhaustive — every STANDARD_EMOJIS entry has an enum mapping', () => {
    for (const e of STANDARD_EMOJIS) {
      expect(EMOJI_TO_REACTIONS_ENUM[e]).toBeTruthy();
    }
  });
});

describe('rTypeToEmoji (zca-js inbound rType → UI emoji)', () => {
  it.each([
    [1, '❤️'],
    [2, '👍'],
    [3, '😆'],
    [4, '😮'],
    [5, '😭'],
    [6, '😡'],
  ])('rType=%i → %s', (rType, emoji) => {
    expect(rTypeToEmoji(rType)).toBe(emoji);
  });

  it('returns "custom:<rType>" for unknown rType > 6 (EC-0007)', () => {
    expect(rTypeToEmoji(7)).toBe('custom:7');
    expect(rTypeToEmoji(99)).toBe('custom:99');
  });

  it('also returns "custom:<rType>" for negative rType', () => {
    // Defensive — Zalo shouldn't send negative values but the mapper is
    // total: any non-standard int falls through to the custom branch.
    expect(rTypeToEmoji(-1)).toBe('custom:-1');
  });

  it('table is exhaustive — every standard rType maps to a STANDARD_EMOJIS entry', () => {
    const mapped = new Set(Object.values(RTYPE_TO_EMOJI));
    for (const e of STANDARD_EMOJIS) {
      expect(mapped.has(e)).toBe(true);
    }
  });
});

describe('round-trip: UI emoji → enum → back via rType', () => {
  // Convention-based — when the listener confirms rType ordering, this
  // test is the canary.
  it.each([
    [1, '❤️', REACTIONS_ENUM.HEART],
    [2, '👍', REACTIONS_ENUM.LIKE],
    [3, '😆', REACTIONS_ENUM.HAHA],
    [4, '😮', REACTIONS_ENUM.WOW],
    [5, '😭', REACTIONS_ENUM.CRY],
    [6, '😡', REACTIONS_ENUM.ANGRY],
  ])('rType=%i ↔ %s ↔ %s', (rType, emoji, enumCode) => {
    expect(emojiToZcaIcon(emoji)).toBe(enumCode);
    expect(rTypeToEmoji(rType)).toBe(emoji);
  });
});

describe('isStandardEmoji', () => {
  it('returns true for all 6 standard emojis', () => {
    for (const e of STANDARD_EMOJIS) expect(isStandardEmoji(e)).toBe(true);
  });

  it('returns false for non-standard emojis', () => {
    expect(isStandardEmoji('🤔')).toBe(false);
    expect(isStandardEmoji('🎉')).toBe(false);
    expect(isStandardEmoji('')).toBe(false);
    expect(isStandardEmoji('custom:7')).toBe(false);
  });
});

describe('REACTIONS_ENUM mirror values', () => {
  // These literals must match `node_modules/zca-js/dist/models/Reaction.d.ts`.
  // If zca-js bumps the codes, this test fails — same canary pattern as
  // `friendship-listener.ts`'s FRIEND_EVENT_TYPE mirror.
  it('matches zca-js Reactions enum string codes', () => {
    expect(REACTIONS_ENUM.HEART).toBe('/-heart');
    expect(REACTIONS_ENUM.LIKE).toBe('/-strong');
    expect(REACTIONS_ENUM.HAHA).toBe(':>');
    expect(REACTIONS_ENUM.WOW).toBe(':o');
    expect(REACTIONS_ENUM.CRY).toBe(':-((');
    expect(REACTIONS_ENUM.ANGRY).toBe(':-h');
    expect(REACTIONS_ENUM.NONE).toBe('');
  });
});
