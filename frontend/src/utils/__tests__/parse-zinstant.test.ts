import { describe, it, expect } from 'vitest';
import { parseZinstant, formatVnd } from '@/utils/parse-zinstant';

describe('parseZinstant', () => {
  it('returns null for null / empty / non-JSON input (AC-0005)', () => {
    expect(parseZinstant(null)).toBeNull();
    expect(parseZinstant(undefined)).toBeNull();
    expect(parseZinstant('')).toBeNull();
    expect(parseZinstant('hello world')).toBeNull();
    expect(parseZinstant('@@ZINSTANT@@')).toBeNull();
  });

  it('returns null for malformed JSON (BR-0004)', () => {
    expect(parseZinstant('{not json')).toBeNull();
  });

  it('returns null when JSON has no recognisable bank fields (EC-0001)', () => {
    expect(parseZinstant('{"appId":"location","params":{"lat":10}}')).toBeNull();
  });

  it('extracts bank fields from params nesting', () => {
    const payload = JSON.stringify({
      appId: 'bank_card',
      params: {
        bankCode: 'BIDV',
        bankName: 'BIDV',
        accountNumber: '4271001234567',
        accountName: 'NGUYEN VAN A',
        amount: 500000,
        description: 'Thanh toan don hang 123',
        qrUrl: 'https://zdn.vn/qr/abc.png',
      },
    });
    const parsed = parseZinstant(payload);
    expect(parsed).toEqual({
      bankCode: 'BIDV',
      bankName: 'BIDV',
      accountNumber: '4271001234567',
      accountName: 'NGUYEN VAN A',
      amount: 500000,
      description: 'Thanh toan don hang 123',
      qrUrl: 'https://zdn.vn/qr/abc.png',
    });
  });

  it('falls back to top-level fields when params is missing', () => {
    const payload = JSON.stringify({
      appId: 'bank_card',
      accountNumber: '12345',
      bankName: 'Techcombank',
    });
    const parsed = parseZinstant(payload);
    expect(parsed?.accountNumber).toBe('12345');
    expect(parsed?.bankName).toBe('Techcombank');
    expect(parsed?.amount).toBeNull();
    expect(parsed?.description).toBe('');
  });

  it('parses params when shipped as a stringified JSON blob', () => {
    const payload = JSON.stringify({
      appId: 'bank_card',
      params: JSON.stringify({ accountNumber: '999', bankName: 'VCB' }),
    });
    const parsed = parseZinstant(payload);
    expect(parsed?.accountNumber).toBe('999');
    expect(parsed?.bankName).toBe('VCB');
  });

  it('accepts amount as a string with currency formatting', () => {
    const payload = JSON.stringify({
      appId: 'bank_card',
      params: { accountNumber: '1', amount: '1,500,000' },
    });
    expect(parseZinstant(payload)?.amount).toBe(1500000);
  });

  it('falls back to note when description is missing', () => {
    const payload = JSON.stringify({
      appId: 'bank_card',
      params: { accountNumber: '1', note: 'Ghi chú' },
    });
    expect(parseZinstant(payload)?.description).toBe('Ghi chú');
  });

  it('treats empty accountNumber gracefully (EC-0002)', () => {
    const payload = JSON.stringify({
      appId: 'bank_card',
      params: { accountNumber: '', bankName: 'BIDV' },
    });
    const parsed = parseZinstant(payload);
    expect(parsed?.accountNumber).toBe('');
    expect(parsed?.bankName).toBe('BIDV');
  });
});

describe('formatVnd', () => {
  it('formats integer VND with thousand separators', () => {
    const out = formatVnd(1500000);
    // Different ICU builds use different separators (.,/ /NBSP); just assert
    // the digits + currency symbol are present.
    expect(out).toMatch(/1.?500.?000/);
    expect(out).toContain('₫');
  });
});
