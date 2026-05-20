/**
 * Pure helpers for feature 0016 — per-user preferences.
 * Side-effect free so they can be unit-tested without booting Fastify or
 * hitting the DB.
 */

/**
 * Allowed preference keys. Validation is by allowlist (not value shape) so
 * arbitrary JSON payloads can be stored — we just gate which keys are even
 * writable. Add to this list when the frontend wants a new preference.
 */
export const ALLOWED_KEYS: readonly string[] = [
  'ui.theme',
  'ui.density',
  'ui.sidebar_collapsed',
  'ui.sound_on',
  'chat.default_account_filter',
  // Feature 0022 — Conversation filters (chip-row state persisted per user)
  'chat.conversation_filters',
  'contacts.last_filter',
  'dashboard.refresh_interval',
];

/**
 * snake_case dotted namespaces — e.g. `ui.theme`, `chat.default_account_filter`.
 * Each segment must start with a lowercase letter and contain only [a-z0-9_].
 */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Cap on the JSON-stringified value length. Big payloads belong in their own
 * table, not the KV store.
 */
export const VALUE_MAX_CHARS = 4096;

/**
 * Validate a preference key. Returns `null` on success or a Vietnamese error
 * message on failure. Two failure modes:
 *  - Key doesn't match `KEY_RE` (malformed key)
 *  - Key matches but isn't in `ALLOWED_KEYS` (typo guard / explicit allowlist)
 */
export function validateKey(key: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0) {
    return 'Key không hợp lệ';
  }
  if (!KEY_RE.test(key)) {
    return 'Key không hợp lệ';
  }
  if (!ALLOWED_KEYS.includes(key)) {
    return 'Key không hợp lệ';
  }
  return null;
}

/**
 * Validate that a value (already JSON-parseable) does not exceed the size cap
 * when re-stringified. Returns `null` on success or a Vietnamese error message.
 * `undefined` and `null` are both treated as the JSON literal `null`.
 */
export function validateValueSize(value: unknown): string | null {
  let str: string;
  try {
    str = JSON.stringify(value ?? null);
  } catch {
    return 'Giá trị không phải JSON hợp lệ';
  }
  if (typeof str !== 'string') {
    // JSON.stringify can return undefined for functions/symbols; treat as invalid.
    return 'Giá trị không phải JSON hợp lệ';
  }
  if (str.length > VALUE_MAX_CHARS) {
    return `Giá trị vượt quá ${VALUE_MAX_CHARS} ký tự`;
  }
  return null;
}
