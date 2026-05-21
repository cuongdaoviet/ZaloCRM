/**
 * Feature 0029 — Zinstant (bank/QR card) payload parser.
 *
 * Zalo "zinstant" cards are share-cards rendered as native UI in the Zalo
 * client. Most common variant is a bank-transfer card carrying account
 * number, bank name, amount, description, and a QR image URL. The schema
 * is undocumented and Zalo ships variants without warning, so this parser
 * is intentionally permissive: it pulls known fields from a couple of
 * candidate locations, falls back to `null` / `''` for missing data, and
 * returns `null` for anything it cannot recognise as JSON (BR-0004).
 */
export interface ZinstantData {
  bankCode: string | null;
  bankName: string | null;
  accountNumber: string;
  accountName: string;
  amount: number | null;
  description: string;
  qrUrl: string | null;
}

/**
 * Parse a stringified zinstant payload (the Message.content column).
 * Returns `null` when the payload is not JSON or is shaped in a way we
 * cannot extract any known fields from — caller should render the
 * "📦 Thông tin Zalo" fallback in that case (EC-0001).
 */
export function parseZinstant(rawContent: string | null | undefined): ZinstantData | null {
  if (!rawContent || typeof rawContent !== 'string') return null;
  // The `@@ZINSTANT@@` plain-text marker is sometimes the entire content
  // when Zalo can't serialise the card — nothing we can extract.
  if (!rawContent.trim().startsWith('{')) return null;

  let obj: any;
  try {
    obj = JSON.parse(rawContent);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  // Zalo nests bank fields under `params` (sometimes itself a JSON string).
  let params: any = obj.params;
  if (typeof params === 'string') {
    try {
      params = JSON.parse(params);
    } catch {
      params = {};
    }
  }
  params = params && typeof params === 'object' ? params : {};

  const data: ZinstantData = {
    bankCode: pickString(params.bankCode, obj.bankCode),
    bankName: pickString(params.bankName, obj.bankName),
    accountNumber: pickString(params.accountNumber, obj.accountNumber) ?? '',
    accountName: pickString(params.accountName, obj.accountName) ?? '',
    amount: pickAmount(params.amount, obj.amount),
    description: pickString(
      params.description,
      params.note,
      obj.description,
      obj.note,
    ) ?? '',
    qrUrl: pickString(params.qrUrl, params.qrCode, obj.qrUrl, obj.qrCode),
  };

  // If we extracted absolutely nothing useful, give up so the caller can
  // render the generic fallback rather than an empty bank card.
  const hasAnything =
    data.accountNumber ||
    data.accountName ||
    data.bankName ||
    data.qrUrl ||
    data.amount !== null;
  if (!hasAnything) return null;

  return data;
}

function pickString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
    if (typeof c === 'number' && Number.isFinite(c)) return String(c);
  }
  return null;
}

function pickAmount(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
    if (typeof c === 'string' && c.trim() !== '') {
      const n = Number(c.replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Vietnamese VND amount formatter. Used by ZinstantCard.
 */
export function formatVnd(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount);
}
