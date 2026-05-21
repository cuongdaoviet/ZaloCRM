/**
 * Unit tests for backend/src/shared/security/login-attempt-tracker.ts.
 *
 * Covers Feature 0046 BR-0018:
 *  - 5 failures in 15 min → allowed=false with retryAfter
 *  - success clears the entry
 *  - window expiry resets the counter
 *  - email is normalized (case + whitespace insensitive)
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  check,
  recordFailure,
  clear,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  __resetForTests,
  __snapshotForTests,
} from '../../src/shared/security/login-attempt-tracker.js';

beforeEach(() => {
  __resetForTests();
  vi.useRealTimers();
});

afterAll(() => {
  vi.useRealTimers();
  __resetForTests();
});

describe('login-attempt-tracker', () => {
  it('allows the first attempt for an unseen email', () => {
    expect(check('a@example.com')).toEqual({ allowed: true });
  });

  it('returns allowed=true for 1..MAX-1 failures', () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) {
      recordFailure('a@example.com');
      expect(check('a@example.com').allowed).toBe(true);
    }
  });

  it('returns allowed=false on the MAX-th attempt with Retry-After', () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      recordFailure('a@example.com');
    }
    const result = check('a@example.com');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it('clear() drops the entry — next attempt is fresh', () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      recordFailure('a@example.com');
    }
    expect(check('a@example.com').allowed).toBe(false);
    clear('a@example.com');
    expect(check('a@example.com').allowed).toBe(true);
    expect(__snapshotForTests().has('a@example.com')).toBe(false);
  });

  it('window expiry resets the counter', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      recordFailure('a@example.com');
    }
    expect(check('a@example.com').allowed).toBe(false);

    // Advance past the 15-min window.
    vi.setSystemTime(t0 + LOGIN_WINDOW_MS + 1);
    expect(check('a@example.com').allowed).toBe(true);

    // Next failure starts a new window with count=1.
    const state = recordFailure('a@example.com');
    expect(state.count).toBe(1);
    expect(check('a@example.com').allowed).toBe(true);
  });

  it('normalizes email case + whitespace', () => {
    recordFailure('  Foo@Example.com  ');
    recordFailure('foo@example.com');
    recordFailure('FOO@EXAMPLE.COM');
    const snap = __snapshotForTests();
    expect(snap.size).toBe(1);
    expect(snap.get('foo@example.com')!.count).toBe(3);
  });

  it('different emails have independent budgets', () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      recordFailure('a@example.com');
    }
    expect(check('a@example.com').allowed).toBe(false);
    expect(check('b@example.com').allowed).toBe(true);
  });

  it('AC-0008 / AC-0009 scenario: 4 failures then success then 1 failure', () => {
    for (let i = 0; i < 4; i++) recordFailure('alice@example.com');
    expect(check('alice@example.com').allowed).toBe(true);
    // simulate success
    clear('alice@example.com');
    // 1 failure later — should NOT immediately be rate-limited
    recordFailure('alice@example.com');
    expect(check('alice@example.com').allowed).toBe(true);
    const snap = __snapshotForTests();
    expect(snap.get('alice@example.com')!.count).toBe(1);
  });
});
