import { ref, computed, watch } from 'vue';
import { api } from '@/api/index';
import { io, Socket } from 'socket.io-client';
import type { Contact } from '@/composables/use-contacts';
import { useReactions, type MessageReaction } from '@/composables/use-reactions';
import { useUserPreferences } from '@/composables/use-user-preferences';
import { useConversationPrefetch } from '@/composables/use-conversation-prefetch';

interface ZaloAccount {
  id: string;
  displayName: string | null;
  // Feature 0021 — Zalo UID is used by ReactionChips dedupe (EC-0004)
  zaloUid?: string | null;
}

interface ConversationMessage {
  content: string | null;
  contentType: string;
  senderType: string;
  sentAt: string;
  isDeleted: boolean;
}

export interface Conversation {
  id: string;
  threadType: 'user' | 'group';
  contact: Contact | null;
  zaloAccount: ZaloAccount | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isReplied: boolean;
  // Feature 0023 — 'main' (Chính) or 'other' (Khác). Default 'main'.
  tab?: 'main' | 'other';
  messages?: ConversationMessage[];
}

// Feature 0023 — Conversation tab union type used across the chat UI.
export type ConversationTab = 'main' | 'other';

export interface Message {
  id: string;
  content: string | null;
  contentType: string;
  senderType: string;
  senderName: string | null;
  /** Feature 0030 — Zalo UID of the sender (used by the user-info popover). */
  senderUid: string | null;
  sentAt: string;
  isDeleted: boolean;
  zaloMsgId: string | null;
  // Feature 0021 — reactions delivered inline on each Message
  reactions?: MessageReaction[];
}

/**
 * Feature 0022 — chip-row filter state for the conversation list.
 *
 * Param names mirror ZaloCRM-3.0's `FilterRail` emit payload so a future
 * Phase 2 (full sidebar) can drop in without changing the wire format.
 * Tag filter uses our UUIDs (not 3.0's names) — see SPEC deviations.
 */
export interface ConversationFilters {
  unread: boolean;
  unreplied: boolean;
  dateFrom: string;
  dateTo: string;
  tagIds: string[];
  // Feature 0023 — active inbox tab. Persists alongside the other filter
  // chips via the same `chat.conversation_filters` user-pref key.
  tab: ConversationTab;
}

const DEFAULT_FILTERS: ConversationFilters = {
  unread: false,
  unreplied: false,
  dateFrom: '',
  dateTo: '',
  tagIds: [],
  // Default to the main inbox so existing users land where they expect.
  tab: 'main',
};

export function useChat() {
  const conversations = ref<Conversation[]>([]);
  const selectedConvId = ref<string | null>(null);
  const messages = ref<Message[]>([]);
  const loadingConvs = ref(false);
  const loadingMsgs = ref(false);
  const sendingMsg = ref(false);
  // Feature 0043 — hover prefetch + 5-min in-memory cache so cached
  // conversation switches render in ≤ 200ms (AC-0002).
  const prefetch = useConversationPrefetch();
  const searchQuery = ref('');
  const accountFilter = ref<string | null>(null);
  // Feature 0021 — caller identity for optimistic reactions
  const selfUserId = ref<string | null>(null);
  const selfFullName = ref<string | null>(null);
  let socket: Socket | null = null;

  // ── Feature 0022 — filter state + badge counts ─────────────────────────
  const { usePref } = useUserPreferences();
  const filters = usePref<ConversationFilters>(
    'chat.conversation_filters',
    { ...DEFAULT_FILTERS },
  );
  const unreadTotal = ref(0);
  const unrepliedTotal = ref(0);
  // Feature 0023 — per-tab unread counts power the badge on each tab header.
  const mainUnread = ref(0);
  const otherUnread = ref(0);

  /** True if any filter chip is active. Used to show "Xóa bộ lọc" link. */
  const hasActiveFilters = computed<boolean>(
    () =>
      filters.value.unread ||
      filters.value.unreplied ||
      filters.value.dateFrom !== '' ||
      filters.value.dateTo !== '' ||
      filters.value.tagIds.length > 0,
  );

  function resetFilters(): void {
    // Feature 0023 — `tab` is its own UI surface (a tab bar, not a chip),
    // so "Xóa bộ lọc" must preserve the currently-active tab. Only the chip
    // filters (unread / unreplied / dates / tags) are cleared here.
    const keepTab = filters.value.tab;
    filters.value = { ...DEFAULT_FILTERS, tab: keepTab };
  }

  /**
   * Convert the reactive filter state into the query-param shape that the
   * backend expects. Booleans → "1" / omit; arrays → CSV / omit. Empty
   * strings are dropped so the URL stays clean.
   */
  function buildFilterParams(): Record<string, string> {
    const out: Record<string, string> = {};
    if (filters.value.unread) out.unread = '1';
    if (filters.value.unreplied) out.unreplied = '1';
    if (filters.value.dateFrom) out.dateFrom = filters.value.dateFrom;
    if (filters.value.dateTo) out.dateTo = filters.value.dateTo;
    if (filters.value.tagIds.length > 0) out.tags = filters.value.tagIds.join(',');
    // Feature 0023 — always scope list fetches to the active tab so the row
    // count + sort match what's rendered. Persisted filter from before 0023
    // shipped won't have `tab`, so default to 'main' (preserves the Chính
    // inbox as the landing view).
    out.tab = filters.value.tab ?? 'main';
    return out;
  }

  /**
   * Fetch the unread / unreplied / total counts from the /counts aggregate
   * endpoint. These power badge numbers on the chip row. Failure is
   * non-fatal — UI just hides the badge.
   */
  async function fetchConversationCounts(): Promise<void> {
    try {
      const params: Record<string, string> = {};
      if (accountFilter.value) params.accountId = accountFilter.value;
      const res = await api.get('/conversations/counts', { params });
      unreadTotal.value = res.data?.unread ?? 0;
      unrepliedTotal.value = res.data?.unreplied ?? 0;
      // Feature 0023 — per-tab badges. Fall back to 0 if the BE is older.
      mainUnread.value = res.data?.mainUnread ?? 0;
      otherUnread.value = res.data?.otherUnread ?? 0;
    } catch (err) {
      console.warn('[use-chat] failed to fetch conversation counts:', err);
    }
  }

  // Reactions composable — operates on the same `messages` ref so optimistic
  // changes and socket events both update the visible thread.
  const reactions = useReactions({
    messages,
    selfUserId,
    selfFullName,
  });

  const selectedConv = computed(() =>
    conversations.value.find(c => c.id === selectedConvId.value) || null,
  );

  async function fetchConversations() {
    loadingConvs.value = true;
    try {
      const params: Record<string, string | number | undefined> = {
        limit: 100,
        search: searchQuery.value,
        accountId: accountFilter.value || undefined,
        ...buildFilterParams(),
      };
      const res = await api.get('/conversations', { params });
      conversations.value = res.data.conversations;
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      loadingConvs.value = false;
    }
  }

  async function selectConversation(convId: string) {
    // Feature 0043 — Strategy 3 (optimistic header swap): set selectedConvId
    // FIRST so the computed `selectedConv` flips to the new row's cached
    // header data (avatar / name / Zalo account) before any await. The view
    // layer reads from `selectedConv` synchronously, which is what makes the
    // header swap feel instant.
    if (selectedConvId.value !== convId) {
      // perf mark — only in dev. `performance.mark` is a no-op in prod
      // builds where DEV is false, so this stays cheap.
      if (typeof performance !== 'undefined' && import.meta.env?.DEV) {
        try { performance.mark('conv-click'); } catch { /* SSR / Safari edge */ }
      }
    }
    selectedConvId.value = convId;

    // Feature 0043 — Strategy 1 (cache hit): render cached messages
    // instantly, then silently revalidate (EC-0001). Cache miss falls back
    // to the spinner + fetch path.
    const cached = prefetch.getCached(convId);
    if (cached) {
      messages.value = cached;
      loadingMsgs.value = false;
      // Silent revalidate so the next switch sees fresh data.
      void fetchMessages(convId, { silent: true });
    } else {
      await fetchMessages(convId);
    }

    // Fetch full conversation detail to populate contact CRM fields
    try {
      const convDetail = await api.get(`/conversations/${convId}`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv && convDetail.data.contact) {
        conv.contact = convDetail.data.contact;
      }
    } catch {
      // Non-critical — panel will show partial data from list
    }
    // Mark as read
    try {
      await api.post(`/conversations/${convId}/mark-read`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv) conv.unreadCount = 0;
    } catch {
      // Ignore mark-read errors
    }
  }

  /**
   * Feature 0043 — `silent` skips the loading spinner so cached-then-
   * revalidate doesn't flash a progress bar over the already-rendered
   * messages. On silent failure we keep the cached view untouched.
   */
  async function fetchMessages(
    convId: string,
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    if (!opts.silent) loadingMsgs.value = true;
    try {
      const res = await api.get(`/conversations/${convId}/messages`, {
        params: { limit: 100 },
      });
      messages.value = res.data.messages;
    } catch (err) {
      if (!opts.silent) {
        console.error('Failed to fetch messages:', err);
      }
    } finally {
      if (!opts.silent) loadingMsgs.value = false;
    }
  }

  async function sendMessage(content: string) {
    if (!selectedConvId.value || !content.trim()) return;
    sendingMsg.value = true;
    try {
      const res = await api.post(`/conversations/${selectedConvId.value}/messages`, { content });
      // Socket may race the HTTP response — dedup before pushing
      if (!messages.value.find((m) => m.id === res.data.id)) {
        messages.value.push(res.data);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      sendingMsg.value = false;
    }
  }

  /**
   * Upload a file via multipart and have the backend forward it to Zalo.
   * Returns the persisted Message on success, or an error string.
   * Feature 0003.
   */
  async function sendAttachment(file: File): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
    if (!selectedConvId.value) return { ok: false, error: 'Chưa chọn cuộc trò chuyện' };
    sendingMsg.value = true;
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await api.post(
        `/conversations/${selectedConvId.value}/attachments`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      if (!messages.value.find((m) => m.id === res.data.id)) {
        messages.value.push(res.data);
      }
      return { ok: true, message: res.data };
    } catch (err: any) {
      const error = err.response?.data?.error || err.message || 'Gửi file thất bại';
      console.error('Failed to send attachment:', error);
      return { ok: false, error };
    } finally {
      sendingMsg.value = false;
    }
  }

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('chat:message', (data: { message: Message; conversationId: string }) => {
      // Add to messages if viewing this conversation
      if (data.conversationId === selectedConvId.value) {
        // Avoid duplicates
        if (!messages.value.find(m => m.id === data.message.id)) {
          messages.value.push(data.message);
        }
      }
      // Feature 0043 — drop the stale cached snapshot so the next switch
      // back into this conversation re-fetches and includes the new row.
      prefetch.invalidate(data.conversationId);
      // Refresh conversation list to update last message / unread count
      fetchConversations();
    });

    socket.on('chat:deleted', (data: { msgId: string }) => {
      const msg = messages.value.find(m => m.zaloMsgId === data.msgId);
      if (msg) {
        msg.isDeleted = true;
      }
    });

    // Feature 0023 — auto-promote / manual moves emit `chat:tab`. Move the
    // local row between tabs (or drop it if it now belongs in the other tab)
    // and refresh the badge counts so the tab header stays in sync.
    socket.on(
      'chat:tab',
      (data: { conversationId: string; tab: ConversationTab; reason?: string }) => {
        const conv = conversations.value.find((c) => c.id === data.conversationId);
        if (conv) {
          conv.tab = data.tab;
          // If we're viewing a tab and the conv moved out of it, drop the row
          // so the user doesn't see a stale entry in the wrong tab.
          if (filters.value.tab && conv.tab !== filters.value.tab) {
            conversations.value = conversations.value.filter(
              (c) => c.id !== data.conversationId,
            );
          }
        } else if (filters.value.tab === data.tab) {
          // Row wasn't in our local list (we were viewing the other tab)
          // but it now belongs in our tab → refetch to pick it up.
          void fetchConversations();
        }
        void fetchConversationCounts();
      },
    );

    // Feature 0021 — reactions live-merge from BE listener / other clients
    reactions.subscribe(socket);
  }

  function destroySocket() {
    socket?.disconnect();
    socket = null;
  }

  /**
   * Create (or reuse) a conversation with a contact. Used by the "+ New chat"
   * dialog. Pushes the conversation to the head of the list and auto-selects
   * it. Returns the conversation id so callers can react.
   */
  /**
   * Feature 0023 — move a conversation between the "Chính" (main) and
   * "Khác" (other) tabs. Optimistic UI: the row's tab flips locally first
   * then we call the API. On failure, rollback and surface the row again.
   *
   * If the moved conversation was the currently-selected one and it leaves
   * the active tab, the caller (ChatView) decides whether to clear the
   * selection (per EC-0001).
   */
  async function setConversationTab(
    convId: string,
    tab: ConversationTab,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const conv = conversations.value.find((c) => c.id === convId);
    const previousTab: ConversationTab | undefined = conv?.tab;
    // Optimistic local flip
    if (conv) conv.tab = tab;
    // If we're viewing a tab and the row no longer belongs, hide it now.
    let removedConv: Conversation | null = null;
    let removedIdx = -1;
    if (conv && filters.value.tab && conv.tab !== filters.value.tab) {
      removedIdx = conversations.value.findIndex((c) => c.id === convId);
      if (removedIdx >= 0) {
        removedConv = conversations.value[removedIdx];
        conversations.value.splice(removedIdx, 1);
      }
    }
    try {
      await api.patch(`/conversations/${convId}/tab`, { tab });
      // Refresh badge counts to reflect the new distribution.
      void fetchConversationCounts();
      return { ok: true };
    } catch (err: any) {
      // Rollback the optimistic mutation so the row reappears with its
      // original tab. Re-insert at the original index to preserve order.
      if (conv) conv.tab = previousTab;
      if (removedConv && removedIdx >= 0) {
        conversations.value.splice(removedIdx, 0, removedConv);
      }
      const error =
        err?.response?.data?.error || err?.message || 'Không thể đổi tab cuộc trò chuyện';
      console.error('[use-chat] setConversationTab failed:', error);
      return { ok: false, error };
    }
  }

  async function createConversation(accountId: string, contactId: string): Promise<string | null> {
    try {
      const res = await api.post('/conversations', { accountId, contactId });
      const conv = res.data as Conversation;

      // De-dupe in the local list (idempotent endpoint may return existing)
      const idx = conversations.value.findIndex(c => c.id === conv.id);
      if (idx >= 0) {
        conversations.value.splice(idx, 1);
      }
      conversations.value.unshift(conv);

      await selectConversation(conv.id);
      return conv.id;
    } catch (err) {
      console.error('Failed to create conversation:', err);
      return null;
    }
  }

  // Feature 0022 — when filter state changes (either from chip toggles or
  // when the persisted prefs hydrate after first load), re-fetch the list.
  // Counts only depend on accountFilter, so they refresh independently.
  watch(
    filters,
    () => {
      void fetchConversations();
    },
    { deep: true },
  );
  watch(accountFilter, () => {
    void fetchConversationCounts();
  });

  return {
    conversations,
    selectedConvId,
    selectedConv,
    messages,
    loadingConvs,
    loadingMsgs,
    sendingMsg,
    searchQuery,
    accountFilter,
    selfUserId,
    selfFullName,
    // Feature 0022 — filter state + count badges exposed to the view layer
    filters,
    hasActiveFilters,
    unreadTotal,
    unrepliedTotal,
    // Feature 0023 — per-tab unread badges and tab-mutator
    mainUnread,
    otherUnread,
    setConversationTab,
    resetFilters,
    fetchConversationCounts,
    fetchConversations,
    selectConversation,
    sendMessage,
    sendAttachment,
    createConversation,
    initSocket,
    destroySocket,
    // Feature 0021 — reaction operations re-exported for the view layer
    addOrToggleReaction: reactions.addOrToggle,
    removeReaction: reactions.remove,
    // Feature 0043 — hover prefetch handles wired through the view layer.
    // The list calls onConversationHover / onConversationHoverLeave; the
    // composable handles debounce + cache + dedupe internally.
    onConversationHover: prefetch.onHover,
    onConversationHoverLeave: prefetch.onHoverLeave,
  };
}
