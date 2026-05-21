/**
 * SSRF (Server-Side Request Forgery) protection helper.
 *
 * Ported verbatim from ZaloCRM-3.0 `modules/integrations/providers/zapier-webhook.ts:24-35`
 * — that codebase only guarded the Zapier webhook URL. Feature 0038 lifts it
 * to a reusable utility so every user-supplied URL (Telegram apiEndpoint
 * override today, future Zapier/Slack/etc.) gets the same treatment.
 *
 * Policy (matches 3.0 behaviour):
 *   - HTTPS only — `http://` rejected.
 *   - Private RFC1918 / loopback / link-local IPs and `localhost` hostname
 *     are blocked. Hostnames that resolve to private space at DNS time are
 *     NOT caught here (a deeper guard would require DNS pinning and a custom
 *     fetch agent — out of scope for phase 1).
 *
 * Returns `{ ok: true }` on accept, `{ ok: false, error }` on reject so
 * callers can short-circuit and surface the message to the user. Never
 * throws on bad URLs — invalid input is just a soft reject.
 */

const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80:|fc00:|fd00:)/i;

export interface SsrfCheckResult {
  ok: boolean;
  error?: string;
}

export function checkUrlForSsrf(rawUrl: string | undefined): SsrfCheckResult {
  if (!rawUrl) return { ok: false, error: 'URL is required' };
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use HTTPS' };
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname)) {
    return { ok: false, error: 'URL target host is not allowed' };
  }
  return { ok: true };
}
