/**
 * SHA-256 hashing helper for public API keys — Feature 0046 BR-0013..BR-0016.
 *
 * Public API keys are opaque random tokens (`zcrm_<48hex>`). Before this
 * feature they were stored verbatim in `app_settings.value_plain`; a DB
 * dump (backup leak, replica scrape, malicious DBA) gave an attacker
 * working credentials. After this feature we store the SHA-256 hash —
 * the DB row alone is no longer a credential.
 *
 * Why SHA-256 and not bcrypt/argon2: API keys are 24-byte random tokens
 * (192 bits of entropy). Brute-force is infeasible regardless of hash
 * function, so the only thing a slow hash buys us is lookup latency on
 * every request. The DB lookup already iterates O(N) rows in
 * apiKeyAuth() — keep the per-row work tiny.
 *
 * Constant-time compare: see verifyApiKeyHash() — uses
 * `crypto.timingSafeEqual` to avoid leaking which org's hash the
 * attacker is one byte closer to.
 *
 * Lazy migration: see apiKeyAuth() in modules/api/public-api-routes.ts.
 * Any `value_plain` that is NOT a 64-char hex string is treated as
 * legacy plaintext; on first successful match the row is rewritten
 * with the hash.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Matches the output of `sha256().digest('hex')` — 64 lowercase hex chars. */
const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Hash a public API key with SHA-256, returning a 64-char lowercase hex
 * string. Pure function — same input always yields the same output.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * True when `value` looks like an already-hashed entry (64 hex chars).
 * Used by the lazy-migration logic in apiKeyAuth() — anything that
 * fails this test is treated as legacy plaintext and rewritten with
 * the hash on first successful match.
 *
 * Why 64-char hex specifically and not "anything that hashApiKey()
 * could have produced": collisions exist (a user could theoretically
 * pick a 48-char hex API key prefix → not 64 chars → still treated
 * as legacy correctly). The token format is `zcrm_<48 hex chars>` =
 * 53 chars total, so a 64-char hex collision is structurally
 * impossible for keys we generate.
 */
export function isHashedApiKey(value: string): boolean {
  return HEX64_RE.test(value);
}

/**
 * Constant-time equality check between two hex hashes. Returns false on
 * length mismatch (no exception) so callers can use it inline.
 *
 * Both inputs must be hex strings of the SAME length — passing the raw
 * API key here is a bug because the comparator would never match a
 * hash. The helper is intentionally narrow: hash-vs-hash only.
 */
export function verifyApiKeyHash(hashA: string, hashB: string): boolean {
  if (hashA.length !== hashB.length) return false;
  // timingSafeEqual requires equal-length Buffers; throws if not.
  try {
    return timingSafeEqual(Buffer.from(hashA, 'hex'), Buffer.from(hashB, 'hex'));
  } catch {
    // Non-hex input → not a match. Fail closed.
    return false;
  }
}
