/**
 * Feature 0031 — reply state in use-chat.
 *
 * Covers the slice of AC-0009..AC-0011 that lives at the composable level:
 *   - replyingTo defaults to null
 *   - setReplyTarget / clearReplyTarget mutate the ref
 *   - sendMessage() POSTs `replyToMessageId` when a target is set, omits it
 *     otherwise
 *   - replyingTo is cleared optimistically when send starts, restored on
 *     failure
 *
 * Strategy: mock the axios `api` module so we can spy on what we POST.
 * MessageThread.vue (template render) is covered by manual checks + the
 * build pass — mounting it requires a full Vuetify environment which the
 * other component tests in this directory don't bother setting up either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub `api` BEFORE the composable is imported. vi.mock is hoisted to the
// top of the file, so the mock body cannot reference module-scope variables
// directly — vi.hoisted lifts them too. See vitest docs §vi.hoisted.
const { apiPostMock, apiGetMock, apiPatchMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));
vi.mock('@/api/index', () => ({
  api: {
    post: apiPostMock,
    get: apiGetMock,
    patch: apiPatchMock,
  },
}));
// Avoid touching real socket.io in unit tests.
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() })) }));
// Sub-composables that hit storage / preferences.
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

import { useChat, type Message } from '@/composables/use-chat';

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    content: 'hello world',
    contentType: 'text',
    senderType: 'contact',
    senderName: 'Khách',
    senderUid: 'zalo-uid-1',
    sentAt: '2025-01-01T00:00:00.000Z',
    isDeleted: false,
    zaloMsgId: 'z-1',
    ...over,
  };
}

describe('useChat — feature 0031 reply state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPostMock.mockResolvedValue({ data: { id: 'new-msg' } });
  });

  it('defaults replyingTo to null', () => {
    const chat = useChat();
    expect(chat.replyingTo.value).toBeNull();
  });

  it('setReplyTarget stores the message; clearReplyTarget resets it (AC-0009)', () => {
    const chat = useChat();
    const target = makeMessage();
    chat.setReplyTarget(target);
    // Vue's reactivity wraps plain objects in a proxy, so `toBe` fails on
    // identity even though the contents match. Compare by structure.
    expect(chat.replyingTo.value).toStrictEqual(target);
    chat.clearReplyTarget();
    expect(chat.replyingTo.value).toBeNull();
  });

  it('sendMessage POSTs replyToMessageId when a target is set (AC-0010)', async () => {
    const chat = useChat();
    chat.selectedConvId.value = 'conv-1';
    chat.setReplyTarget(makeMessage({ id: 'parent-id' }));
    await chat.sendMessage('this is my reply');
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [url, payload] = apiPostMock.mock.calls[0];
    expect(url).toBe('/conversations/conv-1/messages');
    expect(payload.content).toBe('this is my reply');
    expect(payload.replyToMessageId).toBe('parent-id');
    // Target cleared after a successful send.
    expect(chat.replyingTo.value).toBeNull();
  });

  it('sendMessage omits replyToMessageId when no target (back-compat)', async () => {
    const chat = useChat();
    chat.selectedConvId.value = 'conv-1';
    await chat.sendMessage('plain message');
    const [, payload] = apiPostMock.mock.calls[0];
    expect(payload.replyToMessageId).toBeUndefined();
  });

  it('restores the reply target on send failure', async () => {
    apiPostMock.mockRejectedValueOnce(new Error('network'));
    const chat = useChat();
    chat.selectedConvId.value = 'conv-1';
    const target = makeMessage({ id: 'will-be-restored' });
    chat.setReplyTarget(target);
    await chat.sendMessage('reply that fails');
    expect(chat.replyingTo.value).toStrictEqual(target);
  });
});
