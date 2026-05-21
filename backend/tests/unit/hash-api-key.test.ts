/**
 * Unit tests for backend/src/shared/crypto/hash-api-key.ts.
 *
 * Covers Feature 0046 BR-0013/BR-0015 — SHA-256 helper + constant-time
 * compare + legacy-vs-hashed detection.
 */
import { describe, it, expect } from 'vitest';
import {
  hashApiKey,
  isHashedApiKey,
  verifyApiKeyHash,
} from '../../src/shared/crypto/hash-api-key.js';

const SAMPLE_KEY = 'zcrm_0123456789abcdef0123456789abcdef0123456789abcdef';

describe('hashApiKey', () => {
  it('produces a 64-char lowercase hex string', () => {
    const out = hashApiKey(SAMPLE_KEY);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input yields same output', () => {
    expect(hashApiKey(SAMPLE_KEY)).toBe(hashApiKey(SAMPLE_KEY));
  });

  it('produces different output for different inputs', () => {
    expect(hashApiKey('zcrm_a')).not.toBe(hashApiKey('zcrm_b'));
  });

  it('matches the canonical SHA-256 of the literal input', () => {
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(hashApiKey('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('isHashedApiKey', () => {
  it('returns true for a 64-char lowercase hex string', () => {
    expect(isHashedApiKey(hashApiKey(SAMPLE_KEY))).toBe(true);
  });

  it('returns false for a legacy plaintext zcrm_ key', () => {
    expect(isHashedApiKey(SAMPLE_KEY)).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(isHashedApiKey('')).toBe(false);
  });

  it('returns false for a 64-char string with non-hex chars', () => {
    expect(isHashedApiKey('z'.repeat(64))).toBe(false);
  });

  it('returns false for 63 hex chars (off by one)', () => {
    expect(isHashedApiKey('a'.repeat(63))).toBe(false);
  });

  it('returns false for 65 hex chars (off by one)', () => {
    expect(isHashedApiKey('a'.repeat(65))).toBe(false);
  });
});

describe('verifyApiKeyHash', () => {
  it('returns true for equal hashes', () => {
    const h = hashApiKey(SAMPLE_KEY);
    expect(verifyApiKeyHash(h, h)).toBe(true);
  });

  it('returns false for different hashes of the same length', () => {
    const h1 = hashApiKey('a');
    const h2 = hashApiKey('b');
    expect(verifyApiKeyHash(h1, h2)).toBe(false);
  });

  it('returns false on length mismatch (no throw)', () => {
    expect(verifyApiKeyHash('abc', 'a'.repeat(64))).toBe(false);
  });

  it('returns false on non-hex input (fail closed, no throw)', () => {
    expect(verifyApiKeyHash('zzz', 'aaa')).toBe(false);
  });
});
