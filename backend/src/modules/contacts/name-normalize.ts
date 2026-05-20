/**
 * Name normalization for duplicate detection (feature 0018, BR-0002).
 *
 * Returns a lower-cased, diacritic-stripped, whitespace-collapsed name suitable
 * for fuzzy equality / Levenshtein comparison. Empty / very short names (≤ 2
 * chars) yield an empty string so the caller can skip them from the fuzzy
 * stage.
 *
 * Rules:
 * - trim + lowercase
 * - Normalize to NFD then drop combining marks (Vietnamese tone & vowel marks)
 * - Map đ/Đ → d explicitly (NFD doesn't decompose these)
 * - Collapse runs of whitespace to a single space
 * - Length ≤ 2 after normalization → return ''
 */

export function normalizeName(raw: string | null | undefined): string {
  if (raw == null) return '';
  const lowered = String(raw).trim().toLowerCase();
  if (!lowered) return '';

  // Replace Vietnamese đ explicitly (it isn't decomposed by NFD)
  const dStripped = lowered.replace(/đ/g, 'd');

  // NFD decomposes "ế" into "e" + tone mark; range U+0300..U+036F covers
  // every combining diacritic that appears in Vietnamese text.
  const noDiacritics = dStripped
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  // Collapse internal whitespace
  const collapsed = noDiacritics.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= 2) return '';
  return collapsed;
}
