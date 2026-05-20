/**
 * Pure helpers for the CRM tags module — feature 0019.
 *
 * Kept side-effect free so unit tests can run without Prisma / Fastify.
 *
 * Case-folding contract: `normalizedName = name.trim().normalize('NFC').toLowerCase()`.
 * Two display names "VIP" and "vip" produce the SAME normalizedName, which the
 * unique constraint `(orgId, normalizedName)` then rejects with a clean 409.
 */

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const TAG_NAME_MAX = 50;

/** Trim, NFC-normalize, and lowercase a tag name for uniqueness lookups. */
export function normalizeName(raw: string): string {
  return raw.trim().normalize('NFC').toLowerCase();
}

/** Hex `#RRGGBB` validator (does NOT accept shorthand `#RGB`). */
export function validateColor(color: string): boolean {
  return typeof color === 'string' && HEX_COLOR_RE.test(color);
}

/**
 * Validate a raw tag name. Returns the cleaned display name and its normalized
 * form on success, or a Vietnamese error message on failure.
 *
 * Rules:
 * - 1 .. 50 chars after `.trim()`
 * - Must contain at least one non-whitespace character
 */
export function validateTagName(
  name: unknown,
):
  | { ok: true; display: string; normalized: string }
  | { ok: false; error: string } {
  if (typeof name !== 'string') {
    return { ok: false, error: 'Tên nhãn phải là chuỗi' };
  }
  const display = name.trim();
  if (display.length < 1) {
    return { ok: false, error: 'Tên nhãn không được để trống' };
  }
  if (display.length > TAG_NAME_MAX) {
    return { ok: false, error: `Tên nhãn tối đa ${TAG_NAME_MAX} ký tự` };
  }
  const normalized = normalizeName(display);
  if (normalized.length < 1) {
    return { ok: false, error: 'Tên nhãn không được để trống' };
  }
  return { ok: true, display, normalized };
}
