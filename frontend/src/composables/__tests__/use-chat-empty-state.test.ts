/**
 * Feature 0051 — `accessibleAccountCount` in use-chat.
 *
 * Covers the slice of AC-0005..AC-0007 that lives at the composable level:
 *   - `accessibleAccountCount.value` defaults to `null`
 *   - After fetchConversations, mirrors the value the BE returned:
 *       Case 1 (member, 0 grants)  → res.data.accessibleAccountCount=0   → ref=0
 *       Case 2 (member, has grants) → res.data.accessibleAccountCount=>0 → ref=>0
 *       Case 3 (owner/admin)        → field omitted from response        → ref=null
 *
 * Strategy mirrors `use-chat-reply.test.ts`: hoist a mock for the `api`
 * module so we control what fetchConversations sees, and stub out the
 * peripheral composables that would otherwise touch storage / sockets.
 * Component-level rendering of the empty-state copy is left to the build
 * pass + manual smoke — mounting Vuetify is out of scope for these tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));
vi.mock('@/api/index', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
  },
}));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() })),
}));
vi.mock('@/composables/use-user-preferences', () => ({
  useUserPreferences: () => ({
    usePref: <T,>(_key: string, defaults: T) => ({ value: defaults }),
  }),
}));
vi.mock('@/composables/use-conversation-prefetch', () => ({
  useConversationPrefetch: () => ({
    getCached: () => null,
    invalidate: vi.fn(),
    onHover: vi.fn(),
    onHoverLeave: vi.fn(),
  }),
}));
vi.mock('@/composables/use-reactions', () => ({
  useReactions: () => ({
    subscribe: vi.fn(),
    addOrToggle: vi.fn(),
    remove: vi.fn(),
  }),
}));

import { useChat } from '@/composables/use-chat';

describe('useChat — feature 0051 accessibleAccountCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults accessibleAccountCount to null (pre-first-fetch)', () => {
    const chat = useChat();
    expect(chat.accessibleAccountCount.value).toBeNull();
  });

  it('Case 1: member with 0 grants → ref becomes 0 after fetch', async () => {
    apiGetMock.mockResolvedValueOnce({
      data: {
        conversations: [],
        total: 0,
        page: 1,
        limit: 100,
        accessibleAccountCount: 0,
      },
    });
    const chat = useChat();
    await chat.fetchConversations();
    expect(chat.accessibleAccountCount.value).toBe(0);
    expect(chat.conversations.value).toEqual([]);
  });

  it('Case 2: member with grants → ref becomes positive after fetch', async () => {
    apiGetMock.mockResolvedValueOnce({
      data: {
        conversations: [],
        total: 0,
        page: 1,
        limit: 100,
        accessibleAccountCount: 2,
      },
    });
    const chat = useChat();
    await chat.fetchConversations();
    expect(chat.accessibleAccountCount.value).toBe(2);
  });

  it('Case 3: owner/admin (field omitted from response) → ref stays null', async () => {
    apiGetMock.mockResolvedValueOnce({
      data: {
        conversations: [],
        total: 0,
        page: 1,
        limit: 100,
        // Crucially — no `accessibleAccountCount` key. BE omits it for
        // owner/admin per BR-0002.
      },
    });
    const chat = useChat();
    await chat.fetchConversations();
    expect(chat.accessibleAccountCount.value).toBeNull();
  });

  it('explicit null in response is also coerced to ref=null', async () => {
    // Defensive — a future BE refactor might choose to ship `null`
    // instead of omitting the key. We should accept both shapes.
    apiGetMock.mockResolvedValueOnce({
      data: {
        conversations: [],
        total: 0,
        page: 1,
        limit: 100,
        accessibleAccountCount: null,
      },
    });
    const chat = useChat();
    await chat.fetchConversations();
    expect(chat.accessibleAccountCount.value).toBeNull();
  });

  it('a member who later gets a grant: subsequent fetch updates the ref', async () => {
    // First fetch — no grants.
    apiGetMock.mockResolvedValueOnce({
      data: { conversations: [], total: 0, page: 1, limit: 100, accessibleAccountCount: 0 },
    });
    const chat = useChat();
    await chat.fetchConversations();
    expect(chat.accessibleAccountCount.value).toBe(0);

    // Admin grants the member access to one Zalo account → next refresh.
    apiGetMock.mockResolvedValueOnce({
      data: { conversations: [], total: 0, page: 1, limit: 100, accessibleAccountCount: 1 },
    });
    await chat.fetchConversations();
    expect(chat.accessibleAccountCount.value).toBe(1);
  });
});
