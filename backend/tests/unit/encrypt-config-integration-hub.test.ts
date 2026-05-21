/**
 * Unit tests for shared/crypto/encrypt-config.ts — Feature 0038 path.
 *
 * Coverage: round-trip, IV uniqueness, tamper-detection (auth tag), prod
 * env guard, token masking.
 *
 * File name distinguishes from Feature 0036's own test (`encrypt-config.test.ts`)
 * which exercises a different exported API (`encryptForOrg`/`decryptForOrg`).
 * When 0036 lands first, this file co-exists; if 0036's helper supersedes
 * ours, this file is the one to delete.
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.INTEGRATION_CONFIG_MASTER_KEY =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
});

describe('encryptConfig / decryptConfig (Feature 0038)', () => {
  it('round-trips a JSON-serialisable object', async () => {
    const { encryptConfig, decryptConfig } = await import(
      '../../src/shared/crypto/encrypt-config.js'
    );
    const plain = { refreshToken: 'rt-secret', spreadsheetId: 's1', schedule: 'daily' };
    const enc = encryptConfig(plain);
    const dec = decryptConfig(enc);
    expect(dec).toEqual(plain);
  });

  it('uses a fresh IV each call (same plaintext → different ciphertext)', async () => {
    const { encryptConfig } = await import('../../src/shared/crypto/encrypt-config.js');
    const a = encryptConfig({ x: 1 });
    const b = encryptConfig({ x: 1 });
    expect(a.configIv).not.toBe(b.configIv);
    expect(a.configCipher).not.toBe(b.configCipher);
  });

  it('detects tampering via auth tag', async () => {
    const { encryptConfig, decryptConfig } = await import(
      '../../src/shared/crypto/encrypt-config.js'
    );
    const enc = encryptConfig({ x: 1 });
    // Flip a byte in the cipher
    const tampered = {
      ...enc,
      configCipher: enc.configCipher.slice(0, -2) + '00',
    };
    expect(() => decryptConfig(tampered)).toThrow();
  });

  it('rejects missing master key in production', async () => {
    const { encryptConfig } = await import('../../src/shared/crypto/encrypt-config.js');
    const prev = process.env.INTEGRATION_CONFIG_MASTER_KEY;
    const prevEnv = process.env.NODE_ENV;
    delete process.env.INTEGRATION_CONFIG_MASTER_KEY;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => encryptConfig({})).toThrow(/INTEGRATION_CONFIG_MASTER_KEY/);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prev) process.env.INTEGRATION_CONFIG_MASTER_KEY = prev;
    }
  });

  it('maskSecret hides middle of token', async () => {
    const { maskSecret } = await import('../../src/shared/crypto/encrypt-config.js');
    expect(maskSecret('1234567890:ABCxyz')).toMatch(/^123456\*\*\*xyz$/);
    expect(maskSecret(undefined)).toBe('<empty>');
    expect(maskSecret('abc')).toBe('***');
  });
});
