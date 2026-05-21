import { describe, it, expect } from 'vitest';
import {
  detectPhoneGroups,
  detectUidGroups,
  detectGlobalIdGroups,
  detectNameGroups,
  detectAll,
  UnionFind,
  type ContactRow,
} from '../../src/modules/contacts/duplicate-detection.js';

function row(
  id: string,
  fullName: string | null = null,
  phone: string | null = null,
  zaloUid: string | null = null,
  zaloGlobalId: string | null = null,
): ContactRow {
  return { id, fullName, phone, zaloUid, zaloGlobalId };
}

describe('UnionFind', () => {
  it('groups transitive pairs into one set', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('b', 'c');
    const groups = uf.groups();
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not emit singletons', () => {
    const uf = new UnionFind();
    uf.add('lonely');
    expect(uf.groups()).toEqual([]);
  });

  it('emits multiple disjoint groups', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('c', 'd');
    const groups = uf.groups().map((g) => g.sort()).sort();
    expect(groups).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('detectPhoneGroups (BR-0003 phone_exact)', () => {
  it('groups contacts that share a normalized phone', () => {
    const groups = detectPhoneGroups([
      row('a', null, '0901234567'),
      row('b', null, '+84 901-234-567'),
      row('c', null, '0911111111'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds).toEqual(['a', 'b']);
    expect(groups[0].confidence).toBe(1.0);
    expect(groups[0].level).toBe('phone_exact');
  });

  it('AC-0003: 3-contact group when all share phone', () => {
    const groups = detectPhoneGroups([
      row('a', null, '0901234567'),
      row('b', null, '+84 901 234 567'),
      row('c', null, '84901234567'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not group contacts with unnormalizable phones (BR-EC-0007)', () => {
    const groups = detectPhoneGroups([
      row('a', null, '...'),
      row('b', null, '+++'),
    ]);
    expect(groups).toEqual([]);
  });

  it('no-match returns no groups', () => {
    const groups = detectPhoneGroups([
      row('a', null, '0901234567'),
      row('b', null, '0911111111'),
    ]);
    expect(groups).toEqual([]);
  });
});

describe('detectUidGroups (BR-0003 zaloUid_exact)', () => {
  it('groups contacts sharing zaloUid', () => {
    const groups = detectUidGroups([
      row('a', null, null, 'uid-1'),
      row('b', null, null, 'uid-1'),
      row('c', null, null, 'uid-2'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds).toEqual(['a', 'b']);
    expect(groups[0].confidence).toBe(1.0);
  });

  it('null zaloUid does not match other null (EC-0008)', () => {
    const groups = detectUidGroups([
      row('a', null, null, null),
      row('b', null, null, null),
    ]);
    expect(groups).toEqual([]);
  });
});

describe('detectGlobalIdGroups (Feature 0034 globalId_exact)', () => {
  it('AC-0005 unit: groups two contacts sharing zaloGlobalId, different zaloUid', () => {
    const groups = detectGlobalIdGroups([
      row('a', null, null, 'uid-old', 'g-1'),
      row('b', null, null, 'uid-new', 'g-1'),
      row('c', null, null, 'uid-other', 'g-2'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].level).toBe('globalId_exact');
    expect(groups[0].confidence).toBe(1.0);
    expect(groups[0].contactIds).toEqual(['a', 'b']);
  });

  it('EC-0002: 3+ contacts on same globalId merge into one cluster', () => {
    const groups = detectGlobalIdGroups([
      row('a', null, null, 'uid-1', 'g-x'),
      row('b', null, null, 'uid-2', 'g-x'),
      row('c', null, null, 'uid-3', 'g-x'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('null zaloGlobalId does not match other null (EC-0001 / EC-0004)', () => {
    const groups = detectGlobalIdGroups([
      row('a', null, null, 'u-1', null),
      row('b', null, null, 'u-2', null),
    ]);
    expect(groups).toEqual([]);
  });

  it('trims whitespace when grouping', () => {
    const groups = detectGlobalIdGroups([
      row('a', null, null, 'u-1', 'g-1'),
      row('b', null, null, 'u-2', '  g-1  '),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds).toEqual(['a', 'b']);
  });

  it('empty-string globalId is treated as missing', () => {
    const groups = detectGlobalIdGroups([
      row('a', null, null, 'u-1', ''),
      row('b', null, null, 'u-2', ''),
    ]);
    expect(groups).toEqual([]);
  });
});

describe('detectNameGroups (BR-0003 name_fuzzy)', () => {
  it('groups identical normalized names', () => {
    const { groups } = detectNameGroups([
      row('a', 'Nguyễn Văn Anh'),
      row('b', 'Nguyen Van Anh'),
      row('c', 'Pham Thi Lan'), // unrelated
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds).toEqual(['a', 'b']);
    expect(groups[0].confidence).toBe(0.9); // exact normalized match
  });

  it('groups names with Levenshtein ≤ 2 when long enough', () => {
    const { groups } = detectNameGroups([
      row('a', 'Nguyen Van Hoang'),
      row('b', 'Nguyen Van Hoanq'), // 1 char swap
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds).toEqual(['a', 'b']);
    expect(groups[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('does not pair short names via Levenshtein', () => {
    // both names < 5 chars after normalize → only exact match works
    const { groups } = detectNameGroups([
      row('a', 'abc'),
      row('b', 'abd'), // dist 1, but both < 5
    ]);
    expect(groups).toEqual([]);
  });

  it('transitively unions via name_fuzzy (3-contact group)', () => {
    const { groups } = detectNameGroups([
      row('a', 'Nguyen Van Aoo'),
      row('b', 'Nguyen Van Boo'), // dist 1 from a
      row('c', 'Nguyen Van Coo'), // dist 1 from b, dist 2 from a
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns skipped=true when contacts > 20k (EC-0009)', () => {
    const big: ContactRow[] = [];
    for (let i = 0; i < 20_001; i++) big.push(row(`id-${i}`, `Name-${i}`));
    const result = detectNameGroups(big);
    expect(result.skipped).toBe(true);
    expect(result.groups).toEqual([]);
  });
});

describe('detectAll', () => {
  it('runs all levels and merges results without overlap', () => {
    const contacts: ContactRow[] = [
      row('a', 'Same Name', '0901234567', null, null),
      row('b', 'Same Name', '0901234567', null, null), // same phone + same name
      row('c', 'Other Name', null, 'uid-1', null),
      row('d', 'Other Name', null, 'uid-1', null), // same uid + same name
      row('e', null, null, 'uid-old', 'g-merge'),
      row('f', null, null, 'uid-new', 'g-merge'), // Feature 0034 globalId_exact
    ];
    const { groups } = detectAll(contacts, [
      'phone_exact',
      'zaloUid_exact',
      'globalId_exact',
      'name_fuzzy',
    ]);
    const levels = groups.map((g) => g.level).sort();
    expect(levels).toContain('phone_exact');
    expect(levels).toContain('zaloUid_exact');
    expect(levels).toContain('globalId_exact');
    expect(levels).toContain('name_fuzzy');
  });

  it('honours level selection', () => {
    const contacts: ContactRow[] = [
      row('a', null, '0901234567', 'uid-1', 'g-1'),
      row('b', null, '0901234567', 'uid-1', 'g-1'),
    ];
    const phoneOnly = detectAll(contacts, ['phone_exact']);
    expect(phoneOnly.groups.every((g) => g.level === 'phone_exact')).toBe(true);

    // Feature 0034 — globalId_exact opt-in works in isolation.
    const gidOnly = detectAll(contacts, ['globalId_exact']);
    expect(gidOnly.groups.every((g) => g.level === 'globalId_exact')).toBe(true);
    expect(gidOnly.groups[0].contactIds).toEqual(['a', 'b']);
  });
});
