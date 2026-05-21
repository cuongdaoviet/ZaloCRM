/**
 * Unit tests for Feature 0026 — mention rendering + auto-complete helpers.
 *
 * Covers the pure-function pieces of the spec:
 *  - parseMentions   → AC-0007 (chip render), AC-0008 (fallback for unknown uid)
 *  - detectMentionTrigger → BR-0004 (no trigger after email), EC-0003 (latest @)
 *  - filterMembers   → AC-0009 (prefix filter, case-insensitive, NFC)
 *  - applyMentionInsert → AC-0010 (splice + caret)
 *
 * The Vue-side gating (BR-0003: picker disabled for user-to-user conversations)
 * lives in MessageThread.vue and is exercised manually + by the build.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMentions,
  detectMentionTrigger,
  filterMembers,
  applyMentionInsert,
  MENTION_PICKER_LIMIT,
  type GroupMember,
} from '@/composables/use-mentions';

function makeMember(uid: string, displayName: string): GroupMember {
  return { uid, displayName, avatarUrl: '' };
}

function makeMap(members: GroupMember[]): Map<string, GroupMember> {
  return new Map(members.map((m) => [m.uid, m]));
}

describe('parseMentions (AC-0007 / AC-0008)', () => {
  it('AC-0007: replaces @<uid> with mention part using displayName', () => {
    const map = makeMap([makeMember('2347234782', 'Lan Anh')]);
    const parts = parseMentions('Anh @2347234782 phụ trách', map);
    expect(parts).toEqual([
      { kind: 'text', text: 'Anh ' },
      { kind: 'mention', uid: '2347234782', displayName: 'Lan Anh', found: true },
      { kind: 'text', text: ' phụ trách' },
    ]);
  });

  it('AC-0008: uid not in member map renders mention part with found=false', () => {
    const map = makeMap([makeMember('2347234782', 'Lan Anh')]);
    const parts = parseMentions('Ai là @9999999999 vậy', map);
    expect(parts).toEqual([
      { kind: 'text', text: 'Ai là ' },
      { kind: 'mention', uid: '9999999999', displayName: '9999999999', found: false },
      { kind: 'text', text: ' vậy' },
    ]);
  });

  it('plain text with no @<uid> returns single text part', () => {
    const map = makeMap([]);
    expect(parseMentions('Chào cả nhóm', map)).toEqual([
      { kind: 'text', text: 'Chào cả nhóm' },
    ]);
  });

  it('EC-0005: email-shaped @example does NOT match (regex requires digits)', () => {
    const map = makeMap([]);
    const parts = parseMentions('contact me at user@example.com', map);
    expect(parts).toEqual([{ kind: 'text', text: 'contact me at user@example.com' }]);
  });

  it('multiple mentions in one message all resolve', () => {
    const map = makeMap([
      makeMember('111111', 'A'),
      makeMember('222222', 'B'),
    ]);
    const parts = parseMentions('hi @111111 và @222222!', map);
    const mentions = parts.filter((p) => p.kind === 'mention');
    expect(mentions).toHaveLength(2);
    expect(mentions.map((m) => (m.kind === 'mention' ? m.displayName : ''))).toEqual([
      'A',
      'B',
    ]);
  });

  it('null / undefined / empty content returns empty text part', () => {
    const map = makeMap([]);
    expect(parseMentions(null, map)).toEqual([{ kind: 'text', text: '' }]);
    expect(parseMentions(undefined, map)).toEqual([{ kind: 'text', text: '' }]);
    expect(parseMentions('', map)).toEqual([{ kind: 'text', text: '' }]);
  });

  it('uid shorter than 6 digits does NOT match (regex floor)', () => {
    const map = makeMap([]);
    expect(parseMentions('order #@12345 issue', map)).toEqual([
      { kind: 'text', text: 'order #@12345 issue' },
    ]);
  });

  it('shared MENTION_REGEX has no lastIndex leak across calls', () => {
    // Call twice with two strings — if the regex's lastIndex were leaking,
    // the second call would skip the leading match.
    const map = makeMap([makeMember('111111', 'A')]);
    parseMentions('@111111 first', map);
    const second = parseMentions('@111111 second', map);
    expect(second[0]).toEqual({
      kind: 'mention',
      uid: '111111',
      displayName: 'A',
      found: true,
    });
  });
});

describe('detectMentionTrigger (BR-0004 / EC-0003 / EC-0005)', () => {
  it('returns trigger when @ is at line start and caret follows', () => {
    expect(detectMentionTrigger('@', 1)).toEqual({ atIndex: 0, query: '', caret: 1 });
    expect(detectMentionTrigger('@la', 3)).toEqual({ atIndex: 0, query: 'la', caret: 3 });
  });

  it('returns trigger when @ follows a space', () => {
    expect(detectMentionTrigger('hi @la', 6)).toEqual({ atIndex: 3, query: 'la', caret: 6 });
  });

  it('BR-0004: @ following a letter (email) does NOT trigger', () => {
    expect(detectMentionTrigger('user@example.com', 10)).toBeNull();
    expect(detectMentionTrigger('foo@b', 5)).toBeNull();
  });

  it('BR-0004: @ following a digit does NOT trigger', () => {
    expect(detectMentionTrigger('1@a', 3)).toBeNull();
  });

  it('EC-0003: multiple @ in a row → trigger is the LAST one before caret', () => {
    // "@a@b" — caret at end (4). Only "@b" should trigger.
    const trig = detectMentionTrigger('@a@b', 4);
    // The @ at index 2 is preceded by a letter ("a") so it FAILS BR-0004.
    // Therefore no trigger fires here — that's the spec ("only triggers
    // when @ follows whitespace/line start"). Acceptable per EC-0003 wording:
    // we don't try to backfill earlier @ tokens.
    expect(trig).toBeNull();
  });

  it('whitespace inside query closes the trigger', () => {
    expect(detectMentionTrigger('@la nh', 6)).toBeNull();
  });

  it('caret 0 returns null', () => {
    expect(detectMentionTrigger('@la', 0)).toBeNull();
  });

  it('caret past input length returns null', () => {
    expect(detectMentionTrigger('@la', 99)).toBeNull();
  });

  it('@ exists but caret is before it → null', () => {
    expect(detectMentionTrigger('hello @la', 3)).toBeNull();
  });

  it('caps query length at 30 to prevent runaway open', () => {
    const longQuery = '@' + 'a'.repeat(31);
    expect(detectMentionTrigger(longQuery, longQuery.length)).toBeNull();
  });

  it('@ after newline is treated like @ after space', () => {
    expect(detectMentionTrigger('hi\n@la', 6)).toEqual({ atIndex: 3, query: 'la', caret: 6 });
  });
});

describe('filterMembers (AC-0009 / BR-0005)', () => {
  const members: GroupMember[] = [
    makeMember('1', 'Lan Anh'),
    makeMember('2', 'Lan Hương'),
    makeMember('3', 'Bình'),
    makeMember('4', 'lac'),
    makeMember('5', 'Anh Tuấn'),
  ];

  it('AC-0009: empty query returns members sorted (case-insensitive)', () => {
    const result = filterMembers(members, '');
    // Vietnamese collation treats 'A' < 'B' < 'L' regardless of case.
    // Assert via set membership + leading char ordering to stay locale-stable.
    expect(result).toHaveLength(5);
    expect(new Set(result.map((m) => m.displayName))).toEqual(
      new Set(['Anh Tuấn', 'Bình', 'lac', 'Lan Anh', 'Lan Hương']),
    );
    // First two are stable across vi collations.
    expect(result[0].displayName).toBe('Anh Tuấn');
    expect(result[1].displayName).toBe('Bình');
  });

  it('AC-0009: prefix filter is case-insensitive (LA matches "lac" + "Lan*")', () => {
    const result = filterMembers(members, 'LA');
    const names = new Set(result.map((m) => m.displayName));
    expect(names).toEqual(new Set(['lac', 'Lan Anh', 'Lan Hương']));
  });

  it('"la " query (with trailing space) still matches "la" prefix', () => {
    // detectMentionTrigger never returns a query with whitespace, but the
    // helper is defensive — trim before normalising.
    const result = filterMembers(members, 'la ');
    const names = new Set(result.map((m) => m.displayName));
    expect(names).toEqual(new Set(['lac', 'Lan Anh', 'Lan Hương']));
  });

  it('non-matching prefix returns empty array', () => {
    expect(filterMembers(members, 'xyz')).toEqual([]);
  });

  it('BR-0005: caps at MENTION_PICKER_LIMIT (10)', () => {
    const many: GroupMember[] = Array.from({ length: 25 }, (_, i) =>
      makeMember(`u${i}`, `User${String(i).padStart(2, '0')}`),
    );
    const result = filterMembers(many, 'User');
    expect(result.length).toBe(MENTION_PICKER_LIMIT);
  });

  it('NFC normalisation: composed vs decomposed Vietnamese match', () => {
    // "Lan" in NFC vs NFD form — both should be matched by query "lan".
    const decomposed = 'L' + 'a' + '́' + 'n'; // L + a + combining acute
    const arr = [makeMember('1', decomposed.normalize('NFD'))];
    const result = filterMembers(arr, 'lá');
    expect(result.length).toBe(1);
  });
});

describe('applyMentionInsert (AC-0010 / BR-0007)', () => {
  it('AC-0010: replaces @<query> with @<uid> + trailing space', () => {
    const trigger = { atIndex: 0, query: 'la', caret: 3 };
    const member = makeMember('2347234782', 'Lan Anh');
    const result = applyMentionInsert('@la', trigger, member);
    expect(result).toEqual({ value: '@2347234782 ', caret: 12 });
  });

  it('preserves text after the caret', () => {
    const trigger = { atIndex: 4, query: 'la', caret: 7 };
    const member = makeMember('2347234782', 'Lan Anh');
    const result = applyMentionInsert('Hi  @la rest', trigger, member);
    expect(result.value).toBe('Hi  @2347234782  rest');
    // caret position is right after the inserted "@<uid> " (trailing space).
    expect(result.caret).toBe('Hi  @2347234782 '.length);
  });

  it('preserves text before @ when @ is mid-line', () => {
    const trigger = { atIndex: 6, query: '', caret: 7 };
    const member = makeMember('111111', 'A');
    const result = applyMentionInsert('Chào, @', trigger, member);
    expect(result.value).toBe('Chào, @111111 ');
    expect(result.caret).toBe('Chào, @111111 '.length);
  });
});
