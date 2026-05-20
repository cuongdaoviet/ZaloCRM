/**
 * Reaction mapping — feature 0021.
 *
 * Two-way mapping between the 6 standard CRM emojis, the zca-js `Reactions`
 * enum (string codes that we feed to `api.addReaction`), and the inbound
 * `rType` numeric code that comes back on the `'reaction'` listener event.
 *
 * ── About the rType numeric codes ────────────────────────────────────────────
 * `zca-js` exposes the `Reactions` STRING enum (`HEART = "/-heart"`, etc.) but
 * does NOT expose the `rType` integer mapping that comes back on the inbound
 * `Reaction` payload. The SPEC §3 (BR-0009) lays out the convention
 *   0=NONE, 1=HEART, 2=LIKE, 3=HAHA, 4=WOW, 5=CRY, 6=ANGRY
 * which matches how Zalo's native UI orders the 6 standard reactions.
 *
 * VERIFICATION: at the time of writing we have no live socket capture to
 * confirm the table. `reaction-listener.ts` logs the first incoming reaction
 * event at INFO level with `{ rType, rIcon, mappedEmoji }` so the very first
 * real reaction observed on staging will either confirm the table or surface
 * the actual mapping — at which point this file is a ~5-LOC fix. Unknown
 * rType values fall through to `custom:<rType>` so they're persisted but
 * never crash the listener (BR-0010 / EC-0007).
 *
 * ── About REACTIONS_ENUM ─────────────────────────────────────────────────────
 * We MIRROR the subset of zca-js's `Reactions` enum that we care about
 * instead of importing it directly. Rationale: matches the pattern used by
 * `friendship-listener.ts` (which mirrors FRIEND_EVENT_TYPE for the same
 * reason) — keeps the integration boundary explicit and lets unit tests
 * import this module without dragging zca-js's runtime into scope. The
 * string values come straight from
 * `node_modules/zca-js/dist/models/Reaction.d.ts`.
 */

/** Subset of zca-js `Reactions` enum that we use (BR-0009 + NONE for unreact). */
export const REACTIONS_ENUM = {
  HEART: '/-heart',
  LIKE: '/-strong',
  HAHA: ':>',
  WOW: ':o',
  CRY: ':-((',
  ANGRY: ':-h',
  NONE: '',
} as const;

export type ReactionCode = (typeof REACTIONS_ENUM)[keyof typeof REACTIONS_ENUM];

/** The 6 emoji characters offered in the UI picker (BR-0009). */
export const STANDARD_EMOJIS = ['❤️', '👍', '😆', '😮', '😭', '😡'] as const;

export type StandardEmoji = (typeof STANDARD_EMOJIS)[number];

/**
 * UI emoji → zca-js `Reactions` enum string code used by `api.addReaction`.
 * NONE is the "unreact" sentinel — we map an explicit toggle-off to
 * `REACTIONS_ENUM.NONE` instead of including it in this table.
 */
export const EMOJI_TO_REACTIONS_ENUM: Record<StandardEmoji, ReactionCode> = {
  '❤️': REACTIONS_ENUM.HEART,
  '👍': REACTIONS_ENUM.LIKE,
  '😆': REACTIONS_ENUM.HAHA,
  '😮': REACTIONS_ENUM.WOW,
  '😭': REACTIONS_ENUM.CRY,
  '😡': REACTIONS_ENUM.ANGRY,
};

/**
 * Inbound `rType` numeric code → UI emoji character.
 * 0 is the "unreact" sentinel — `handleReactionEvent` translates that into a
 * row delete rather than an upsert.
 */
export const RTYPE_TO_EMOJI: Record<number, StandardEmoji> = {
  1: '❤️',
  2: '👍',
  3: '😆',
  4: '😮',
  5: '😭',
  6: '😡',
};

/** UI → zca-js outbound. Throws if the caller passes a non-standard emoji. */
export function emojiToZcaIcon(emoji: string): ReactionCode {
  const mapped = EMOJI_TO_REACTIONS_ENUM[emoji as StandardEmoji];
  if (!mapped) {
    throw new Error(`Unknown standard emoji: ${emoji}`);
  }
  return mapped;
}

/**
 * Inbound rType → emoji character (or `custom:<rType>` for anything outside
 * the 6 standard mapping). Caller passes the literal `rType` integer from
 * the listener payload's `content.rType` field.
 *
 * `rType === 0` is "unreact" — callers should detect that BEFORE calling
 * this (the function returns the custom string for safety, but the listener
 * treats 0 as a row delete signal).
 */
export function rTypeToEmoji(rType: number): string {
  const mapped = RTYPE_TO_EMOJI[rType];
  if (mapped) return mapped;
  return `custom:${rType}`;
}

/** True when `emoji` is one of the 6 standard UI reactions. */
export function isStandardEmoji(emoji: string): emoji is StandardEmoji {
  return STANDARD_EMOJIS.includes(emoji as StandardEmoji);
}
