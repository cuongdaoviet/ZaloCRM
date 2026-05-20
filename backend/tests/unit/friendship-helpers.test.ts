/**
 * Unit tests — feature 0020 friendship helpers.
 *
 * Covers the state-machine validator (BR-0007), enqueue permission check
 * (BR-0001), and zca-js error mapping (BR-0011 / BR-0015 / EC-0005 / EC-0009).
 */
import { describe, it, expect } from 'vitest';
import {
  ACTIVE_STATES,
  canEnqueue,
  canTransition,
  extractZaloUid,
  isActiveState,
  mapZaloError,
  validateRequestMessage,
  VALID_STATE_TRANSITIONS,
} from '../../src/modules/friendship/friendship-helpers.js';

describe('canTransition (BR-0007)', () => {
  // The full matrix lives in the SPEC §3 state diagram. We assert each
  // legal transition explicitly + a representative sampling of the illegal
  // ones, including "terminal states have no outgoing transitions".
  it.each([
    // Legal
    ['queued', 'looking_up', true],
    ['queued', 'cancelled', true],
    ['looking_up', 'sent', true],
    ['looking_up', 'error', true],
    ['looking_up', 'cancelled', true],
    ['looking_up', 'accepted', true], // BR-0012 shortcut
    ['sent', 'accepted', true],
    ['sent', 'declined', true],
    ['sent', 'timeout', true],
    ['sent', 'error', true],
    // Illegal
    ['queued', 'sent', false],
    ['queued', 'accepted', false],
    ['queued', 'error', false],
    ['looking_up', 'queued', false],
    ['looking_up', 'timeout', false],
    ['sent', 'cancelled', false], // BR-0008
    ['sent', 'looking_up', false],
    ['sent', 'queued', false],
    // Terminal states have no transitions out
    ['accepted', 'declined', false],
    ['accepted', 'sent', false],
    ['declined', 'accepted', false],
    ['timeout', 'sent', false],
    ['error', 'queued', false],
    ['cancelled', 'queued', false],
    // Unknown state
    ['mystery', 'queued', false],
  ])('%s → %s = %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });

  it('terminal states have empty transition arrays', () => {
    for (const terminal of ['accepted', 'declined', 'timeout', 'error', 'cancelled']) {
      expect(VALID_STATE_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});

describe('isActiveState (BR-0005)', () => {
  it('only queued/looking_up/sent are active', () => {
    expect(ACTIVE_STATES).toEqual(['queued', 'looking_up', 'sent']);
  });
  it.each([
    ['queued', true],
    ['looking_up', true],
    ['sent', true],
    ['accepted', false],
    ['declined', false],
    ['timeout', false],
    ['error', false],
    ['cancelled', false],
  ])('%s active=%s', (state, expected) => {
    expect(isActiveState(state)).toBe(expected);
  });
});

describe('canEnqueue (BR-0001)', () => {
  const account = { ownerUserId: 'owner-1' };

  it('owner role bypasses ACL', () => {
    expect(canEnqueue({ id: 'u1', role: 'owner' }, account, [])).toBe(true);
  });

  it('admin role bypasses ACL', () => {
    expect(canEnqueue({ id: 'u1', role: 'admin' }, account, [])).toBe(true);
  });

  it('owns the account', () => {
    expect(canEnqueue({ id: 'owner-1', role: 'member' }, account, [])).toBe(true);
  });

  it('member with chat permission', () => {
    expect(
      canEnqueue({ id: 'u2', role: 'member' }, account, [{ permission: 'chat' }]),
    ).toBe(true);
  });

  it('member with admin permission', () => {
    expect(
      canEnqueue({ id: 'u2', role: 'member' }, account, [{ permission: 'admin' }]),
    ).toBe(true);
  });

  it('member with only read permission is denied', () => {
    expect(
      canEnqueue({ id: 'u2', role: 'member' }, account, [{ permission: 'read' }]),
    ).toBe(false);
  });

  it('member with no permission is denied', () => {
    expect(canEnqueue({ id: 'u2', role: 'member' }, account, [])).toBe(false);
  });

  it('missing account → denied', () => {
    expect(canEnqueue({ id: 'u1', role: 'owner' }, null, [])).toBe(false);
  });
});

describe('mapZaloError', () => {
  it('detects "user not found" → phone_not_on_zalo', () => {
    const r = mapZaloError(new Error('User not found'), 'lookup');
    expect(r.errorCode).toBe('phone_not_on_zalo');
  });

  it('detects Vietnamese "không có Zalo" → phone_not_on_zalo', () => {
    const r = mapZaloError(new Error('Số này không có Zalo'), 'lookup');
    expect(r.errorCode).toBe('phone_not_on_zalo');
  });

  it('detects "already friends" → already_friends', () => {
    const r = mapZaloError(new Error('You are already friends'), 'send');
    expect(r.errorCode).toBe('already_friends');
  });

  it('detects "disconnected" → account_disconnected', () => {
    const r = mapZaloError(new Error('listener disconnected'), 'send');
    expect(r.errorCode).toBe('account_disconnected');
  });

  it('lookup phase: unknown error → lookup_failed', () => {
    const r = mapZaloError(new Error('Network timeout'), 'lookup');
    expect(r.errorCode).toBe('lookup_failed');
  });

  it('send phase: unknown error → send_failed', () => {
    const r = mapZaloError(new Error('Boom'), 'send');
    expect(r.errorCode).toBe('send_failed');
  });

  it('preserves the original message in errorDetail', () => {
    const r = mapZaloError(new Error('Boom went the dynamite'), 'send');
    expect(r.errorDetail).toBe('Boom went the dynamite');
  });

  it('non-Error throwables degrade gracefully', () => {
    const r = mapZaloError('weird string', 'send');
    expect(r.errorCode).toBe('send_failed');
    expect(r.errorDetail).toBe('weird string');
  });
});

describe('extractZaloUid', () => {
  it('returns numeric uid', () => {
    expect(extractZaloUid({ uid: '12345' })).toBe('12345');
  });
  it('strips whitespace', () => {
    expect(extractZaloUid({ uid: '  12345  ' })).toBe('12345');
  });
  it('rejects empty string (EC-0009)', () => {
    expect(extractZaloUid({ uid: '' })).toBeNull();
  });
  it('rejects non-numeric (EC-0009)', () => {
    expect(extractZaloUid({ uid: 'abc' })).toBeNull();
  });
  it('rejects null/undefined input', () => {
    expect(extractZaloUid(null)).toBeNull();
    expect(extractZaloUid(undefined)).toBeNull();
    expect(extractZaloUid({})).toBeNull();
  });
});

describe('validateRequestMessage (BR-0013/BR-0014)', () => {
  it('returns null for null/undefined', () => {
    expect(validateRequestMessage(null)).toBeNull();
    expect(validateRequestMessage(undefined)).toBeNull();
  });
  it('returns empty string for "" (BR-0014)', () => {
    expect(validateRequestMessage('')).toBe('');
  });
  it('trims whitespace', () => {
    expect(validateRequestMessage('  hi  ')).toBe('hi');
  });
  it('accepts exactly 200 chars', () => {
    const s = 'a'.repeat(200);
    expect(validateRequestMessage(s)).toBe(s);
  });
  it('rejects > 200 chars', () => {
    expect(() => validateRequestMessage('a'.repeat(201))).toThrow();
  });
  it('rejects non-string', () => {
    expect(() => validateRequestMessage(42 as unknown)).toThrow();
  });
});
