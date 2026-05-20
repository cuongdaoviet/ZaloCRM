/**
 * Composable for feature 0017 — Vietnamese appointment fallback parser.
 *
 * Wraps `POST /api/v1/appointments/parse` and exposes a helper that picks the
 * most recent contact-sent text message and parses it. Includes a tiny
 * single-slot cache so the same text isn't re-parsed twice in a row.
 */
import { api } from '@/api/index';
import type { Message } from '@/composables/use-chat';

export interface ParsedAppointment {
  /** ISO date+time string (serialised JS Date). */
  date: string;
  /** 0..1 confidence score. */
  confidence: number;
  /** Substring of the original message that triggered detection. */
  matchedPhrase: string;
  /** Inferred type — call / message / meeting / follow_up. */
  type?: 'call' | 'message' | 'meeting' | 'follow_up';
}

// Single-slot in-memory cache. Key = exact text we last asked the backend
// about; Value = the result (or null). Cleared on full reload, scoped to the
// composable lifetime.
let lastQueryText: string | null = null;
let lastQueryResult: ParsedAppointment | null = null;

export function useAppointmentParser() {
  /**
   * Find the most recent contact (incoming) text message and return its parsed
   * appointment intent, or `null` if none was found.
   *
   * Non-text messages (images / attachments) and outbound messages ("self")
   * are skipped. Returns `null` immediately when the latest incoming text
   * matches the previous call's text — saving a round-trip.
   */
  async function parseLatestIncoming(messages: Message[]): Promise<ParsedAppointment | null> {
    if (!messages?.length) return null;

    // Walk from the newest message backwards. The chat composable stores
    // messages ascending by sentAt, so we iterate from the tail.
    let latestIncomingText: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.senderType === 'self') continue;
      if (msg.isDeleted) continue;
      if (!msg.content) continue;
      if (msg.contentType && msg.contentType !== 'text') continue;
      latestIncomingText = msg.content;
      break;
    }

    if (!latestIncomingText) return null;

    // Cache hit — skip the network round trip.
    if (latestIncomingText === lastQueryText) {
      return lastQueryResult;
    }

    try {
      const res = await api.post('/appointments/parse', { text: latestIncomingText });
      // The backend returns `{ result: null }` when no intent was found, or
      // the parsed object directly otherwise.
      const body = res.data as ParsedAppointment | { result: null };
      const parsed: ParsedAppointment | null =
        body && 'result' in body && body.result === null ? null : (body as ParsedAppointment);

      lastQueryText = latestIncomingText;
      lastQueryResult = parsed;
      return parsed;
    } catch (err) {
      // Swallow — this is a "nice-to-have" suggestion, never block the UI.
      console.error('[appointment-parser] parse error:', err);
      return null;
    }
  }

  function resetCache(): void {
    lastQueryText = null;
    lastQueryResult = null;
  }

  return { parseLatestIncoming, resetCache };
}
