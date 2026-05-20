/**
 * Pure duplicate-detection algorithms (feature 0018, BR-0003 / BR-0004).
 *
 * The scanner pulls contacts, runs each detection level, then runs union-find
 * over the resulting pairs to consolidate transitively-related contacts into
 * a single group (e.g. A↔B same phone + B↔C same name → group {A, B, C}).
 *
 * Inputs are kept dependency-free: each detector takes a minimal contact
 * record and returns groups (id arrays sorted ascending, length ≥ 2).
 */
import { normalizePhone } from './phone-normalize.js';
import { normalizeName } from './name-normalize.js';
import { levenshtein } from './levenshtein.js';

export type DuplicateLevel = 'phone_exact' | 'zaloUid_exact' | 'name_fuzzy';

export interface ContactRow {
  id: string;
  fullName: string | null;
  phone: string | null;
  zaloUid: string | null;
}

export interface DetectedGroup {
  level: DuplicateLevel;
  confidence: number;
  contactIds: string[]; // sorted ascending, length >= 2
}

const NAME_FUZZY_MIN_LEN = 5; // BR-0003
const NAME_FUZZY_MAX_DIST = 2; // BR-0003
const NAME_FUZZY_HARD_CAP_CONTACTS = 20_000; // EC-0009

// ── Union-Find (Disjoint-Set Union) ─────────────────────────────────────────
// Used to consolidate pairs into transitive groups. Standard path-compression
// + union-by-rank implementation.
export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.add(x);
      return x;
    }
    // Iterative path-compression: walk up to the root, then point every node
    // we visited directly at the root.
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      cur = this.parent.get(cur) as string;
    }
    const root = cur;
    let node = x;
    while (this.parent.get(node) !== root) {
      const next = this.parent.get(node) as string;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rkA = this.rank.get(ra) ?? 0;
    const rkB = this.rank.get(rb) ?? 0;
    if (rkA < rkB) {
      this.parent.set(ra, rb);
    } else if (rkA > rkB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rkA + 1);
    }
  }

  /** Return every set with ≥ 2 members, each as a sorted id array. */
  groups(): string[][] {
    const buckets = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const arr = buckets.get(root);
      if (arr) arr.push(id);
      else buckets.set(root, [id]);
    }
    const result: string[][] = [];
    for (const arr of buckets.values()) {
      if (arr.length >= 2) {
        arr.sort();
        result.push(arr);
      }
    }
    return result;
  }
}

// ── Detectors ───────────────────────────────────────────────────────────────

/** BR-0003: contacts with same normalized phone → confidence 1.0. */
export function detectPhoneGroups(contacts: ContactRow[]): DetectedGroup[] {
  const byPhone = new Map<string, string[]>();
  for (const c of contacts) {
    const normalized = normalizePhone(c.phone);
    if (!normalized) continue;
    const arr = byPhone.get(normalized);
    if (arr) arr.push(c.id);
    else byPhone.set(normalized, [c.id]);
  }
  const groups: DetectedGroup[] = [];
  for (const ids of byPhone.values()) {
    if (ids.length >= 2) {
      ids.sort();
      groups.push({ level: 'phone_exact', confidence: 1.0, contactIds: ids });
    }
  }
  return groups;
}

/** BR-0003: contacts with same non-null zaloUid → confidence 1.0. */
export function detectUidGroups(contacts: ContactRow[]): DetectedGroup[] {
  const byUid = new Map<string, string[]>();
  for (const c of contacts) {
    const uid = c.zaloUid?.trim();
    if (!uid) continue;
    const arr = byUid.get(uid);
    if (arr) arr.push(c.id);
    else byUid.set(uid, [c.id]);
  }
  const groups: DetectedGroup[] = [];
  for (const ids of byUid.values()) {
    if (ids.length >= 2) {
      ids.sort();
      groups.push({ level: 'zaloUid_exact', confidence: 1.0, contactIds: ids });
    }
  }
  return groups;
}

/**
 * BR-0003: normalized name equal OR Levenshtein ≤ 2 (when length ≥ 5).
 * Confidence: 0.9 (exact match) → 0.6 (distance 2). Distance 1 → 0.75.
 *
 * EC-0009: bucket by length (±2) before pairing so we don't pay O(n²) on the
 * full population. Skip entirely if contacts > 20k.
 */
export function detectNameGroups(
  contacts: ContactRow[],
): { groups: DetectedGroup[]; skipped: boolean } {
  if (contacts.length > NAME_FUZZY_HARD_CAP_CONTACTS) {
    return { groups: [], skipped: true };
  }

  // Normalize once, drop empties (≤ 2 chars after normalize)
  const normalized: { id: string; name: string }[] = [];
  for (const c of contacts) {
    const name = normalizeName(c.fullName);
    if (!name) continue;
    normalized.push({ id: c.id, name });
  }

  // Index by length so we only compare names whose length is within ±2.
  const byLen = new Map<number, { id: string; name: string }[]>();
  for (const row of normalized) {
    const arr = byLen.get(row.name.length);
    if (arr) arr.push(row);
    else byLen.set(row.name.length, [row]);
  }

  const uf = new UnionFind();
  // Track best (lowest) edit distance per merged pair for confidence calc.
  const pairBestDistance = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // Iterate each row; compare against rows in buckets [len-2, len-1, len, len+1, len+2]
  // (each pair only inspected once thanks to the candidate.id > row.id guard).
  for (const row of normalized) {
    for (let dl = -2; dl <= 2; dl++) {
      const bucket = byLen.get(row.name.length + dl);
      if (!bucket) continue;
      for (const cand of bucket) {
        if (cand.id <= row.id) continue;
        // Exact match counts as fuzzy with confidence 0.9 (BR-0003).
        if (cand.name === row.name) {
          // Need ≥ 5 chars only for fuzzy edits — exact-match name fuzzy is
          // still useful even at 3-4 chars, but BR-0002 already filters ≤ 2.
          uf.union(row.id, cand.id);
          const k = pairKey(row.id, cand.id);
          if (!pairBestDistance.has(k) || pairBestDistance.get(k)! > 0) {
            pairBestDistance.set(k, 0);
          }
          continue;
        }
        // Edit-distance fuzzy requires length ≥ 5 to avoid false-positives
        // on very short names ("Ha" vs "Hi" etc.).
        if (row.name.length < NAME_FUZZY_MIN_LEN && cand.name.length < NAME_FUZZY_MIN_LEN) {
          continue;
        }
        const dist = levenshtein(row.name, cand.name, NAME_FUZZY_MAX_DIST);
        if (dist <= NAME_FUZZY_MAX_DIST) {
          uf.union(row.id, cand.id);
          const k = pairKey(row.id, cand.id);
          if (!pairBestDistance.has(k) || pairBestDistance.get(k)! > dist) {
            pairBestDistance.set(k, dist);
          }
        }
      }
    }
  }

  // Pick a confidence per group: best (lowest) pairwise distance inside the
  // group → highest confidence. 0 → 0.9, 1 → 0.75, 2 → 0.6.
  const distanceToConfidence: Record<number, number> = { 0: 0.9, 1: 0.75, 2: 0.6 };
  const groups: DetectedGroup[] = [];
  for (const ids of uf.groups()) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = pairBestDistance.get(pairKey(ids[i], ids[j]));
        if (d !== undefined && d < best) best = d;
      }
    }
    const confidence =
      best === Number.POSITIVE_INFINITY
        ? 0.6
        : distanceToConfidence[best] ?? 0.6;
    groups.push({ level: 'name_fuzzy', confidence, contactIds: ids });
  }
  return { groups, skipped: false };
}

/** Convenience: run the requested detectors and collect groups. */
export function detectAll(
  contacts: ContactRow[],
  levels: DuplicateLevel[],
): { groups: DetectedGroup[]; nameSkipped: boolean } {
  const groups: DetectedGroup[] = [];
  let nameSkipped = false;
  if (levels.includes('phone_exact')) {
    groups.push(...detectPhoneGroups(contacts));
  }
  if (levels.includes('zaloUid_exact')) {
    groups.push(...detectUidGroups(contacts));
  }
  if (levels.includes('name_fuzzy')) {
    const { groups: nameGroups, skipped } = detectNameGroups(contacts);
    nameSkipped = skipped;
    if (!skipped) groups.push(...nameGroups);
  }
  return { groups, nameSkipped };
}
