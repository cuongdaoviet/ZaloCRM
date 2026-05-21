/**
 * Unit tests for backend/src/shared/crypto/encrypt-config.ts.
 *
 * Covers round-trip, key derivation, tampering detection, IV uniqueness,
 * masking, and boot-time guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  encryptForOrg,
  decryptForOrg,
  blobEquals,
  maskApiKey,
  assertAiMasterKey,
} from '../../src/shared/crypto/encrypt-config.js';

// 64 hex chars = 32 bytes — production-shaped key for tests.
const TEST_KEY = '11'.repeat(32);

beforeEach(() => {
  process.env.AI_CONFIG_MASTER_KEY = TEST_KEY;
  // Re-import not needed because config reads env at module load; we set it
  // before importing in test runners that pass --isolate, but in our setup
  // we mutate the in-memory config below for any boot-time-guard tests.
});

describe('encrypt-config', () => {
  it('round-trips plaintext through encrypt/decrypt for the same org', async () => {
    const { config } = await import('../../src/config/index.js');
    (config as { aiConfigMasterKey: string }).aiConfigMasterKey = TEST_KEY;
    const blob = encryptForOrg('org-1', 'sk-ant-secret');
    expect(blob.cipher).not.toBe('');
    expect(decryptForOrg('org-1', blob)).toBe('sk-ant-secret');
  });

  it('produces a fresh IV+cipher for the same plaintext (no determinism)', async () => {
    const { config } = await import('../../src/config/index.js');
    (config as { aiConfigMasterKey: string }).aiConfigMasterKey = TEST_KEY;
    const a = encryptForOrg('org-1', 'hello');
    const b = encryptForOrg('org-1', 'hello');
    expect(blobEquals(a, b)).toBe(false);
    // But both decrypt to the same plaintext.
    expect(decryptForOrg('org-1', a)).toBe('hello');
    expect(decryptForOrg('org-1', b)).toBe('hello');
  });

  it('decrypt fails when the orgId differs (per-org sub-key)', async () => {
    const { config } = await import('../../src/config/index.js');
    (config as { aiConfigMasterKey: string }).aiConfigMasterKey = TEST_KEY;
    const blob = encryptForOrg('org-1', 'secret');
    expect(() => decryptForOrg('org-2', blob)).toThrow();
  });

  it('decrypt fails when the ciphertext is tampered with', async () => {
    const { config } = await import('../../src/config/index.js');
    (config as { aiConfigMasterKey: string }).aiConfigMasterKey = TEST_KEY;
    const blob = encryptForOrg('org-1', 'secret');
    // Flip the last byte of the cipher.
    const buf = Buffer.from(blob.cipher, 'hex');
    buf[buf.length - 1] ^= 0xff;
    const tampered = { ...blob, cipher: buf.toString('hex') };
    expect(() => decryptForOrg('org-1', tampered)).toThrow();
  });

  it('rejects an empty blob with a clear error', async () => {
    expect(() =>
      decryptForOrg('org-1', { cipher: '', iv: '', tag: '' }),
    ).toThrow(/Empty/);
  });

  it('rejects a malformed master key', async () => {
    const { config } = await import('../../src/config/index.js');
    (config as { aiConfigMasterKey: string }).aiConfigMasterKey = 'too-short';
    expect(() => encryptForOrg('org-1', 'x')).toThrow(/64 hex/);
  });

  describe('maskApiKey', () => {
    it('masks an Anthropic-style key keeping prefix + tail', () => {
      expect(maskApiKey('sk-ant-api03-AAAAABBBBBCCCCC-1234')).toBe(
        'sk-ant-***1234',
      );
    });

    it('masks an OpenAI-style key keeping prefix + tail', () => {
      expect(maskApiKey('sk-proj-AAAAABBBBBCCCCCDDDDD-9876')).toBe(
        'sk-proj-***9876',
      );
    });

    it('returns *** for short keys', () => {
      expect(maskApiKey('abc')).toBe('***');
      expect(maskApiKey('')).toBe('');
    });
  });

  describe('assertAiMasterKey', () => {
    it('throws in production when key is the placeholder', async () => {
      const { config } = await import('../../src/config/index.js');
      const original = config.isProduction;
      (config as { isProduction: boolean }).isProduction = true;
      (config as { aiConfigMasterKey: string }).aiConfigMasterKey =
        '0'.repeat(64);
      try {
        expect(() => assertAiMasterKey()).toThrow(/placeholder/i);
      } finally {
        (config as { isProduction: boolean }).isProduction = original;
      }
    });

    it('passes in dev with the placeholder key', async () => {
      const { config } = await import('../../src/config/index.js');
      (config as { isProduction: boolean }).isProduction = false;
      (config as { aiConfigMasterKey: string }).aiConfigMasterKey =
        '0'.repeat(64);
      expect(() => assertAiMasterKey()).not.toThrow();
    });

    it('rejects a non-hex master key in any env', async () => {
      const { config } = await import('../../src/config/index.js');
      (config as { isProduction: boolean }).isProduction = false;
      (config as { aiConfigMasterKey: string }).aiConfigMasterKey =
        'nothex'.repeat(10);
      expect(() => assertAiMasterKey()).toThrow(/64 hex/);
    });
  });
});
