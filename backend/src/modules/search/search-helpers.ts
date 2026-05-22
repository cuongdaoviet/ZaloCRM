/**
 * Pure helpers for the message search endpoint — kept side-effect free so they
 * unit-test cleanly without Prisma or Fastify.
 */

const MIN_QUERY_LEN = 2;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;
const SNIPPET_LEN = 80;
const SNIPPET_HALF = Math.floor(SNIPPET_LEN / 2);
const SENDER_TYPES = new Set(['self', 'contact']);
const CONTENT_TYPES = new Set([
  'text',
  'image',
  'file',
  'sticker',
  'voice',
  'video',
  'gif',
  'link',
  'location',
  'rich',
  'contact_card',
]);

export interface SearchFilters {
  q: string;
  from: Date | null;
  to: Date | null;
  senderType: 'self' | 'contact' | null;
  contentType: string | null;
  accountId: string | null;
  conversationId: string | null;
  contactId: string | null;
  page: number;
  limit: number;
}

/**
 * Parse + validate raw query string params. Returns either typed filters or
 * a 400-friendly error message. Keeps every validation rule in one place.
 */
export function validateSearchInput(
  raw: Record<string, unknown>,
): { ok: true; value: SearchFilters } | { ok: false; error: string } {
  const q = typeof raw.q === 'string' ? raw.q.trim() : '';
  if (q.length < MIN_QUERY_LEN) {
    return { ok: false, error: `q phải dài tối thiểu ${MIN_QUERY_LEN} ký tự` };
  }

  const from = parseDate(raw.from);
  const to = parseDate(raw.to);
  if (from === 'invalid' || to === 'invalid') {
    return { ok: false, error: 'from/to phải là ISO datetime hợp lệ' };
  }
  if (from && to && from.getTime() >= to.getTime()) {
    return { ok: false, error: 'from phải nhỏ hơn to' };
  }

  const senderType = typeof raw.senderType === 'string' ? raw.senderType : null;
  if (senderType !== null && !SENDER_TYPES.has(senderType)) {
    return { ok: false, error: 'senderType phải là "self" hoặc "contact"' };
  }

  const contentType = typeof raw.contentType === 'string' ? raw.contentType : null;
  if (contentType !== null && !CONTENT_TYPES.has(contentType)) {
    return { ok: false, error: `contentType không hợp lệ: ${contentType}` };
  }

  const page = parsePositiveInt(raw.page, 1);
  if (page === null) return { ok: false, error: 'page phải là số nguyên dương' };

  const limitRaw = parsePositiveInt(raw.limit, DEFAULT_LIMIT);
  if (limitRaw === null) return { ok: false, error: 'limit phải là số nguyên dương' };
  const limit = Math.min(limitRaw, MAX_LIMIT);

  return {
    ok: true,
    value: {
      q,
      from,
      to,
      senderType: senderType as 'self' | 'contact' | null,
      contentType,
      accountId: optionalString(raw.accountId),
      conversationId: optionalString(raw.conversationId),
      contactId: optionalString(raw.contactId),
      page,
      limit,
    },
  };
}

function optionalString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function parsePositiveInt(v: unknown, fallback: number): number | null {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseDate(v: unknown): Date | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return 'invalid';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

/**
 * Strip Zalo's JSON-stringified envelope from `content` so search snippets
 * render the human-readable label rather than the raw payload. Mirrors the
 * frontend `formatMessagePreview` helper. Returns the original string when
 * the content is plain text or when parsing fails.
 *
 * Used to prevent `{"title":"Thầy Việt xin phép..."}` from leaking into
 * snippet results for card-type messages.
 */
export function stripJsonEnvelope(content: string | null | undefined): string {
  if (!content) return '';
  if (!content.trimStart().startsWith('{')) return content;
  try {
    const p = JSON.parse(content) as Record<string, unknown>;
    // Specific case first: Zalo reminder/calendar messages.
    if (p?.action === 'msginfo.actionlist' && typeof p?.title === 'string') {
      return p.title;
    }
    // Generic fallback — try common label fields in descending richness.
    if (typeof p?.title === 'string' && p.title) return p.title;
    if (typeof p?.text === 'string' && p.text) return p.text;
    if (typeof p?.description === 'string' && p.description) return p.description;
    if (typeof p?.name === 'string' && p.name) return p.name;
    return content; // valid JSON but no human label — fall back to raw
  } catch {
    return content; // starts with `{` but isn't JSON
  }
}

/**
 * Build a highlighted snippet around the first case-insensitive match of
 * `query` inside `content`. Wraps the match in `**...**` so the frontend can
 * render it bold without trusting raw HTML. If the content is shorter than
 * SNIPPET_LEN we keep all of it; otherwise we slice ±40 chars around the
 * match and prefix/suffix with `…` where we truncated.
 *
 * Content is passed through `stripJsonEnvelope` first so Zalo card/JSON
 * payloads render their human label, not the raw blob.
 */
export function buildSnippet(rawContent: string | null | undefined, query: string): string {
  const content = stripJsonEnvelope(rawContent);
  if (!content) return '';
  const idx = content.toLowerCase().indexOf(query.toLowerCase());

  if (idx === -1) {
    // No match found in the surface text — defensive fallback. Should be rare
    // since Prisma already filtered the row by `content contains query`.
    return content.length <= SNIPPET_LEN ? content : content.slice(0, SNIPPET_LEN) + '…';
  }

  const matched = content.slice(idx, idx + query.length);
  const wrap = (s: string) => `**${s}**`;

  if (content.length <= SNIPPET_LEN) {
    return content.slice(0, idx) + wrap(matched) + content.slice(idx + query.length);
  }

  const start = Math.max(0, idx - SNIPPET_HALF);
  const end = Math.min(content.length, idx + query.length + SNIPPET_HALF);
  const prefix = start === 0 ? '' : '…';
  const suffix = end === content.length ? '' : '…';

  const before = content.slice(start, idx);
  const after = content.slice(idx + query.length, end);

  return prefix + before + wrap(matched) + after + suffix;
}
