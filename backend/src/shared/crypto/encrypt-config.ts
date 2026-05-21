/**
 * AES-256-GCM helper for sensitive per-org config (e.g. AI provider API keys).
 *
 * Why a dedicated helper instead of the existing `encryptionKey` config?
 *   - `encryptionKey` is 16 bytes (legacy). AES-256-GCM needs 32 bytes.
 *   - We want a deterministic per-org sub-key derived from a single master so
 *     that DB rows can be re-encrypted in bulk during a future key rotation
 *     without leaking which orgs share keys.
 *
 * Format on disk: { cipher, iv, tag } — all hex strings. We store the three
 * fields in separate columns (`api_key_cipher`, `api_key_iv`, `api_key_tag`)
 * so the schema is self-documenting and we don't accidentally treat the
 * blob as a single opaque string.
 *
 * Master key: `config.aiConfigMasterKey` — 64 hex chars (32 bytes).
 * Per-org sub-key: HKDF-derived using orgId as salt+info.
 *
 * Feature 0044 — dual-key read window. When
 * `config.aiConfigMasterKeyPrevious` is set, `decryptForOrg` first tries the
 * current key, then falls back to the previous key. Encrypt ALWAYS uses the
 * current key. This makes rotation a graceful procedure (deploy new env,
 * re-encrypt in batches via the CLI, then drop the previous env var).
 *
 * IMPORTANT: maskApiKey() is the ONLY function that should ever produce a
 * string with parts of a key in it for logs. The decrypt() result MUST NOT
 * be logged, ever. See BR-0013.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../../config/index.js';
import { logger } from '../utils/logger.js';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // bytes — AES-256
const IV_LEN = 12; // bytes — 96-bit IV recommended for GCM
const TAG_LEN = 16; // bytes — GCM auth tag

/**
 * Placeholder master key — production startup MUST refuse to run when the
 * env var is missing/default. Tests and dev may use it.
 */
const PLACEHOLDER_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

export interface EncryptedBlob {
  cipher: string; // hex
  iv: string; // hex
  tag: string; // hex
}

/**
 * Validate that a master key string is exactly 64 hex chars (32 bytes).
 * Throws with the same message the original helper produced (kept stable so
 * existing tests still pass — see unit tests).
 */
function validateMasterKey(masterHex: string): void {
  if (!HEX64_RE.test(masterHex)) {
    throw new Error(
      'AI_CONFIG_MASTER_KEY must be 64 hex chars (32 bytes). Generate with `openssl rand -hex 32`.',
    );
  }
}

/**
 * Internal: derive an org sub-key from a specific master-key hex string.
 * Used by both the current and the previous (fallback) decrypt paths.
 */
function deriveOrgKeyFromMaster(orgId: string, masterHex: string): Buffer {
  validateMasterKey(masterHex);
  const master = Buffer.from(masterHex, 'hex');
  // hkdfSync returns ArrayBuffer; wrap with Buffer.from for downstream use.
  const derived = hkdfSync(
    'sha256',
    master,
    Buffer.from(orgId, 'utf8'),
    Buffer.from('ai-config-v1', 'utf8'),
    KEY_LEN,
  );
  return Buffer.from(derived);
}

/**
 * Derive a per-org 32-byte key from the CURRENT master key using HKDF-SHA-256.
 * orgId acts as both salt and info — different orgs get unrelated keys, and
 * the same org always derives the same key (so we can decrypt later).
 */
function deriveOrgKey(orgId: string): Buffer {
  return deriveOrgKeyFromMaster(orgId, config.aiConfigMasterKey);
}

/**
 * Encrypt plaintext for the given org. Returns hex blob fields.
 * Throws if the master key is missing/malformed.
 *
 * BR-0003: encrypt path ALWAYS uses the current key. Never the previous.
 */
export function encryptForOrg(orgId: string, plaintext: string): EncryptedBlob {
  const key = deriveOrgKey(orgId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    cipher: enc.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Internal: attempt to decrypt a blob using a specific org sub-key. Throws
 * on any failure (auth-tag mismatch, invalid lengths, …). Callers wrap this
 * in try/catch to implement the dual-key fallback.
 */
function decryptWithKey(blob: EncryptedBlob, key: Buffer): string {
  const iv = Buffer.from(blob.iv, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  if (iv.length !== IV_LEN) throw new Error('Invalid IV length');
  if (tag.length !== TAG_LEN) throw new Error('Invalid GCM tag length');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([
    decipher.update(Buffer.from(blob.cipher, 'hex')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/**
 * Decrypt a blob for the given org. Throws on auth-tag mismatch (= tampered
 * ciphertext or wrong key).
 *
 * Feature 0044 BR-0002 — dual-key fallback:
 *   1. Try the current key. If it works → return plaintext.
 *   2. If the current key fails AND `aiConfigMasterKeyPrevious` is set,
 *      try that. Success → log info + return plaintext.
 *   3. If neither key works → throw (genuine tamper / wrong env / corrupt blob).
 */
export function decryptForOrg(orgId: string, blob: EncryptedBlob): string {
  if (!blob.cipher || !blob.iv || !blob.tag) {
    throw new Error('Empty encrypted blob');
  }
  const currentKey = deriveOrgKey(orgId);
  try {
    return decryptWithKey(blob, currentKey);
  } catch (currentErr) {
    const previousHex = config.aiConfigMasterKeyPrevious;
    if (!previousHex) {
      throw currentErr;
    }
    try {
      const previousKey = deriveOrgKeyFromMaster(orgId, previousHex);
      const plain = decryptWithKey(blob, previousKey);
      // BR-0002: log info (not error) when fallback succeeds. Operator's
      // signal that the CLI rotation hasn't re-encrypted this row yet.
      // We never log the plaintext or the org sub-key, only the orgId.
      logger.info(
        `[crypto] decrypted with previous key, re-encrypt pending (org=${orgId})`,
      );
      return plain;
    } catch {
      // Both keys failed → genuine tamper / wrong env / corrupt blob. Re-
      // throw the ORIGINAL current-key error so the caller stack trace is
      // not misleading.
      throw currentErr;
    }
  }
}

/**
 * Feature 0044 — predicate used by the rotation CLI. Returns true iff the
 * blob decrypts CLEANLY with the CURRENT master key (no fallback). Used to
 * decide skip-vs-rewrite during idempotent re-encryption (BR-0007).
 *
 * Never throws. An empty/malformed blob returns `false`.
 */
export function isCurrentlyEncrypted(
  orgId: string,
  blob: EncryptedBlob,
): boolean {
  if (!blob || !blob.cipher || !blob.iv || !blob.tag) return false;
  try {
    const key = deriveOrgKey(orgId);
    decryptWithKey(blob, key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time equality on hex blobs. Used by tests to assert that two
 * cipher outputs differ for the same plaintext (random IV → different cipher).
 */
export function blobEquals(a: EncryptedBlob, b: EncryptedBlob): boolean {
  try {
    return (
      timingSafeEqual(Buffer.from(a.cipher, 'hex'), Buffer.from(b.cipher, 'hex')) &&
      timingSafeEqual(Buffer.from(a.iv, 'hex'), Buffer.from(b.iv, 'hex')) &&
      timingSafeEqual(Buffer.from(a.tag, 'hex'), Buffer.from(b.tag, 'hex'))
    );
  } catch {
    return false;
  }
}

/**
 * Mask an API key for safe logging. Keeps prefix and last 4 chars so the
 * operator can correlate with whatever they pasted, but the middle is
 * scrubbed.  See BR-0013.
 *
 *   sk-ant-api03-AAAAA…ZZZZ → sk-ant-***ZZZZ
 *   short                   → ***
 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '***';
  const dashIdx = key.indexOf('-');
  // Keep "sk-ant-" / "sk-" / "" up to second dash, plus last 4 chars.
  let prefix = '';
  if (dashIdx >= 0 && dashIdx <= 4) {
    const second = key.indexOf('-', dashIdx + 1);
    prefix = second > 0 ? key.slice(0, second + 1) : key.slice(0, dashIdx + 1);
  } else {
    prefix = key.slice(0, 2);
  }
  const tail = key.slice(-4);
  return `${prefix}***${tail}`;
}

/**
 * Feature 0038 — alias of `maskApiKey` for non-API-key secrets (Telegram bot
 * tokens, OAuth refresh tokens). Same masking strategy applies: keep enough
 * prefix to correlate, scrub the middle, keep last 4 chars.
 *
 *   1234567890:ABCDEF…xyz → 123456***xyz
 *   undefined / empty     → <empty>
 *   short (≤ 8 chars)     → ***
 */
export function maskSecret(secret: string | null | undefined): string {
  if (secret === undefined || secret === null || secret === '') return '<empty>';
  return maskApiKey(secret);
}

// ─── Feature 0038 — Integration Hub config encryption shims ──────────────────
// Same primitive (AES-256-GCM via HKDF-derived per-org key), but with the
// `{configCipher,configIv,configTag}` field naming the `Integration` model uses
// and a JSON-stringify step so callers can pass arbitrary config objects.
// ─────────────────────────────────────────────────────────────────────────────
export interface ConfigBlob {
  configCipher: string;
  configIv: string;
  configTag: string;
}

export function encryptConfig(orgId: string, config: unknown): ConfigBlob {
  const blob = encryptForOrg(orgId, JSON.stringify(config));
  return { configCipher: blob.cipher, configIv: blob.iv, configTag: blob.tag };
}

export function decryptConfig(orgId: string, blob: ConfigBlob): unknown {
  const plain = decryptForOrg(orgId, {
    cipher: blob.configCipher,
    iv: blob.configIv,
    tag: blob.configTag,
  });
  return JSON.parse(plain);
}

/**
 * Boot-time guard. Call from app.ts before listening. Refuses to start in
 * production when the master key is missing or the placeholder.
 *
 * Feature 0044 BR-0004 — additionally refuses to start (any env) when
 * `AI_CONFIG_MASTER_KEY` and `AI_CONFIG_MASTER_KEY_PREVIOUS` are BOTH set
 * to the same value. That's a near-certain misconfig signal (operator typo
 * during rotation) and would silently neutralise the rotation procedure.
 */
export function assertAiMasterKey(): void {
  const key = config.aiConfigMasterKey;
  const previous = config.aiConfigMasterKeyPrevious;
  if (!key || key === PLACEHOLDER_KEY) {
    if (config.isProduction) {
      throw new Error(
        'AI_CONFIG_MASTER_KEY is unset or the placeholder. Generate one with `openssl rand -hex 32` and set it in the environment.',
      );
    }
  } else if (!HEX64_RE.test(key)) {
    throw new Error(
      'AI_CONFIG_MASTER_KEY must be exactly 64 hex chars (32 bytes).',
    );
  }
  // BR-0004 — identical-keys footgun guard. Applies in every env so the dev
  // accidentally copy-pasting the same value into both vars during testing
  // gets the same fast failure prod operators do.
  if (previous && previous === key) {
    throw new Error(
      'AI_CONFIG_MASTER_KEY and AI_CONFIG_MASTER_KEY_PREVIOUS must differ. ' +
        'During rotation the previous key holds the OLD secret while the ' +
        'current key holds the NEW one. Setting them identical neutralises ' +
        'the rotation procedure.',
    );
  }
  // If the previous key is set, it must also be a valid 64-hex string (or
  // unset). Garbage in this var would silently kill the fallback path.
  if (previous && !HEX64_RE.test(previous)) {
    throw new Error(
      'AI_CONFIG_MASTER_KEY_PREVIOUS must be 64 hex chars (32 bytes) or unset.',
    );
  }
}
