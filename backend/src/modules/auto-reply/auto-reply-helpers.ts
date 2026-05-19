/**
 * Pure helpers for auto-reply — kept free of Prisma/Fastify so they can be
 * unit-tested without spinning anything up.
 */

export interface RuleSnapshot {
  enabled: boolean;
  daysOfWeek: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
}

export interface IncomingMessageSnapshot {
  threadType: 'user' | 'group';
  isSelf: boolean;
}

/**
 * Validate a payload coming from PUT /auto-reply. Mirrors the SPEC §5
 * validation table. Returns either cleaned input or a 400-friendly error.
 */
export interface ValidatedRule {
  enabled: boolean;
  daysOfWeek: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
  message: string;
  cooldownMinutes: number;
}

export function validateRuleInput(
  body: unknown,
): { ok: true; value: ValidatedRule } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body không hợp lệ' };
  }
  const b = body as Record<string, unknown>;

  const enabled = b.enabled === undefined ? true : Boolean(b.enabled);

  const daysOfWeek = numField(b.daysOfWeek, 62);
  if (!Number.isInteger(daysOfWeek) || daysOfWeek < 0 || daysOfWeek > 127) {
    return { ok: false, error: 'daysOfWeek phải là số nguyên 0-127' };
  }

  const startMinute = numField(b.startMinute, 480);
  const endMinute = numField(b.endMinute, 1080);
  if (
    !Number.isInteger(startMinute) ||
    !Number.isInteger(endMinute) ||
    startMinute < 0 ||
    endMinute > 1440 ||
    startMinute >= endMinute
  ) {
    return {
      ok: false,
      error: 'startMinute, endMinute phải 0-1440 và startMinute < endMinute',
    };
  }

  const timezone = typeof b.timezone === 'string' && b.timezone.trim() !== ''
    ? b.timezone.trim()
    : 'Asia/Ho_Chi_Minh';
  if (!isValidTimezone(timezone)) {
    return { ok: false, error: `Timezone không hợp lệ: ${timezone}` };
  }

  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length < 1 || message.length > 1000) {
    return { ok: false, error: 'message phải dài 1-1000 ký tự' };
  }

  const cooldownMinutes = numField(b.cooldownMinutes, 240);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 10080) {
    return { ok: false, error: 'cooldownMinutes phải 1-10080' };
  }

  return {
    ok: true,
    value: { enabled, daysOfWeek, startMinute, endMinute, timezone, message, cooldownMinutes },
  };
}

function numField(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isValidTimezone(tz: string): boolean {
  try {
    // Constructor throws RangeError on invalid IANA names
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert an instant to {dayOfWeek, minuteOfDay} in the rule's timezone.
 * Returned dayOfWeek follows JS Date: 0 = Sunday, 6 = Saturday — same encoding
 * the bitmask uses.
 */
export function localTimeInZone(
  date: Date,
  timezone: string,
): { dayOfWeek: number; minuteOfDay: number } {
  // Intl.DateTimeFormat with the right options gives us the local-clock parts
  // for any timezone without dragging in moment-tz.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeek = dayMap[weekdayStr] ?? 0;
  return { dayOfWeek, minuteOfDay: hour * 60 + minute };
}

/**
 * Decide whether the rule's active window currently covers `now`.
 * "Active window" = working hours, where we should NOT auto-reply.
 */
export function isInActiveWindow(rule: RuleSnapshot, now: Date): boolean {
  const { dayOfWeek, minuteOfDay } = localTimeInZone(now, rule.timezone);
  const isWorkDay = (rule.daysOfWeek & (1 << dayOfWeek)) !== 0;
  const isWorkHour = minuteOfDay >= rule.startMinute && minuteOfDay < rule.endMinute;
  return isWorkDay && isWorkHour;
}

/**
 * Synchronous-only decisions: skip auto-reply if the rule is off, the thread
 * is a group, the message is self, or we're inside the active window.
 * Caller must still check cooldown + recent-staff-activity in the DB.
 */
export function passesStaticGates(rule: RuleSnapshot, msg: IncomingMessageSnapshot, now: Date): boolean {
  if (!rule.enabled) return false;
  if (msg.threadType !== 'user') return false;
  if (msg.isSelf) return false;
  if (isInActiveWindow(rule, now)) return false;
  return true;
}

/**
 * Substitute {{contactName}} and {{firstName}}. Mirrors the helper from
 * feature 0004 so the two features behave consistently.
 */
export function substitutePlaceholders(
  content: string,
  contact: { fullName?: string | null } | null | undefined,
): string {
  const full = (contact?.fullName ?? '').trim();
  const first = full.split(/\s+/)[0] ?? '';
  return content.replace(/\{\{contactName\}\}/g, full).replace(/\{\{firstName\}\}/g, first);
}
