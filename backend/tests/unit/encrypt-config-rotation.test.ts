/**
 * Feature 0044 — unit tests for the dual-key read window in encrypt-config.
 *
 * Coverage:
 *   AC-0001 — current-key decrypt still works (no fallback needed).
 *   AC-0002 — previous-key decrypt works via fallback + logs info.
 *   AC-0003 — both keys wrong → throws.
 *   AC-0004 — identical current+previous → assertAiMasterKey throws.
 *   AC-0011 — tampered cipher → decrypt throws regardless of fallback.
 *   isCurrentlyEncrypted predicate (CLI helper) behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);

// Capture logger calls so we can assert the "decrypted with previous key"
// info line is emitted (BR-0002).
const logCalls: { level: string; msg: unknown[] }[] = [];
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: {
    info: (...m: unknown[]) => logCalls.push({ level: 'info', msg: m }),
    warn: (...m: unknown[]) => logCalls.push({ level: 'warn', msg: m }),
    error: (...m: unknown[]) => logCalls.push({ level: 'error', msg: m }),
    debug: (...m: unknown[]) => logCalls.push({ level: 'debug', msg: m }),
  },
}));

import {
  encryptForOrg,
  decryptForOrg,
  isCurrentlyEncrypted,
  assertAiMasterKey,
} from '../../src/shared/crypto/encrypt-config.js';
import { config } from '../../src/config/index.js';

function setKeys(current: string, previous = ''): void {
  (config as { aiConfigMasterKey: string }).aiConfigMasterKey = current;
  (config as { aiConfigMasterKeyPrevious: string }).aiConfigMasterKeyPrevious =
    previous;
}

beforeEach(() => {
  logCalls.length = 0;
  setKeys(KEY_A, '');
  (config as { isProduction: boolean }).isProduction = false;
});

describe('Feature 0044 — dual-key decrypt fallback', () => {
  it('AC-0001: decrypts a blob encrypted with the current key (no fallback)', () => {
    setKeys(KEY_A);
    const blob = encryptForOrg('org-1', 'secret-A');
    expect(decryptForOrg('org-1', blob)).toBe('secret-A');
    // No info-log fallback message should fire.
    expect(
      logCalls.filter(
        (c) =>
          c.level === 'info' &&
          String(c.msg[0]).includes('decrypted with previous key'),
      ),
    ).toHaveLength(0);
  });

  it('AC-0002: decrypts a blob encrypted with the previous key when fallback set', () => {
    // Encrypt while KEY_A is current.
    setKeys(KEY_A);
    const blob = encryptForOrg('org-1', 'secret-A');

    // Rotate: KEY_B is now current, KEY_A becomes previous.
    setKeys(KEY_B, KEY_A);
    expect(decryptForOrg('org-1', blob)).toBe('secret-A');

    // BR-0002: info log line emitted (NOT error/warn).
    const infoMatches = logCalls.filter(
      (c) =>
        c.level === 'info' &&
        String(c.msg[0]).includes('decrypted with previous key'),
    );
    expect(infoMatches.length).toBeGreaterThan(0);
    // No plaintext / sub-key leaks into the log message.
    for (const m of infoMatches) {
      const joined = m.msg.map((x) => String(x)).join(' ');
      expect(joined).not.toContain('secret-A');
    }
  });

  it('AC-0003: throws when blob decrypts with NEITHER current nor previous key', () => {
    // Encrypt with KEY_A.
    setKeys(KEY_A);
    const blob = encryptForOrg('org-1', 'secret-A');

    // Now set current=KEY_B with NO previous → should throw.
    setKeys(KEY_B, '');
    expect(() => decryptForOrg('org-1', blob)).toThrow();

    // And current=KEY_B + previous=KEY_B (still neither matches KEY_A; the
    // identical-keys guard fires at boot, not in decryptForOrg).
    setKeys(KEY_B, 'cc'.repeat(32));
    expect(() => decryptForOrg('org-1', blob)).toThrow();
  });

  it('AC-0011: tampered cipher → throws on both keys (no silent decrypt)', () => {
    setKeys(KEY_A);
    const blob = encryptForOrg('org-1', 'secret-A');
    // Flip one byte of the cipher.
    const buf = Buffer.from(blob.cipher, 'hex');
    buf[0] ^= 0x01;
    const tampered = { ...blob, cipher: buf.toString('hex') };

    // No previous key set → throws.
    setKeys(KEY_A, '');
    expect(() => decryptForOrg('org-1', tampered)).toThrow();

    // Previous key set to the same KEY_A as well → still throws (tag
    // mismatch is intrinsic, not key-related).
    setKeys(KEY_B, KEY_A);
    expect(() => decryptForOrg('org-1', tampered)).toThrow();
  });

  it('returns plaintext when current key works even though previous key is set', () => {
    // Both keys set; blob is encrypted with current. Fallback path must
    // NOT fire (no info log).
    setKeys(KEY_A, KEY_B);
    const blob = encryptForOrg('org-1', 'fresh');
    expect(decryptForOrg('org-1', blob)).toBe('fresh');
    const infoMatches = logCalls.filter(
      (c) =>
        c.level === 'info' &&
        String(c.msg[0]).includes('decrypted with previous key'),
    );
    expect(infoMatches).toHaveLength(0);
  });
});

describe('Feature 0044 — isCurrentlyEncrypted predicate', () => {
  it('returns true when blob decrypts with the current key', () => {
    setKeys(KEY_A);
    const blob = encryptForOrg('org-1', 'x');
    expect(isCurrentlyEncrypted('org-1', blob)).toBe(true);
  });

  it('returns false when blob decrypts only with the previous key', () => {
    setKeys(KEY_A);
    const blob = encryptForOrg('org-1', 'x');
    // Rotate: KEY_B current, KEY_A previous. Blob is "current-encrypted"
    // from the CURRENT key's perspective is false.
    setKeys(KEY_B, KEY_A);
    expect(isCurrentlyEncrypted('org-1', blob)).toBe(false);
  });

  it('returns false for an empty/malformed blob (never throws)', () => {
    setKeys(KEY_A);
    expect(isCurrentlyEncrypted('org-1', { cipher: '', iv: '', tag: '' })).toBe(
      false,
    );
    expect(
      isCurrentlyEncrypted('org-1', {
        cipher: 'notHex!!',
        iv: 'zz',
        tag: '00',
      }),
    ).toBe(false);
  });

  it('returns false for a blob that decrypts with NEITHER key', () => {
    setKeys(KEY_A);
    const blob = encryptForOrg('org-1', 'x');
    const buf = Buffer.from(blob.cipher, 'hex');
    buf[0] ^= 0x77;
    const tampered = { ...blob, cipher: buf.toString('hex') };
    setKeys(KEY_A, KEY_B);
    expect(isCurrentlyEncrypted('org-1', tampered)).toBe(false);
  });
});

describe('Feature 0044 — assertAiMasterKey boot guard', () => {
  it('AC-0004: throws when current and previous master keys are identical', () => {
    setKeys(KEY_A, KEY_A);
    expect(() => assertAiMasterKey()).toThrow(/must differ/i);
  });

  it('passes when previous is unset (no rotation in progress)', () => {
    setKeys(KEY_A, '');
    expect(() => assertAiMasterKey()).not.toThrow();
  });

  it('passes when current and previous differ (rotation window active)', () => {
    setKeys(KEY_A, KEY_B);
    expect(() => assertAiMasterKey()).not.toThrow();
  });

  it('throws when previous is set but malformed (non-hex)', () => {
    setKeys(KEY_A, 'not-64-hex-chars');
    expect(() => assertAiMasterKey()).toThrow(/64 hex/i);
  });
});
