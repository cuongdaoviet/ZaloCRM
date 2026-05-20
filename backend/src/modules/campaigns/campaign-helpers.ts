/**
 * Pure helpers for the campaign module — kept side-effect free so they can
 * be unit-tested without Prisma or Fastify.
 */
import type { Prisma } from '@prisma/client';

/**
 * The "filter" object the frontend posts: which contacts to target.
 * All fields optional; empty filter = no targets (rejected with 400).
 */
export interface CampaignFilter {
  status?: string[]; // contact pipeline status, e.g. ['interested', 'converted']
  source?: string[]; // contact source codes
  tags?: string[]; // contact tags — matched as JSONB array contains
}

export interface CampaignInput {
  name: string;
  zaloAccountId: string;
  message: string;
  filter: CampaignFilter;
  scheduledAt: Date | null;
}

const VALID_CONTACT_STATUSES = new Set(['new', 'contacted', 'interested', 'converted', 'lost']);

/**
 * Validate a POST /campaigns body. Returns the parsed input or a 400-friendly
 * error message. Centralizes every gate the route would otherwise repeat.
 */
export function validateCampaignInput(
  body: unknown,
): { ok: true; value: CampaignInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body không hợp lệ' };
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 200) {
    return { ok: false, error: 'Tên chiến dịch phải dài 1-200 ký tự' };
  }

  const zaloAccountId = typeof b.zaloAccountId === 'string' ? b.zaloAccountId.trim() : '';
  if (!zaloAccountId) return { ok: false, error: 'Thiếu zaloAccountId' };

  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length < 1 || message.length > 2000) {
    return { ok: false, error: 'Nội dung tin nhắn phải dài 1-2000 ký tự' };
  }

  const filter = parseFilter(b.filter);
  if (!filter.ok) return filter;
  if (
    filter.value.status === undefined &&
    filter.value.source === undefined &&
    filter.value.tags === undefined
  ) {
    return { ok: false, error: 'Phải có ít nhất một filter (status / source / tags)' };
  }

  let scheduledAt: Date | null = null;
  if (b.scheduledAt !== undefined && b.scheduledAt !== null && b.scheduledAt !== '') {
    if (typeof b.scheduledAt !== 'string') {
      return { ok: false, error: 'scheduledAt phải là ISO datetime string' };
    }
    const d = new Date(b.scheduledAt);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: 'scheduledAt không phải ISO datetime hợp lệ' };
    }
    scheduledAt = d;
  }

  return {
    ok: true,
    value: { name, zaloAccountId, message, filter: filter.value, scheduledAt },
  };
}

function parseFilter(
  raw: unknown,
): { ok: true; value: CampaignFilter } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: false, error: 'Phải truyền filter' };
  }
  if (typeof raw !== 'object') {
    return { ok: false, error: 'filter phải là object' };
  }
  const f = raw as Record<string, unknown>;

  const out: CampaignFilter = {};

  if (f.status !== undefined) {
    if (!Array.isArray(f.status) || !f.status.every((s) => typeof s === 'string')) {
      return { ok: false, error: 'filter.status phải là mảng string' };
    }
    const filtered = (f.status as string[]).filter((s) => VALID_CONTACT_STATUSES.has(s));
    if (filtered.length === 0) {
      return { ok: false, error: 'filter.status không có giá trị hợp lệ' };
    }
    out.status = filtered;
  }

  if (f.source !== undefined) {
    if (!Array.isArray(f.source) || !f.source.every((s) => typeof s === 'string')) {
      return { ok: false, error: 'filter.source phải là mảng string' };
    }
    if ((f.source as string[]).length === 0) {
      return { ok: false, error: 'filter.source không được rỗng' };
    }
    out.source = f.source as string[];
  }

  if (f.tags !== undefined) {
    if (!Array.isArray(f.tags) || !f.tags.every((t) => typeof t === 'string')) {
      return { ok: false, error: 'filter.tags phải là mảng string' };
    }
    if ((f.tags as string[]).length === 0) {
      return { ok: false, error: 'filter.tags không được rỗng' };
    }
    out.tags = f.tags as string[];
  }

  return { ok: true, value: out };
}

/**
 * Convert the API-level filter into a Prisma `where` clause we can hand to
 * `prisma.contact.findMany`. Always scopes to the caller's org. Excludes
 * contacts without a zaloUid since they can't be reached anyway.
 */
export function buildContactWhere(
  orgId: string,
  filter: CampaignFilter,
): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = {
    orgId,
    zaloUid: { not: null },
  };
  if (filter.status && filter.status.length > 0) {
    where.status = { in: filter.status };
  }
  if (filter.source && filter.source.length > 0) {
    where.source = { in: filter.source };
  }
  if (filter.tags && filter.tags.length > 0) {
    // tags is a JSONB array; Prisma's `array_contains` matches when ANY of the
    // requested tags is present in the row's tags array.
    // TODO(0019 Phase C): migrate to `filter.tagIds` reading from `contactTags`
    // junction. Campaigns still save names in `filter.tags` via
    // CampaignCreateDialog — keep the JSON path until that dialog migrates.
    where.tags = { array_contains: filter.tags };
  }
  return where;
}

/**
 * Substitute {{contactName}} and {{firstName}}. Mirrors the helpers in
 * features 0004 and 0005 so behavior is consistent across the app.
 */
export function applyMessagePlaceholders(
  template: string,
  contact: { fullName?: string | null } | null | undefined,
): string {
  const full = (contact?.fullName ?? '').trim();
  const first = full.split(/\s+/)[0] ?? '';
  return template
    .replace(/\{\{contactName\}\}/g, full)
    .replace(/\{\{firstName\}\}/g, first);
}

/**
 * Inter-message delay in milliseconds. Random in [2000, 5000] — uniform.
 * Exported so tests can stub `Math.random` to make timing predictable.
 */
export function nextSendDelayMs(): number {
  return 2000 + Math.floor(Math.random() * 3001);
}

export const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['scheduled', 'running', 'cancelled'],
  scheduled: ['running', 'paused', 'cancelled'],
  running: ['paused', 'completed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: [], // terminal
  cancelled: [], // terminal
};

export function canTransition(from: string, to: string): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
