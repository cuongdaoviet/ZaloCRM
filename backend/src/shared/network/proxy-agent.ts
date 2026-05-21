/**
 * Feature 0035 — Per-account proxy config (HTTP/SOCKS5).
 *
 * Helpers for proxy URL handling:
 *   - validateAndNormalizeProxyUrl: backend-authoritative validation (BR-0003)
 *     + normalization (socks -> socks5, strip trailing slash) per BR-0002.
 *   - maskProxyUrl: hide credentials when logging (BR-0010).
 *   - buildProxyAgent: dynamically import the right agent (HTTPS or SOCKS)
 *     and return an instance suitable for passing into a Node http(s) client
 *     (e.g. zca-js Zalo constructor's `agent` option). BR-0006.
 *
 * Why dynamic import: agent packages are CommonJS-only at runtime and pulling
 * them into the static import graph forces them onto the cold-start path even
 * when no account uses a proxy. Dynamic import keeps the no-proxy path zero-cost.
 */
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

/**
 * Accept four schemes. The capture group exists so the regex doubles
 * as a credentials matcher in `maskProxyUrl`.
 *
 * Matches:
 *   http://[user:pass@]host[:port][/]
 *   https://[user:pass@]host[:port][/]
 *   socks://[user:pass@]host[:port][/]
 *   socks5://[user:pass@]host[:port][/]
 *
 * `host` accepts hostnames, IPv4, and IPv6 in bracket form (`[::1]`).
 * Port is optional (some HTTP proxies use scheme default).
 */
const PROXY_URL_REGEX =
  /^(https?|socks5?):\/\/(?:([^@/:\s]+(?::[^@/\s]*)?)@)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.\-_]+)(?::(\d{1,5}))?\/?$/i;

export interface ProxyValidationResult {
  valid: boolean;
  /** Normalized URL (socks->socks5, trailing slash stripped). Only present when valid. */
  normalized?: string | null;
  /** Error code, suitable for response payload. */
  code?: 'invalid_proxy_format';
}

/**
 * Validate a proxy URL and return its normalized form.
 *
 * Returns `{ valid: true, normalized: null }` for empty/null/undefined input -
 * caller should interpret that as "clear the field" (BR-0001 + AC-0004).
 */
export function validateAndNormalizeProxyUrl(
  input: string | null | undefined,
): ProxyValidationResult {
  if (input === null || input === undefined) {
    return { valid: true, normalized: null };
  }
  if (typeof input !== 'string') {
    return { valid: false, code: 'invalid_proxy_format' };
  }
  const trimmed = input.trim();
  if (trimmed === '') {
    return { valid: true, normalized: null };
  }

  const match = PROXY_URL_REGEX.exec(trimmed);
  if (!match) {
    return { valid: false, code: 'invalid_proxy_format' };
  }

  // Ports limited to 1-65535. Regex already constrains to 1-5 digits.
  const portStr = match[4];
  if (portStr) {
    const port = Number.parseInt(portStr, 10);
    if (port < 1 || port > 65535) {
      return { valid: false, code: 'invalid_proxy_format' };
    }
  }

  // Normalize: socks -> socks5, strip trailing slash, lowercase scheme.
  let normalized = trimmed.replace(/\/$/, '');
  normalized = normalized.replace(/^socks:\/\//i, 'socks5://');
  normalized = normalized.replace(
    /^(https?|socks5):\/\//i,
    (_m, scheme: string) => `${scheme.toLowerCase()}://`,
  );

  return { valid: true, normalized };
}

/**
 * Mask `user:pass` segment for safe logging (BR-0010).
 * `socks5://user:pass@10.0.0.1:1080` -> `socks5://***@10.0.0.1:1080`
 *
 * If parsing fails (shouldn't happen for stored values, but defensively),
 * return a fully redacted placeholder rather than risk leaking the raw string.
 */
export function maskProxyUrl(url: string | null | undefined): string {
  if (!url) return '<none>';
  const m = PROXY_URL_REGEX.exec(url.trim());
  if (!m) return '<redacted-invalid>';
  const scheme = m[1].toLowerCase();
  const creds = m[2];
  const host = m[3];
  const port = m[4];
  const credsPart = creds ? '***@' : '';
  const portPart = port ? `:${port}` : '';
  return `${scheme}://${credsPart}${host}${portPart}`;
}

/**
 * Build a proxy agent suitable for Node http(s) clients.
 *
 * Returns:
 *   - `undefined` when no proxy is configured (BR-0001 default behavior).
 *   - `HttpsProxyAgent` instance for `http://` / `https://` URLs.
 *   - `SocksProxyAgent` instance for `socks5://` URLs (BR-0006).
 *
 * Caller passes the result into zca-js's `Zalo({ agent })` option.
 *
 * NOTE on EC-0006 (zca-js limitation): zca-js's published types accept
 * `agent` on the Zalo constructor for the main socket. It may not be
 * applied uniformly to every internal HTTP call (e.g. webhook callbacks).
 * Phase 1 guarantees proxy use for login + main socket only.
 */
export function buildProxyAgent(proxyUrl: string | null | undefined): unknown {
  if (!proxyUrl) return undefined;
  const trimmed = proxyUrl.trim();
  if (!trimmed) return undefined;

  if (/^socks5?:\/\//i.test(trimmed)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SocksProxyAgent } = nodeRequire('socks-proxy-agent') as {
      SocksProxyAgent: new (url: string) => unknown;
    };
    return new SocksProxyAgent(trimmed);
  }

  if (/^https?:\/\//i.test(trimmed)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HttpsProxyAgent } = nodeRequire('https-proxy-agent') as {
      HttpsProxyAgent: new (url: string) => unknown;
    };
    return new HttpsProxyAgent(trimmed);
  }

  // Should never reach: validateAndNormalizeProxyUrl is the gate. Return
  // undefined defensively (fail-closed = no fallback to direct on bad input).
  return undefined;
}

/**
 * Strip `proxyUrl` from a list of account objects when the caller is not
 * Owner/Admin (BR-0005). Used by GET endpoints to enforce permission boundary.
 *
 * Returns a new array of new objects - never mutates the input.
 */
export function stripProxyUrlForRole<T extends { proxyUrl?: string | null }>(
  items: readonly T[],
  role: string,
): Array<T | Omit<T, 'proxyUrl'>> {
  if (isAdminRole(role)) {
    return items.map((item) => ({ ...item }));
  }
  return items.map((item) => {
    const { proxyUrl: _omit, ...rest } = item;
    return rest;
  });
}

export function stripProxyUrlSingle<T extends { proxyUrl?: string | null }>(
  item: T,
  role: string,
): Omit<T, 'proxyUrl'> | T {
  if (isAdminRole(role)) return { ...item };
  const { proxyUrl: _omit, ...rest } = item;
  return rest;
}

export function isAdminRole(role: string | undefined | null): boolean {
  return role === 'owner' || role === 'admin';
}
