/**
 * Unit tests for the Feature 0038 shim functions `encryptConfig` /
 * `decryptConfig` in shared/crypto/encrypt-config.ts.
 *
 * The underlying primitive (AES-256-GCM + HKDF-derived per-org key) is
 * tested in `encrypt-config.test.ts` (Feature 0036). This file only
 * exercises the JSON-serialise + field-rename layer on top.
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  // 64-char hex = 32 bytes (AES-256 key).
  process.env.AI_CONFIG_MASTER_KEY =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
});

const ORG = '00000000-0000-0000-0000-000000000038';

describe('encryptConfig / decryptConfig (Feature 0038 shims)', () => {
  it('round-trips a JSON-serialisable object', async () => {
    const { encryptConfig, decryptConfig } = await import(
      '../../src/shared/crypto/encrypt-config.js'
    );
    const plain = {
      refreshToken: 'rt-secret',
      spreadsheetId: 's1',
      schedule: 'daily',
    };
    const enc = encryptConfig(ORG, plain);
    const dec = decryptConfig(ORG, enc);
    expect(dec).toEqual(plain);
  });

  it('uses a fresh IV each call (same plaintext → different ciphertext)', async () => {
    const { encryptConfig } = await import(
      '../../src/shared/crypto/encrypt-config.js'
    );
    const a = encryptConfig(ORG, { x: 1 });
    const b = encryptConfig(ORG, { x: 1 });
    expect(a.configIv).not.toBe(b.configIv);
    expect(a.configCipher).not.toBe(b.configCipher);
  });

  it('detects tampering via auth tag', async () => {
    const { encryptConfig, decryptConfig } = await import(
      '../../src/shared/crypto/encrypt-config.js'
    );
    const enc = encryptConfig(ORG, { x: 1 });
    const tampered = {
      ...enc,
      configCipher: enc.configCipher.slice(0, -2) + '00',
    };
    expect(() => decryptConfig(ORG, tampered)).toThrow();
  });

  it('different orgs cannot decrypt each other', async () => {
    const { encryptConfig, decryptConfig } = await import(
      '../../src/shared/crypto/encrypt-config.js'
    );
    const blob = encryptConfig(ORG, { secret: 'abc' });
    expect(() => decryptConfig('different-org', blob)).toThrow();
  });
});
