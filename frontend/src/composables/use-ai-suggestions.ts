/**
 * Composable for Feature 0036 — AI reply suggestions.
 *
 * Owns:
 *   - The 3-string suggestion array shown in the chip strip.
 *   - Per-conversation cache (mirrors backend's 5min TTL so two component
 *     mount/unmount cycles don't refetch immediately).
 *   - Refresh + error states (provider down, rate-limited, ai_disabled).
 *
 * The backend response carries `fromCache` + `cachedUntil`; we surface both
 * so the UI can hint at staleness.
 */
import { ref, computed } from 'vue';
import { api } from '@/api/index';

export interface AiSuggestionResponse {
  suggestions: string[];
  fromCache: boolean;
  cachedUntil: string;
  provider: string;
  model: string;
}

export type AiSuggestionErrorCode =
  | 'ai_disabled'
  | 'rate_limit_org'
  | 'rate_limit_user'
  | 'provider_unavailable'
  | 'no_inbound'
  | 'unknown';

export interface UseAiSuggestionsState {
  suggestions: string[];
  fromCache: boolean;
  cachedUntil: string | null;
  loading: boolean;
  errorCode: AiSuggestionErrorCode | null;
  errorMessage: string;
  retryAfterSec: number | null;
}

// Frontend-side cache to avoid refetching on simple navigation away/back.
// Backend TTL is 5min; we shadow that.
const FE_CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<
  string,
  { resp: AiSuggestionResponse; fetchedAt: number }
>();

export function useAiSuggestions(conversationId: () => string | null) {
  const state = ref<UseAiSuggestionsState>({
    suggestions: [],
    fromCache: false,
    cachedUntil: null,
    loading: false,
    errorCode: null,
    errorMessage: '',
    retryAfterSec: null,
  });

  const canShow = computed(
    () =>
      state.value.errorCode !== 'ai_disabled' &&
      state.value.errorCode !== 'no_inbound',
  );

  function readCache(id: string): AiSuggestionResponse | null {
    const hit = cache.get(id);
    if (!hit) return null;
    if (Date.now() - hit.fetchedAt > FE_CACHE_TTL_MS) {
      cache.delete(id);
      return null;
    }
    return hit.resp;
  }

  async function fetchSuggestions(opts: { force?: boolean } = {}): Promise<void> {
    const id = conversationId();
    if (!id) return;

    if (!opts.force) {
      const hit = readCache(id);
      if (hit) {
        state.value = {
          suggestions: hit.suggestions,
          fromCache: true,
          cachedUntil: hit.cachedUntil,
          loading: false,
          errorCode: null,
          errorMessage: '',
          retryAfterSec: null,
        };
        return;
      }
    }

    state.value.loading = true;
    state.value.errorCode = null;
    state.value.errorMessage = '';
    try {
      const res = await api.post<AiSuggestionResponse>(
        `/conversations/${id}/ai-suggestions`,
      );
      state.value = {
        suggestions: res.data.suggestions,
        fromCache: res.data.fromCache,
        cachedUntil: res.data.cachedUntil,
        loading: false,
        errorCode: null,
        errorMessage: '',
        retryAfterSec: null,
      };
      cache.set(id, { resp: res.data, fetchedAt: Date.now() });
    } catch (err: unknown) {
      type ErrShape = {
        response?: {
          status?: number;
          data?: { error?: string; message?: string; retryAfter?: number };
        };
        message?: string;
      };
      const e = err as ErrShape;
      const code = e.response?.data?.error ?? '';
      let mapped: AiSuggestionErrorCode = 'unknown';
      if (code === 'ai_disabled') mapped = 'ai_disabled';
      else if (code === 'rate_limit_org') mapped = 'rate_limit_org';
      else if (code === 'rate_limit_user') mapped = 'rate_limit_user';
      else if (code === 'no_inbound') mapped = 'no_inbound';
      else if (e.response?.status === 502 || e.response?.status === 503)
        mapped = 'provider_unavailable';
      else mapped = 'unknown';

      state.value = {
        suggestions: [],
        fromCache: false,
        cachedUntil: null,
        loading: false,
        errorCode: mapped,
        errorMessage: e.response?.data?.message ?? e.message ?? '',
        retryAfterSec: e.response?.data?.retryAfter ?? null,
      };
    }
  }

  function clear(): void {
    state.value = {
      suggestions: [],
      fromCache: false,
      cachedUntil: null,
      loading: false,
      errorCode: null,
      errorMessage: '',
      retryAfterSec: null,
    };
  }

  function invalidate(): void {
    const id = conversationId();
    if (id) cache.delete(id);
  }

  return {
    state,
    canShow,
    fetchSuggestions,
    clear,
    invalidate,
  };
}

// Test-only escape hatch.
export function _clearAiSuggestionCache(): void {
  cache.clear();
}
