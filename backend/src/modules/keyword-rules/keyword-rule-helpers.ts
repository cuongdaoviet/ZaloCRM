/**
 * Pure helpers for keyword auto-tag rules — feature 0009.
 */

const STATUS_RANK: Record<string, number> = {
  lost: 0,
  new: 1,
  contacted: 2,
  interested: 3,
  converted: 4,
};

const VALID_STATUSES = new Set(['new', 'contacted', 'interested', 'converted', 'lost']);

export interface ValidatedRule {
  name: string;
  enabled: boolean;
  keywords: string[];
  addTag: string | null;
  setStatus: string | null;
  assignToUserId: string | null;
}

/**
 * Validate POST/PUT body. Returns cleaned input or 400-friendly error.
 * At least one action must be set (otherwise the rule is a no-op).
 */
export function validateRuleInput(
  body: unknown,
): { ok: true; value: ValidatedRule } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body không hợp lệ' };
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 200) {
    return { ok: false, error: 'name phải dài 1-200 ký tự' };
  }

  const enabled = b.enabled === undefined ? true : Boolean(b.enabled);

  if (!Array.isArray(b.keywords)) {
    return { ok: false, error: 'keywords phải là mảng' };
  }
  const keywords = (b.keywords as unknown[])
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keywords.length === 0) {
    return { ok: false, error: 'keywords không được rỗng' };
  }
  if (keywords.some((k) => k.length > 200)) {
    return { ok: false, error: 'mỗi keyword không quá 200 ký tự' };
  }

  const addTag = optionalString(b.addTag);
  const setStatus = optionalString(b.setStatus);
  const assignToUserId = optionalString(b.assignToUserId);

  if (setStatus !== null && !VALID_STATUSES.has(setStatus)) {
    return { ok: false, error: `setStatus không hợp lệ: ${setStatus}` };
  }

  if (addTag === null && setStatus === null && assignToUserId === null) {
    return {
      ok: false,
      error: 'Phải có ít nhất 1 action (addTag, setStatus, assignToUserId)',
    };
  }

  return {
    ok: true,
    value: { name, enabled, keywords, addTag, setStatus, assignToUserId },
  };
}

function optionalString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Return the first keyword found inside `content` (case-insensitive substring).
 * Returns the matched keyword as stored (not the source casing) so callers
 * can write a stable ledger row.
 */
export function matchKeywords(content: string | null | undefined, keywords: string[]): string | null {
  if (!content) return null;
  const lower = content.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

/**
 * Should we overwrite `current` status with `target`? Only when target is
 * "higher" in the pipeline — never downgrade a converted/interested contact
 * back to new just because they sent a new-customer-style keyword later.
 */
export function shouldUpgradeStatus(
  current: string | null | undefined,
  target: string,
): boolean {
  const currentRank = current ? (STATUS_RANK[current] ?? -1) : -1;
  const targetRank = STATUS_RANK[target] ?? -1;
  return targetRank > currentRank;
}
