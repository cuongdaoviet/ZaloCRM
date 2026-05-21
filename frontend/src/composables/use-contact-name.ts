/**
 * Feature 0024 — Dual name display helpers.
 *
 * BR-0004: Primary display = `fullName` falling back to `zaloDisplayName`.
 * BR-0005: Secondary muted text = `zaloDisplayName` ONLY when:
 *          - it is non-empty AND
 *          - it differs from `fullName` (case-insensitive trim compare).
 *          Otherwise nothing is rendered.
 *
 * These rules are referenced from ConversationList row, MessageThread header,
 * and the Customer 360 detail page so the comparison stays in one place.
 */

interface ContactNameSource {
  fullName?: string | null;
  zaloDisplayName?: string | null;
}

/**
 * Returns the primary name to display (rep-owned CRM name when set,
 * Zalo display name as fallback). Caller supplies its own ultimate
 * fallback (e.g. 'Unknown' or 'Chưa có tên') for the all-null case.
 */
export function primaryContactName(c: ContactNameSource | null | undefined): string {
  if (!c) return '';
  const crm = (c.fullName ?? '').trim();
  if (crm) return crm;
  return (c.zaloDisplayName ?? '').trim();
}

/**
 * Returns the muted secondary text (the raw Zalo display name) when
 * BR-0005 triggers, or null when the secondary should be hidden.
 */
export function secondaryZaloName(c: ContactNameSource | null | undefined): string | null {
  if (!c) return null;
  const zalo = (c.zaloDisplayName ?? '').trim();
  if (!zalo) return null;
  const crm = (c.fullName ?? '').trim();
  // No fullName set → primary already falls back to zalo, so secondary
  // would just duplicate. Hide it.
  if (!crm) return null;
  // Case-insensitive compare so "Anh Tuấn" and "ANH TUẤN" collapse.
  if (crm.toLocaleLowerCase() === zalo.toLocaleLowerCase()) return null;
  return zalo;
}
