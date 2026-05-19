/**
 * Pure helpers for the quick-replies module — kept side-effect free so they
 * can be unit-tested without booting Fastify or hitting the DB.
 */

const SHORTCUT_RE = /^[a-z0-9_-]{2,20}$/;

export interface ValidatedInput {
  shortcut: string;
  content: string;
  scope: 'user' | 'org';
}

/**
 * Validate + normalize a quick-reply payload. Returns either the cleaned
 * input or a `{error, code}` to send back to the client. We force `scope`
 * to "user" when the caller is a plain member — admins/owners may opt into
 * "org" scope.
 */
export function validatePayload(
  body: unknown,
  callerRole: string,
): { ok: true; value: ValidatedInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body không hợp lệ' };
  }
  const b = body as Record<string, unknown>;

  const shortcutRaw = typeof b.shortcut === 'string' ? b.shortcut.trim().toLowerCase() : '';
  if (!SHORTCUT_RE.test(shortcutRaw)) {
    return {
      ok: false,
      error: 'shortcut chỉ chứa a-z, 0-9, -, _ (2-20 ký tự)',
    };
  }

  const content = typeof b.content === 'string' ? b.content.trim() : '';
  if (content.length < 1 || content.length > 2000) {
    return { ok: false, error: 'content phải dài 1-2000 ký tự' };
  }

  let scope: 'user' | 'org' = b.scope === 'org' ? 'org' : 'user';
  // Members can only create user-scoped templates regardless of what they ask for.
  if (scope === 'org' && !['owner', 'admin'].includes(callerRole)) {
    scope = 'user';
  }

  return { ok: true, value: { shortcut: shortcutRaw, content, scope } };
}

/**
 * Replace {{contactName}} and {{firstName}} placeholders. Missing fields are
 * substituted with the empty string so we never leak the literal `{{...}}`
 * into outgoing messages.
 */
export function substitutePlaceholders(
  content: string,
  contact: { fullName?: string | null } | null | undefined,
): string {
  const full = (contact?.fullName ?? '').trim();
  const first = full.split(/\s+/)[0] ?? '';
  return content.replace(/\{\{contactName\}\}/g, full).replace(/\{\{firstName\}\}/g, first);
}
