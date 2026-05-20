/**
 * appointment-parser.ts — Rule-based Vietnamese appointment fallback parser.
 *
 * Pure regex + date math, zero external dependencies. Extracts appointment
 * intent from Zalo chat text such as:
 *  - "hẹn 2pm thứ 5"
 *  - "9h sáng mai gặp em nhé"
 *  - "ngày 20/5 lúc 14h"
 *  - "chiều mai 3 giờ"
 *
 * Detects:
 *  - Relative days: "hôm nay", "mai", "ngày kia", "N ngày nữa"
 *  - Weekdays: "thứ 2..7", "chủ nhật" (and "tuần tới" → +1 week)
 *  - Absolute dates: "DD/MM", "ngày DD/MM", "ngày DD tháng MM"
 *  - Weeks/months: "tuần sau", "tháng sau", "N tuần nữa"
 *  - Time: "HH:MM", "Xh", "Xh sáng/chiều/tối", "Xpm/Xam"
 *  - Type hints: "gọi" → call, "nhắn" → message, "gặp"/"cafe" → meeting
 *
 * Returns `null` when no appointment intent is detected so callers can short-
 * circuit cleanly. When detected, returns a `Date` (combined date + time, time
 * defaulting to 09:00 when omitted), the matched phrase, a 0..1 confidence
 * score, and an optional `type` classification.
 */

export interface ParsedAppointment {
  /** Combined date+time as a JS Date. If only the date matched, time defaults to 09:00. */
  date: Date;
  /** 0..1 confidence score. Higher = more signals matched. */
  confidence: number;
  /** Substring of original text that triggered the detection (trimmed, ≤160 chars). */
  matchedPhrase: string;
  /** Inferred appointment type when a type hint is present. */
  type?: 'call' | 'message' | 'meeting' | 'follow_up';
}

interface InternalParsed {
  isoDate: string | null;
  time: string | null; // "HH:MM"
  type: 'call' | 'message' | 'meeting' | 'follow_up' | null;
  hasIntent: boolean;
  confidence: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  'chủ nhật': 0, cn: 0, 'chu nhat': 0,
  'thứ 2': 1, 'thứ hai': 1, t2: 1, 'thu 2': 1, 'thu hai': 1,
  'thứ 3': 2, 'thứ ba': 2, t3: 2, 'thu 3': 2, 'thu ba': 2,
  'thứ 4': 3, 'thứ tư': 3, t4: 3, 'thu 4': 3, 'thu tu': 3,
  'thứ 5': 4, 'thứ năm': 4, t5: 4, 'thu 5': 4, 'thu nam': 4,
  'thứ 6': 5, 'thứ sáu': 5, t6: 5, 'thu 6': 5, 'thu sau': 5,
  'thứ 7': 6, 'thứ bảy': 6, t7: 6, 'thu 7': 6, 'thu bay': 6,
};

function toIsoDate(d: Date): string {
  // Use local-time components so "today" / "tomorrow" match the user's
  // wall clock rather than UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function nextWeekday(base: Date, target: number, nextWeek = false): Date {
  const cur = base.getDay();
  let diff = (target - cur + 7) % 7;
  if (diff === 0) diff = 7; // same weekday → next week
  if (nextWeek && diff < 7) diff += 7;
  return addDays(base, diff);
}

function parseInternal(text: string, now: Date): InternalParsed {
  const lower = text.toLowerCase().trim();
  if (!lower) return emptyInternal();

  let isoDate: string | null = null;
  let time: string | null = null;
  let type: InternalParsed['type'] = null;
  let confidence = 0;

  // ── Date detection ────────────────────────────────────────────────────
  if (/\b(hôm nay|hom nay|today)\b/i.test(lower)) {
    isoDate = toIsoDate(now);
    confidence += 0.4;
  } else if (/\b(ngày mai|hôm mai|mai|tomorrow)\b/i.test(lower)) {
    isoDate = toIsoDate(addDays(now, 1));
    confidence += 0.5;
  } else if (/\b(ngày kia|hôm kia|kia|mốt|mot)\b/i.test(lower)) {
    isoDate = toIsoDate(addDays(now, 2));
    confidence += 0.5;
  }

  if (!isoDate) {
    const m = lower.match(/(\d+)\s*ngày\s*nữa/i);
    if (m) {
      isoDate = toIsoDate(addDays(now, parseInt(m[1])));
      confidence += 0.45;
    }
  }

  if (!isoDate) {
    const m = lower.match(/(\d+)\s*tuần\s*(nữa|sau|tới)/i);
    if (m) {
      isoDate = toIsoDate(addDays(now, parseInt(m[1]) * 7));
      confidence += 0.4;
    } else if (/\btuần\s*(sau|tới)\b/i.test(lower)) {
      isoDate = toIsoDate(addDays(now, 7));
      confidence += 0.35;
    }
  }

  // "DD/MM" or "ngày DD/MM" or "ngày DD tháng MM"
  if (!isoDate) {
    let m = lower.match(/(?:ngày\s+)?(\d{1,2})\s*[\/\-\.\s]\s*(\d{1,2})(?:\s*[\/\-\.\s]\s*(\d{2,4}))?/);
    if (!m) {
      m = lower.match(/ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{2,4}))?/);
    }
    if (m) {
      const day = parseInt(m[1]);
      const month = parseInt(m[2]);
      const yearRaw = m[3] ? parseInt(m[3]) : now.getFullYear();
      const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        const candidate = new Date(year, month - 1, day);
        // If date already passed in the current year and the year was not
        // explicitly given → assume next year.
        if (!m[3] && candidate.getTime() < now.getTime() - 86_400_000) {
          candidate.setFullYear(year + 1);
        }
        isoDate = toIsoDate(candidate);
        confidence += 0.5;
      }
    }
  }

  // "thứ X" — only check if no date yet
  if (!isoDate) {
    const nextWeekHint = /\b(tuần\s*tới|tuần\s*sau|tuần\s*kế|tới\s*đây)\b/i.test(lower);
    for (const [key, val] of Object.entries(WEEKDAY_MAP)) {
      const pattern = new RegExp(`(^|[^a-zA-Z0-9])${key.replace(/\s+/g, '\\s+')}([^a-zA-Z0-9]|$)`, 'i');
      if (pattern.test(lower)) {
        isoDate = toIsoDate(nextWeekday(now, val, nextWeekHint));
        confidence += nextWeekHint ? 0.45 : 0.4;
        break;
      }
    }
  }

  // ── Time detection ────────────────────────────────────────────────────
  // 1. "Xh tối/sáng/chiều", "Xpm", "Xam"
  let tm = lower.match(/(\d{1,2})\s*(?:h|giờ|h\.|gio)?\s*(tối|toi|sáng|sang|chiều|chieu|trưa|trua|đêm|dem|am|pm)\b/i);
  if (tm) {
    let hour = parseInt(tm[1]);
    const period = tm[2].toLowerCase();
    if (/(tối|toi|chiều|chieu|đêm|dem|pm)/i.test(period) && hour < 12) hour += 12;
    if (/(am|sáng|sang)/i.test(period) && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23) {
      time = `${String(hour).padStart(2, '0')}:00`;
      confidence += 0.3;
    }
  }

  // 2. "lúc HH:MM" or "HH:MM"
  if (!time) {
    const m = lower.match(/(?:lúc\s+)?(\d{1,2}):(\d{2})/);
    if (m) {
      const h = parseInt(m[1]);
      const min = parseInt(m[2]);
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
        time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        confidence += 0.3;
      }
    }
  }

  // 3. "lúc Xh" or "Xh" (with afternoon/evening heuristic)
  if (!time) {
    const m = lower.match(/(?:lúc\s+)?(\d{1,2})\s*(?:h|giờ)(?:\s|$|[^a-zA-Z0-9])/);
    if (m) {
      let h = parseInt(m[1]);
      if (h >= 0 && h <= 23) {
        if (h < 7 && /(tối|chiều|toi|chieu)/i.test(lower)) h += 12;
        time = `${String(h).padStart(2, '0')}:00`;
        confidence += 0.2;
      }
    }
  }

  // 4. Period only (no explicit hour)
  if (!time) {
    if (/\bsáng\b/i.test(lower)) { time = '09:00'; confidence += 0.15; }
    else if (/\btrưa\b/i.test(lower)) { time = '12:00'; confidence += 0.15; }
    else if (/\bchiều\b/i.test(lower)) { time = '14:00'; confidence += 0.15; }
    else if (/\btối\b/i.test(lower)) { time = '19:00'; confidence += 0.15; }
  }

  // ── Type detection ────────────────────────────────────────────────────
  if (/\b(gọi|goi|call|điện thoại|dt|alo)\b/i.test(lower)) type = 'call';
  else if (/\b(nhắn|nhan|tin nhắn|sms|message|chat)\b/i.test(lower)) type = 'message';
  else if (/\b(gặp|gap|cafe|cà phê|ca phe|đi xem|di xem|ghé|ghe|đến|den|meeting|hẹn cafe|hẹn)\b/i.test(lower)) type = 'meeting';
  else type = 'follow_up';

  if (type !== 'follow_up') confidence += 0.15;

  // hasIntent: a date OR a (time + non-followup type) OR an action keyword
  const hasIntent = !!isoDate
    || (!!time && type !== 'follow_up')
    || /\b(gọi|gặp|nhắn|cafe|cà phê|đi xem|ghé|hẹn)\b/i.test(lower);

  if (!hasIntent) return emptyInternal();

  confidence = Math.min(1, Math.max(0.35, confidence));

  return { isoDate, time, type, hasIntent: true, confidence };
}

function emptyInternal(): InternalParsed {
  return { isoDate: null, time: null, type: null, hasIntent: false, confidence: 0 };
}

/**
 * Parse an appointment intent out of free-form Vietnamese chat text.
 *
 * Returns `null` when no appointment intent is present, otherwise returns a
 * concrete `Date` (date + time merged), a `confidence` score in `[0, 1]`, the
 * matched phrase (a trimmed prefix of the input), and an inferred `type`.
 *
 * Pure function — no I/O, no side-effects. Pass `now` for deterministic tests.
 */
export function parseAppointmentFromText(text: string, now: Date = new Date()): ParsedAppointment | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const internal = parseInternal(trimmed, now);
  if (!internal.hasIntent) return null;
  // We need at least a date OR a time to produce a usable Date object.
  if (!internal.isoDate && !internal.time) return null;

  // Build the concrete Date: prefer detected date, fall back to today.
  const baseIso = internal.isoDate ?? toIsoDate(now);
  const [y, m, d] = baseIso.split('-').map((n) => parseInt(n));
  const [hh, mm] = (internal.time ?? '09:00').split(':').map((n) => parseInt(n));
  const date = new Date(y, m - 1, d, hh, mm, 0, 0);

  const matchedPhrase = trimmed.slice(0, 160).replace(/\s+/g, ' ').trim();

  const result: ParsedAppointment = {
    date,
    confidence: internal.confidence,
    matchedPhrase,
  };
  if (internal.type) result.type = internal.type;
  return result;
}
