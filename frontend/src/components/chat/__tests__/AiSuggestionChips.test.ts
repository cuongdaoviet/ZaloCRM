/**
 * Component tests for AiSuggestionChips — Feature 0036.
 * Renders the chip strip; asserts pick + refresh emit / call paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AiSuggestionChips from '@/components/chat/AiSuggestionChips.vue';
import { _clearAiSuggestionCache } from '@/composables/use-ai-suggestions';

vi.mock('@/api/index', () => ({
  api: { post: vi.fn() },
}));

import { api } from '@/api/index';

const apiPost = api.post as unknown as ReturnType<typeof vi.fn>;

// Stubs render plain native elements. We rely on Vue 3's fallthrough attribute
// behavior to wire the parent's @click listener to the root <button> — manually
// emitting a 'click' on top of that would fire the parent's handler twice
// because Vue Test Utils' click trigger dispatches a real DOM event.
const STUBS = {
  'v-icon': { template: '<i><slot /></i>' },
  'v-chip': {
    props: ['size', 'variant', 'color'],
    template: '<button class="v-chip-stub"><slot /></button>',
  },
  'v-btn': {
    template: '<button class="v-btn-stub"><slot /></button>',
  },
  'v-skeleton-loader': { template: '<span class="sk-stub" />' },
};

beforeEach(() => {
  _clearAiSuggestionCache();
  apiPost.mockReset();
});

function mountChips(conversationId: string | null, enabled: boolean) {
  return mount(AiSuggestionChips, {
    props: { conversationId, enabled },
    global: { stubs: STUBS },
  });
}

describe('AiSuggestionChips', () => {
  it('does not render when enabled=false', () => {
    const wrapper = mountChips('c1', false);
    expect(wrapper.find('[data-testid="ai-suggestion-chips"]').exists()).toBe(false);
  });

  it('renders 3 chips after successful fetch (AC-0013)', async () => {
    apiPost.mockResolvedValueOnce({
      data: {
        suggestions: ['Chào em', 'Em đang bận chút', 'Em gọi lại sau nha'],
        fromCache: false,
        cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    });
    const wrapper = mountChips('c1', true);
    await flushPromises();
    const chips = wrapper.findAll('[data-testid^="ai-chip-"]');
    expect(chips).toHaveLength(3);
    expect(chips[0].text()).toContain('Chào em');
  });

  it('click chip emits pick(text) (AC-0013)', async () => {
    apiPost.mockResolvedValueOnce({
      data: {
        suggestions: ['a', 'b', 'c'],
        fromCache: false,
        cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    });
    const wrapper = mountChips('c2', true);
    await flushPromises();
    await wrapper.find('[data-testid="ai-chip-1"]').trigger('click');
    const picks = wrapper.emitted('pick');
    expect(picks).toBeDefined();
    expect(picks?.[0]).toEqual(['b']);
  });

  it('refresh button re-fetches with force=true (AC-0013)', async () => {
    apiPost.mockResolvedValue({
      data: {
        suggestions: ['x', 'y', 'z'],
        fromCache: false,
        cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    });
    const wrapper = mountChips('c3', true);
    await flushPromises();
    expect(apiPost).toHaveBeenCalledTimes(1);
    await wrapper.find('[data-testid="ai-suggest-refresh"]').trigger('click');
    await flushPromises();
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('renders rate-limit warning on 429 (AC-0008/AC-0009 surface)', async () => {
    apiPost.mockRejectedValueOnce({
      response: {
        status: 429,
        data: { error: 'rate_limit_org', message: 'cap', retryAfter: 3600 },
      },
    });
    const wrapper = mountChips('c4', true);
    await flushPromises();
    expect(wrapper.text()).toMatch(/Đã đạt giới hạn/);
  });

  it('renders provider-unavailable + retry button on 503', async () => {
    apiPost.mockRejectedValueOnce({
      response: { status: 503, data: { error: 'provider_5xx' } },
    });
    const wrapper = mountChips('c5', true);
    await flushPromises();
    expect(wrapper.text()).toMatch(/tạm không khả dụng/);
  });

  it('hides itself on ai_disabled', async () => {
    apiPost.mockRejectedValueOnce({
      response: { status: 412, data: { error: 'ai_disabled' } },
    });
    const wrapper = mountChips('c6', true);
    await flushPromises();
    expect(wrapper.find('[data-testid="ai-suggestion-chips"]').exists()).toBe(false);
  });
});
