/**
 * Feature 0026 — Mention rendering + auto-complete helpers.
 *
 * Group chats use raw "@<uid>" tokens for mentions (matching Zalo's wire
 * format — see SPEC.md BR-0001). These helpers:
 *   - parseMentions: split a message content string into alternating text +
 *     mention parts so MessageThread can render styled chips.
 *   - detectMentionTrigger: detect the "@<query>" token at the caret in the
 *     composer input. Only triggers when "@" follows whitespace / line start
 *     (BR-0004) to avoid email collision (user@example.com).
 *   - filterMembers: case-insensitive, NFC-normalized prefix filter against
 *     displayName, sorted alphabetically, capped to top 10 (BR-0005).
 *   - applyMentionInsert: splice "@<uid> " (with trailing space) into the
 *     input string at the trigger position (BR-0007).
 */

/** Regex defined by SPEC BR-0002: @ immediately followed by 6-20 digits. */
export const MENTION_REGEX = /@(\d{6,20})/g;

/** Maximum members shown in the picker after filtering (SPEC BR-0005). */
export const MENTION_PICKER_LIMIT = 10;

export interface GroupMember {
  uid: string;
  displayName: string;
  avatarUrl: string;
}

export type MentionPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; uid: string; displayName: string; found: boolean };

/**
 * Split a message content string into alternating text + mention parts so the
 * UI can render mention chips inline.
 *
 * - For each "@<uid>" token, look up the uid in memberMap:
 *   - found    → { kind: 'mention', displayName, found: true }
 *   - not found → { kind: 'mention', displayName: uid, found: false }
 *     (caller renders muted fallback text — see SPEC BR-0002).
 * - Text outside mention tokens becomes { kind: 'text' } parts.
 *
 * Empty input → single empty text part for stable Vue keying.
 */
export function parseMentions(
  content: string | null | undefined,
  memberMap: Map<string, GroupMember> | ReadonlyMap<string, GroupMember>,
): MentionPart[] {
  if (!content) return [{ kind: 'text', text: '' }];

  const parts: MentionPart[] = [];
  // Use a fresh regex instance so callers don't have to worry about lastIndex
  // pollution from the shared MENTION_REGEX constant.
  const re = new RegExp(MENTION_REGEX.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      parts.push({ kind: 'text', text: content.slice(lastIndex, start) });
    }
    const uid = match[1];
    const member = memberMap.get(uid);
    parts.push({
      kind: 'mention',
      uid,
      displayName: member?.displayName ?? uid,
      found: !!member,
    });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < content.length) {
    parts.push({ kind: 'text', text: content.slice(lastIndex) });
  }
  if (parts.length === 0) {
    parts.push({ kind: 'text', text: '' });
  }
  return parts;
}

export interface MentionTrigger {
  /** Index of the @ character in the input string. */
  atIndex: number;
  /** Text typed AFTER @, before the caret. May be empty. */
  query: string;
  /** Caret position (end of trigger). */
  caret: number;
}

/**
 * Detect whether the caret is positioned inside an active mention trigger
 * ("@<query>" where query is letters/digits/spaces-free).
 *
 * Returns null when no trigger is active. Otherwise returns the trigger
 * descriptor so callers can position the picker and splice on select.
 *
 * Rules (SPEC BR-0004, EC-0003, EC-0005):
 *   - The @ must be at the start of the input OR directly preceded by
 *     a whitespace char (space, tab, newline). Avoids email collision.
 *   - The query (chars between @ and caret) must NOT contain whitespace.
 *     Once the user types a space the picker should close.
 *   - The query has a soft max length of 30 to prevent runaway open state.
 *   - If multiple @ exist, only the latest one before the caret is
 *     considered (EC-0003: "@a@b" → trigger for "@b").
 */
export function detectMentionTrigger(
  value: string,
  caret: number,
): MentionTrigger | null {
  if (caret <= 0 || caret > value.length) return null;
  // Scan backwards from caret to find the most recent @. Bail out if we
  // hit whitespace first — that means the caret isn't inside a token.
  let atIndex = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === '@') {
      atIndex = i;
      break;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') return null;
  }
  if (atIndex < 0) return null;
  // BR-0004 — @ must follow whitespace or be at the start.
  if (atIndex > 0) {
    const prev = value[atIndex - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n') return null;
  }
  const query = value.slice(atIndex + 1, caret);
  // Cap query length so we don't keep the picker open through a paragraph.
  if (query.length > 30) return null;
  return { atIndex, query, caret };
}

/**
 * Case-insensitive NFC-normalized prefix filter on displayName, sorted
 * alphabetically (Vietnamese locale). Caps at MENTION_PICKER_LIMIT.
 *
 * Empty query → returns the first N members sorted by displayName so the
 * picker still shows something useful right after @.
 */
export function filterMembers(
  members: readonly GroupMember[],
  query: string,
): GroupMember[] {
  const normQuery = query.normalize('NFC').toLowerCase().trim();
  const sorted = [...members].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'vi'),
  );
  if (!normQuery) return sorted.slice(0, MENTION_PICKER_LIMIT);
  return sorted
    .filter((m) =>
      m.displayName.normalize('NFC').toLowerCase().startsWith(normQuery),
    )
    .slice(0, MENTION_PICKER_LIMIT);
}

export interface MentionInsertResult {
  /** New input string with "@<uid> " substituted at the trigger. */
  value: string;
  /** New caret position (right after the trailing space). */
  caret: number;
}

/**
 * Replace the text from trigger.atIndex to trigger.caret with "@<uid> "
 * (trailing space included per BR-0007). Returns the new input value + caret.
 */
export function applyMentionInsert(
  value: string,
  trigger: MentionTrigger,
  member: GroupMember,
): MentionInsertResult {
  const before = value.slice(0, trigger.atIndex);
  const after = value.slice(trigger.caret);
  const token = `@${member.uid} `;
  return {
    value: before + token + after,
    caret: before.length + token.length,
  };
}
