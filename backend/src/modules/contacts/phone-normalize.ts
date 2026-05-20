/**
 * Phone number normalization for duplicate detection (feature 0018, BR-0001).
 *
 * Returns the canonical form (digits only, country-code prefixed) suitable for
 * exact-match grouping, or null if the input can't be normalized to a usable
 * Vietnamese phone number.
 *
 * Rules:
 * - Strip whitespace, +, -, ., (, )
 * - "0" + 9 digits (10 digit local) → "84" + last 9 digits
 * - "+84..." → "84..."
 * - Already "84..." → unchanged
 * - Anything else → as-is IF all digits AND length >= 9; otherwise null
 * - Non-digits remaining after strip → null
 * - Length < 9 → null
 */

export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Strip whitespace and common formatting separators
  const stripped = trimmed.replace(/[\s+\-.()]/g, '');
  if (!stripped) return null;

  // Must be all digits at this point (after stripping + and separators)
  if (!/^\d+$/.test(stripped)) return null;

  let canonical: string;
  if (stripped.startsWith('84')) {
    canonical = stripped;
  } else if (stripped.startsWith('0') && stripped.length === 10) {
    canonical = '84' + stripped.slice(1);
  } else {
    canonical = stripped;
  }

  if (canonical.length < 9) return null;
  return canonical;
}
