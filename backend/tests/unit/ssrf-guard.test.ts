/**
 * Unit tests for shared/network/ssrf-guard.ts — Feature 0038.
 */
import { describe, it, expect } from 'vitest';
import { checkUrlForSsrf } from '../../src/shared/network/ssrf-guard.js';

describe('checkUrlForSsrf', () => {
  it.each([
    ['https://api.telegram.org', true],
    ['https://hooks.slack.com/services/x/y', true],
  ])('accepts public HTTPS: %s', (url, expectedOk) => {
    expect(checkUrlForSsrf(url).ok).toBe(expectedOk);
  });

  it.each([
    ['http://api.telegram.org', 'HTTPS'],
    ['https://localhost/foo', 'not allowed'],
    ['https://127.0.0.1/foo', 'not allowed'],
    ['https://10.0.0.1/foo', 'not allowed'],
    ['https://192.168.1.5/foo', 'not allowed'],
    ['https://172.16.0.1/foo', 'not allowed'],
    ['https://169.254.169.254/foo', 'not allowed'],
    ['not-a-url', 'Invalid'],
    ['', 'required'],
  ])('rejects %s', (url, expectedErrSnippet) => {
    const out = checkUrlForSsrf(url);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(new RegExp(expectedErrSnippet, 'i'));
  });
});
