/**
 * Feature 0035 — Unit tests for proxy URL helpers.
 *
 * Covers:
 *   - validateAndNormalizeProxyUrl: scheme acceptance, normalization (socks→socks5,
 *     strip trailing slash), reject malformed input, accept IPv6.
 *   - maskProxyUrl: credentials hidden, host/port retained.
 *   - buildProxyAgent: returns the right agent class for each scheme,
 *     returns undefined when no proxy.
 *   - stripProxyUrlForRole / stripProxyUrlSingle / isAdminRole.
 */
import { describe, it, expect } from 'vitest';
import {
  validateAndNormalizeProxyUrl,
  maskProxyUrl,
  buildProxyAgent,
  stripProxyUrlForRole,
  stripProxyUrlSingle,
  isAdminRole,
} from '../../src/shared/network/proxy-agent.js';

describe('validateAndNormalizeProxyUrl', () => {
  it('accepts SOCKS5 with credentials', () => {
    const r = validateAndNormalizeProxyUrl('socks5://user:pass@10.0.0.1:1080');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('socks5://user:pass@10.0.0.1:1080');
  });

  it('accepts HTTP with credentials', () => {
    const r = validateAndNormalizeProxyUrl('http://u:p@proxy.local:8080');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('http://u:p@proxy.local:8080');
  });

  it('accepts HTTPS without port', () => {
    const r = validateAndNormalizeProxyUrl('https://proxy.example.com');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('https://proxy.example.com');
  });

  it('normalizes socks:// to socks5://', () => {
    const r = validateAndNormalizeProxyUrl('socks://10.0.0.1:1080');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('socks5://10.0.0.1:1080');
  });

  it('strips trailing slash', () => {
    const r = validateAndNormalizeProxyUrl('socks5://10.0.0.1:1080/');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('socks5://10.0.0.1:1080');
  });

  it('accepts IPv6 in bracket form', () => {
    const r = validateAndNormalizeProxyUrl('socks5://[::1]:1080');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('socks5://[::1]:1080');
  });

  it('lowercases scheme', () => {
    const r = validateAndNormalizeProxyUrl('SOCKS5://10.0.0.1:1080');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('socks5://10.0.0.1:1080');
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['undefined', undefined],
  ])('treats %s as clear (normalized=null)', (_label, input) => {
    const r = validateAndNormalizeProxyUrl(input as never);
    expect(r.valid).toBe(true);
    expect(r.normalized).toBeNull();
  });

  it.each([
    ['missing scheme', '10.0.0.1:1080'],
    ['unsupported scheme', 'ftp://10.0.0.1:1080'],
    ['malformed slashes', 'socks5//bad'],
    ['port out of range', 'socks5://10.0.0.1:99999'],
    ['port zero', 'socks5://10.0.0.1:0'],
    ['random garbage', 'not-a-url'],
  ])('rejects %s as invalid_proxy_format', (_label, input) => {
    const r = validateAndNormalizeProxyUrl(input);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('invalid_proxy_format');
  });

  it('rejects non-string input', () => {
    const r = validateAndNormalizeProxyUrl(123 as unknown as string);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('invalid_proxy_format');
  });
});

describe('maskProxyUrl', () => {
  it('masks credentials for SOCKS5', () => {
    expect(maskProxyUrl('socks5://user:pass@10.0.0.1:1080')).toBe(
      'socks5://***@10.0.0.1:1080',
    );
  });

  it('leaves credential-free URLs alone', () => {
    expect(maskProxyUrl('http://10.0.0.1:8080')).toBe('http://10.0.0.1:8080');
  });

  it('returns <none> for empty/null', () => {
    expect(maskProxyUrl(null)).toBe('<none>');
    expect(maskProxyUrl(undefined)).toBe('<none>');
    expect(maskProxyUrl('')).toBe('<none>');
  });

  it('returns redacted placeholder for invalid input (never leak)', () => {
    expect(maskProxyUrl('not-a-url')).toBe('<redacted-invalid>');
  });

  it('handles IPv6 host', () => {
    expect(maskProxyUrl('socks5://u:p@[::1]:1080')).toBe('socks5://***@[::1]:1080');
  });
});

describe('buildProxyAgent', () => {
  it('returns undefined for null/empty', () => {
    expect(buildProxyAgent(null)).toBeUndefined();
    expect(buildProxyAgent(undefined)).toBeUndefined();
    expect(buildProxyAgent('')).toBeUndefined();
    expect(buildProxyAgent('  ')).toBeUndefined();
  });

  it('returns SocksProxyAgent for socks5://', () => {
    const agent = buildProxyAgent('socks5://10.0.0.1:1080');
    expect(agent).toBeDefined();
    expect((agent as { constructor: { name: string } }).constructor.name).toBe(
      'SocksProxyAgent',
    );
  });

  it('returns SocksProxyAgent for socks://', () => {
    const agent = buildProxyAgent('socks://10.0.0.1:1080');
    expect(agent).toBeDefined();
    expect((agent as { constructor: { name: string } }).constructor.name).toBe(
      'SocksProxyAgent',
    );
  });

  it('returns HttpsProxyAgent for http://', () => {
    const agent = buildProxyAgent('http://10.0.0.1:8080');
    expect(agent).toBeDefined();
    expect((agent as { constructor: { name: string } }).constructor.name).toBe(
      'HttpsProxyAgent',
    );
  });

  it('returns HttpsProxyAgent for https://', () => {
    const agent = buildProxyAgent('https://proxy.example.com:8443');
    expect(agent).toBeDefined();
    expect((agent as { constructor: { name: string } }).constructor.name).toBe(
      'HttpsProxyAgent',
    );
  });
});

describe('isAdminRole', () => {
  it('admits owner and admin', () => {
    expect(isAdminRole('owner')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
  });

  it('rejects member and unknown', () => {
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('viewer')).toBe(false);
    expect(isAdminRole('')).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole(null)).toBe(false);
  });
});

describe('stripProxyUrlSingle', () => {
  it('keeps proxyUrl for admin', () => {
    const item = { id: '1', proxyUrl: 'socks5://x:y@h:1080' };
    const out = stripProxyUrlSingle(item, 'admin') as typeof item;
    expect(out.proxyUrl).toBe('socks5://x:y@h:1080');
  });

  it('omits proxyUrl for member', () => {
    const item = { id: '1', proxyUrl: 'socks5://x:y@h:1080' };
    const out = stripProxyUrlSingle(item, 'member') as { id: string };
    expect((out as Record<string, unknown>).proxyUrl).toBeUndefined();
    expect(out.id).toBe('1');
  });

  it('does not mutate input', () => {
    const item = { id: '1', proxyUrl: 'socks5://x:y@h:1080' };
    stripProxyUrlSingle(item, 'member');
    expect(item.proxyUrl).toBe('socks5://x:y@h:1080');
  });
});

describe('stripProxyUrlForRole', () => {
  it('strips for member, keeps for admin', () => {
    const items = [
      { id: '1', proxyUrl: 'socks5://a:b@h:1080' },
      { id: '2', proxyUrl: null },
    ];
    const memberOut = stripProxyUrlForRole(items, 'member') as Array<
      Record<string, unknown>
    >;
    expect(memberOut[0].proxyUrl).toBeUndefined();
    expect(memberOut[1].proxyUrl).toBeUndefined();

    const adminOut = stripProxyUrlForRole(items, 'admin') as Array<
      Record<string, unknown>
    >;
    expect(adminOut[0].proxyUrl).toBe('socks5://a:b@h:1080');
    expect(adminOut[1].proxyUrl).toBeNull();
  });
});
