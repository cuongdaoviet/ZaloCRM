/**
 * Feature 0043 — Hover-prefetch + in-memory cache for conversation messages.
 *
 * Three strategies wired together:
 *   • hover ≥ 200ms triggers a silent fetch (BR-0001 / AC-0001)
 *   • cache TTL 5 min keyed by conversationId (BR-0001)
 *   • getCached() lets the click handler render instantly (BR-0002 / AC-0002)
 *
 * The composable is hand-rolled (no third-party debounce util) to stay
 * dependency-free and to make timer cancellation easy for AC-0004 (hover
 * spam → only the latest survives).
 */
import { api } from '@/api/index';
import type { Message } from '@/composables/use-chat';

/** Result wrapper exposed to consumers. */
export interface ConversationPrefetch {
  /** Mouse entered a row — start the 200ms hover timer. */
  onHover: (conversationId: string) => void;
  /** Mouse left the row before the timer fired — cancel. */
  onHoverLeave: () => void;
  /** Synchronous lookup; returns null on cache miss / expired entry. */
  getCached: (conversationId: string) => Message[] | null;
  /** Force a prefetch (e.g. immediately after click for revalidate). */
  prefetch: (conversationId: string) => Promise<void>;
  /** Manually drop an entry (e.g. after sending a message we'll refetch). */
  invalidate: (conversationId: string) => void;
  /** Test / dev helper — clears every cache entry + pending timer. */
  clear: () => void;
}

/** Internal cache row — timestamped for TTL eviction. */
interface CacheEntry {
  messages: Message[];
  ts: number;
}

const HOVER_DELAY_MS = 200;
const CACHE_TTL_MS = 5 * 60_000;
const PREFETCH_LIMIT = 50;

export function useConversationPrefetch(): ConversationPrefetch {
  const cache = new Map<string, CacheEntry>();
  // In-flight requests keyed by id — dedupes the click-after-hover race
  // (BR-0002): if a hover prefetch is pending when the user clicks the same
  // row, we don't want to fire a second GET.
  const inflight = new Map<string, Promise<void>>();
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHoverTimer(): void {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onHover(conversationId: string): void {
    // EC-0004 — only the most recent hover survives. Cancelling here means
    // a spammed list (cursor flying over 20 rows) only fires the last
    // prefetch, not 20.
    clearHoverTimer();
    hoverTimer = setTimeout(() => {
      void prefetch(conversationId);
      hoverTimer = null;
    }, HOVER_DELAY_MS);
  }

  function onHoverLeave(): void {
    clearHoverTimer();
  }

  function getCached(conversationId: string): Message[] | null {
    const entry = cache.get(conversationId);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      // Stale — drop it and let the caller decide whether to revalidate
      // (EC-0001 handles the silent-refresh path in use-chat).
      cache.delete(conversationId);
      return null;
    }
    return entry.messages;
  }

  async function prefetch(conversationId: string): Promise<void> {
    // Reuse the inflight promise so two hovers on the same row only fetch
    // once (and the click-after-hover case piggybacks).
    const existing = inflight.get(conversationId);
    if (existing) return existing;

    const job = (async () => {
      try {
        const res = await api.get(
          `/conversations/${conversationId}/messages`,
          { params: { limit: PREFETCH_LIMIT } },
        );
        const messages: Message[] = res.data?.messages ?? [];
        cache.set(conversationId, { messages, ts: Date.now() });
      } catch {
        // Silent: prefetch is best-effort. The click path will retry via
        // the normal fetchMessages flow and surface real errors there.
      } finally {
        inflight.delete(conversationId);
      }
    })();

    inflight.set(conversationId, job);
    return job;
  }

  function invalidate(conversationId: string): void {
    cache.delete(conversationId);
  }

  function clear(): void {
    cache.clear();
    inflight.clear();
    clearHoverTimer();
  }

  return {
    onHover,
    onHoverLeave,
    getCached,
    prefetch,
    invalidate,
    clear,
  };
}

// Exported only for tests — keep these in sync with the constants above so
// the test suite can assert hover timing & TTL behaviour without magic
// numbers drifting between files.
export const PREFETCH_INTERNALS = {
  HOVER_DELAY_MS,
  CACHE_TTL_MS,
  PREFETCH_LIMIT,
} as const;
