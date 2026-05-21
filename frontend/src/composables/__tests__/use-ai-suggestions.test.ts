/**
 * Unit tests for the Feature 0036 AI suggestion composable.
 * Mocks axios so we can drive the various success/error states.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useAiSuggestions,
  _clearAiSuggestionCache,
} from '@/composables/use-ai-suggestions';

vi.mock('@/api/index', () => ({
  api: { post: vi.fn() },
}));

import { api } from '@/api/index';

const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  _clearAiSuggestionCache();
  apiPost.mockReset();
});

describe('useAiSuggestions', () => {
  it('populates suggestions on success', async () => {
    apiPost.mockResolvedValueOnce({
      data: {
        suggestions: ['a', 'b', 'c'],
        fromCache: false,
        cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    });
    const { state, fetchSuggestions } = useAiSuggestions(() => 'conv-1');
    await fetchSuggestions();
    expect(state.value.suggestions).toEqual(['a', 'b', 'c']);
    expect(state.value.errorCode).toBeNull();
    expect(state.value.fromCache).toBe(false);
  });

  it('second fetch hits FE cache (no extra api call)', async () => {
    apiPost.mockResolvedValueOnce({
      data: {
        suggestions: ['x', 'y', 'z'],
        fromCache: false,
        cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    });
    const { state, fetchSuggestions } = useAiSuggestions(() => 'conv-2');
    await fetchSuggestions();
    expect(apiPost).toHaveBeenCalledTimes(1);
    await fetchSuggestions();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(state.value.fromCache).toBe(true);
  });

  it('force refresh bypasses FE cache', async () => {
    apiPost.mockResolvedValue({
      data: {
        suggestions: ['1', '2', '3'],
        fromCache: false,
        cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    });
    const { fetchSuggestions } = useAiSuggestions(() => 'conv-3');
    await fetchSuggestions();
    await fetchSuggestions({ force: true });
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('maps 412 ai_disabled', async () => {
    apiPost.mockRejectedValueOnce({
      response: { status: 412, data: { error: 'ai_disabled', message: 'off' } },
    });
    const { state, fetchSuggestions } = useAiSuggestions(() => 'conv-4');
    await fetchSuggestions();
    expect(state.value.errorCode).toBe('ai_disabled');
    expect(state.value.suggestions).toEqual([]);
  });

  it('maps 429 with retryAfter', async () => {
    apiPost.mockRejectedValueOnce({
      response: {
        status: 429,
        data: { error: 'rate_limit_org', message: 'cap', retryAfter: 3600 },
      },
    });
    const { state, fetchSuggestions } = useAiSuggestions(() => 'conv-5');
    await fetchSuggestions();
    expect(state.value.errorCode).toBe('rate_limit_org');
    expect(state.value.retryAfterSec).toBe(3600);
  });

  it('maps 503 → provider_unavailable', async () => {
    apiPost.mockRejectedValueOnce({
      response: { status: 503, data: { error: 'provider_5xx', message: 'down' } },
    });
    const { state, fetchSuggestions } = useAiSuggestions(() => 'conv-6');
    await fetchSuggestions();
    expect(state.value.errorCode).toBe('provider_unavailable');
  });
});
