/**
 * Feature 0044 BR-0011..BR-0014 — proxyUrl encryption-at-rest shim.
 *
 * Wraps the shared AES-256-GCM helper (`encrypt-config.ts`) so callers in
 * `zalo-pool.ts` / `zalo-routes.ts` can encrypt/decrypt the per-account
 * proxy URL without re-deriving the per-org key themselves.
 *
 * All three columns (`proxyUrlCipher`, `proxyUrlIv`, `proxyUrlTag`) are
 * nullable. `null` across all three = no proxy configured (direct connect).
 *
 * Plaintext proxyUrl MUST NEVER appear in any log line. Use
 * `maskProxyUrl()` from `shared/network/proxy-agent.ts` for ops logs.
 */
import {
  encryptForOrg,
  decryptForOrg,
  type EncryptedBlob,
} from './encrypt-config.js';

export interface ProxyUrlCipherFields {
  proxyUrlCipher: string | null;
  proxyUrlIv: string | null;
  proxyUrlTag: string | null;
}

/**
 * Encrypt a (possibly null) plaintext proxy URL for the given org.
 * Returns the three column values to write to the DB. Passing `null` (or
 * empty string) yields three NULLs — i.e. "no proxy".
 */
export function encryptProxyUrl(
  orgId: string,
  plaintext: string | null | undefined,
): ProxyUrlCipherFields {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return { proxyUrlCipher: null, proxyUrlIv: null, proxyUrlTag: null };
  }
  const blob = encryptForOrg(orgId, plaintext);
  return {
    proxyUrlCipher: blob.cipher,
    proxyUrlIv: blob.iv,
    proxyUrlTag: blob.tag,
  };
}

/**
 * Decrypt a proxy URL from the three DB columns. Returns `null` when all
 * three columns are NULL (= no proxy). Throws when partially filled (data
 * corruption) or when decryption fails on BOTH the current and previous
 * master keys (genuine tamper / wrong env).
 */
export function decryptProxyUrl(
  orgId: string,
  fields: ProxyUrlCipherFields,
): string | null {
  const { proxyUrlCipher, proxyUrlIv, proxyUrlTag } = fields;
  if (!proxyUrlCipher && !proxyUrlIv && !proxyUrlTag) return null;
  if (!proxyUrlCipher || !proxyUrlIv || !proxyUrlTag) {
    throw new Error(
      'proxyUrl cipher/iv/tag are partially populated — corrupt row',
    );
  }
  const blob: EncryptedBlob = {
    cipher: proxyUrlCipher,
    iv: proxyUrlIv,
    tag: proxyUrlTag,
  };
  return decryptForOrg(orgId, blob);
}
