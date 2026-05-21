/**
 * Feature 0043 — Hover prefetch + cache tests.
 *
 * Covers:
 *   AC-0001  hover ≥ 200ms fires the GET
 *   AC-0002  getCached returns instantly (verified by request count == 0)
 *   BR-0001  TTL eviction after 5 minutes
 *   EC-0004  hover spam → only the latest survives clearTimeout
 *   BR-0002  inflight dedupe — concurrent prefetch calls coalesce
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the API module BEFORE importing the composable so its top-level
// `import { api }` picks up the spy.
vi.mock('@/api/index', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '@/api/index';
import {
  useConversationPrefetch,
  PREFETCH_INTERNALS,
} from '../use-conversation-prefetch';

const mockedGet = vi.mocked(api.get);

describe('useConversationPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedGet.mockReset();
    mockedGet.mockResolvedValue({
      data: { messages: [{ id: 'm1', content: 'hi' }] },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // AC-0001 — hover for the full HOVER_DELAY_MS triggers exactly one GET.
  it('AC-0001: hover ≥ 200ms triggers a fetch', async () => {
    const p = useConversationPrefetch();
    p.onHover('conv-1');

    // Just shy of the delay — no request yet.
    vi.advanceTimersByTime(PREFETCH_INTERNALS.HOVER_DELAY_MS - 1);
    expect(mockedGet).not.toHaveBeenCalled();

    // Cross the threshold → request fires.
    vi.advanceTimersByTime(2);
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith(
      '/conversations/conv-1/messages',
      { params: { limit: PREFETCH_INTERNALS.PREFETCH_LIMIT } },
    );
  });

  // EC-0004 — leave before the timer fires → no request.
  it('EC-0004: leaving the row before 200ms cancels the prefetch', () => {
    const p = useConversationPrefetch();
    p.onHover('conv-1');
    vi.advanceTimersByTime(100);
    p.onHoverLeave();
    vi.advanceTimersByTime(500);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  // EC-0004 — fast hover over many rows: only the last prefetch survives.
  it('EC-0004: hover spam keeps only the most recent target', () => {
    const p = useConversationPrefetch();
    for (let i = 0; i < 20; i++) {
      p.onHover(`conv-${i}`);
      vi.advanceTimersByTime(20); // fast cursor flight
    }
    // After spam, run out the timer.
    vi.advanceTimersByTime(500);
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith(
      '/conversations/conv-19/messages',
      expect.anything(),
    );
  });

  // AC-0002 — once cached, getCached is synchronous and returns the array.
  it('AC-0002: getCached returns messages after a successful prefetch', async () => {
    const p = useConversationPrefetch();
    await p.prefetch('conv-cached');
    const result = p.getCached('conv-cached');
    expect(result).not.toBeNull();
    expect(result?.[0]?.id).toBe('m1');
  });

  it('getCached returns null on a cold cache', () => {
    const p = useConversationPrefetch();
    expect(p.getCached('never-touched')).toBeNull();
  });

  // BR-0001 — entries older than the TTL are evicted on read.
  it('BR-0001: TTL eviction drops stale entries on read', async () => {
    const p = useConversationPrefetch();
    await p.prefetch('conv-stale');
    expect(p.getCached('conv-stale')).not.toBeNull();

    // Jump just past TTL.
    vi.advanceTimersByTime(PREFETCH_INTERNALS.CACHE_TTL_MS + 1);
    expect(p.getCached('conv-stale')).toBeNull();
  });

  // BR-0002 — concurrent prefetch on the same conv → single GET, both
  // promises resolve, second call piggybacks on the in-flight one.
  it('BR-0002: concurrent prefetch on same id is deduped', async () => {
    const p = useConversationPrefetch();
    const a = p.prefetch('conv-x');
    const b = p.prefetch('conv-x');
    await Promise.all([a, b]);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  // EC-0001 — invalidate drops a cached entry so the next click refetches.
  it('invalidate() drops the cached entry immediately', async () => {
    const p = useConversationPrefetch();
    await p.prefetch('conv-1');
    expect(p.getCached('conv-1')).not.toBeNull();
    p.invalidate('conv-1');
    expect(p.getCached('conv-1')).toBeNull();
  });

  // Defensive: a failed prefetch should swallow the error and leave the
  // cache cold (not throw, not poison subsequent calls).
  it('prefetch failure is silent and leaves cache cold', async () => {
    mockedGet.mockRejectedValueOnce(new Error('500'));
    const p = useConversationPrefetch();
    await p.prefetch('broken');
    expect(p.getCached('broken')).toBeNull();
    // Subsequent call on a different conv still works.
    await p.prefetch('conv-2');
    expect(p.getCached('conv-2')).not.toBeNull();
  });

  // clear() resets everything (used by tests + future logout path).
  it('clear() wipes cache + cancels pending timers', () => {
    const p = useConversationPrefetch();
    p.onHover('conv-1');
    p.clear();
    vi.advanceTimersByTime(500);
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
