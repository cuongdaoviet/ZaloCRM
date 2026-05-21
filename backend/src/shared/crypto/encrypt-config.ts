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

export interface EncryptedBlob {
  cipher: string; // hex
  iv: string; // hex
  tag: string; // hex
}

/**
 * Derive a per-org 32-byte key from the master key using HKDF-SHA-256.
 * orgId acts as both salt and info — different orgs get unrelated keys, and
 * the same org always derives the same key (so we can decrypt later).
 */
function deriveOrgKey(orgId: string): Buffer {
  const masterHex = config.aiConfigMasterKey;
  if (!/^[0-9a-fA-F]{64}$/.test(masterHex)) {
    throw new Error(
      'AI_CONFIG_MASTER_KEY must be 64 hex chars (32 bytes). Generate with `openssl rand -hex 32`.',
    );
  }
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
 * Encrypt plaintext for the given org. Returns hex blob fields.
 * Throws if the master key is missing/malformed.
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
 * Decrypt a blob for the given org. Throws on auth-tag mismatch (= tampered
 * ciphertext or wrong key).
 */
export function decryptForOrg(orgId: string, blob: EncryptedBlob): string {
  if (!blob.cipher || !blob.iv || !blob.tag) {
    throw new Error('Empty encrypted blob');
  }
  const key = deriveOrgKey(orgId);
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
 */
export function assertAiMasterKey(): void {
  const key = config.aiConfigMasterKey;
  if (!key || key === PLACEHOLDER_KEY) {
    if (config.isProduction) {
      throw new Error(
        'AI_CONFIG_MASTER_KEY is unset or the placeholder. Generate one with `openssl rand -hex 32` and set it in the environment.',
      );
    }
  } else if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'AI_CONFIG_MASTER_KEY must be exactly 64 hex chars (32 bytes).',
    );
  }
}
