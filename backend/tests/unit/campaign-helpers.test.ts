import { describe, it, expect } from 'vitest';
import {
  validateCampaignInput,
  buildContactWhere,
  applyMessagePlaceholders,
  canTransition,
  VALID_STATUS_TRANSITIONS,
} from '../../src/modules/campaigns/campaign-helpers.js';

describe('validateCampaignInput', () => {
  const valid = {
    name: 'Test',
    zaloAccountId: 'zalo-1',
    message: 'Hello {{firstName}}',
    filter: { status: ['interested'] },
  };

  it('accepts a minimal valid payload', () => {
    const r = validateCampaignInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scheduledAt).toBeNull();
      expect(r.value.filter.status).toEqual(['interested']);
    }
  });

  it('rejects empty name', () => {
    expect(validateCampaignInput({ ...valid, name: '' }).ok).toBe(false);
    expect(validateCampaignInput({ ...valid, name: '   ' }).ok).toBe(false);
  });

  it('rejects name over 200 chars', () => {
    expect(validateCampaignInput({ ...valid, name: 'a'.repeat(201) }).ok).toBe(false);
  });

  it('rejects missing zaloAccountId', () => {
    expect(validateCampaignInput({ ...valid, zaloAccountId: '' }).ok).toBe(false);
  });

  it('rejects message that is empty or > 2000 chars', () => {
    expect(validateCampaignInput({ ...valid, message: '' }).ok).toBe(false);
    expect(validateCampaignInput({ ...valid, message: 'x'.repeat(2001) }).ok).toBe(false);
  });

  it('rejects empty filter', () => {
    expect(validateCampaignInput({ ...valid, filter: {} }).ok).toBe(false);
  });

  it('rejects unknown status values', () => {
    expect(validateCampaignInput({ ...valid, filter: { status: ['banana'] } }).ok).toBe(false);
  });

  it('keeps only valid status values', () => {
    const r = validateCampaignInput({
      ...valid,
      filter: { status: ['interested', 'banana', 'converted'] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.filter.status).toEqual(['interested', 'converted']);
  });

  it('accepts source + tags', () => {
    const r = validateCampaignInput({
      ...valid,
      filter: { source: ['FB'], tags: ['vip'] },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects non-array filter.tags', () => {
    expect(
      validateCampaignInput({ ...valid, filter: { tags: 'vip' as any } }).ok,
    ).toBe(false);
  });

  it('parses scheduledAt ISO string', () => {
    const r = validateCampaignInput({ ...valid, scheduledAt: '2026-12-01T10:00:00Z' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scheduledAt?.toISOString()).toBe('2026-12-01T10:00:00.000Z');
  });

  it('rejects invalid scheduledAt string', () => {
    expect(validateCampaignInput({ ...valid, scheduledAt: 'not-a-date' }).ok).toBe(false);
  });

  it('treats missing scheduledAt as null', () => {
    const r = validateCampaignInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scheduledAt).toBeNull();
  });

  it('rejects non-object body', () => {
    expect(validateCampaignInput(null).ok).toBe(false);
    expect(validateCampaignInput('foo').ok).toBe(false);
  });
});

describe('buildContactWhere', () => {
  it('always scopes by org and excludes contacts without zaloUid', () => {
    const where = buildContactWhere('org-1', { status: ['interested'] });
    expect(where.orgId).toBe('org-1');
    expect(where.zaloUid).toEqual({ not: null });
    expect(where.status).toEqual({ in: ['interested'] });
  });

  it('omits fields that are empty', () => {
    const where = buildContactWhere('org-1', { status: ['interested'] });
    expect(where.source).toBeUndefined();
    expect(where.contactTags).toBeUndefined();
  });

  it('uses the contactTags junction with case-folded names for tags filter', () => {
    const where = buildContactWhere('org-1', { tags: ['VIP', 'Hot'] });
    expect(where.contactTags).toEqual({
      some: { tag: { normalizedName: { in: ['vip', 'hot'] } } },
    });
  });

  it('omits the tags clause when every entry normalizes to empty', () => {
    const where = buildContactWhere('org-1', { tags: ['   ', ''] });
    expect(where.contactTags).toBeUndefined();
  });
});

describe('applyMessagePlaceholders', () => {
  it('substitutes contactName and firstName', () => {
    expect(
      applyMessagePlaceholders('Chào {{firstName}}, {{contactName}}', {
        fullName: 'Nguyễn Văn A',
      }),
    ).toBe('Chào Nguyễn, Nguyễn Văn A');
  });

  it('substitutes empty when contact null', () => {
    expect(applyMessagePlaceholders('Hi {{contactName}}!', null)).toBe('Hi !');
  });

  it('leaves text without placeholders unchanged', () => {
    expect(applyMessagePlaceholders('Plain text', { fullName: 'X' })).toBe('Plain text');
  });
});

describe('canTransition', () => {
  it.each([
    ['draft', 'scheduled', true],
    ['draft', 'running', true],
    ['draft', 'cancelled', true],
    ['draft', 'completed', false],
    ['scheduled', 'running', true],
    ['scheduled', 'paused', true],
    ['scheduled', 'cancelled', true],
    ['running', 'paused', true],
    ['running', 'completed', true],
    ['running', 'cancelled', true],
    ['running', 'scheduled', false],
    ['paused', 'running', true],
    ['paused', 'cancelled', true],
    ['paused', 'completed', false],
    ['completed', 'running', false],
    ['cancelled', 'running', false],
  ])('%s → %s = %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });

  it('terminal states have no transitions out', () => {
    expect(VALID_STATUS_TRANSITIONS.completed).toEqual([]);
    expect(VALID_STATUS_TRANSITIONS.cancelled).toEqual([]);
  });
});
