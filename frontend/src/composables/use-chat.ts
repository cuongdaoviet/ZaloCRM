import { ref, computed, watch } from 'vue';
import { api } from '@/api/index';
import { io, Socket } from 'socket.io-client';
import type { Contact } from '@/composables/use-contacts';
import { useReactions, type MessageReaction } from '@/composables/use-reactions';
import { useUserPreferences } from '@/composables/use-user-preferences';

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
  messages?: ConversationMessage[];
}

export interface Message {
  id: string;
  content: string | null;
  contentType: string;
  senderType: string;
  senderName: string | null;
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
}

const DEFAULT_FILTERS: ConversationFilters = {
  unread: false,
  unreplied: false,
  dateFrom: '',
  dateTo: '',
  tagIds: [],
};

export function useChat() {
  const conversations = ref<Conversation[]>([]);
  const selectedConvId = ref<string | null>(null);
  const messages = ref<Message[]>([]);
  const loadingConvs = ref(false);
  const loadingMsgs = ref(false);
  const sendingMsg = ref(false);
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
    filters.value = { ...DEFAULT_FILTERS };
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
    selectedConvId.value = convId;
    await fetchMessages(convId);
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

  async function fetchMessages(convId: string) {
    loadingMsgs.value = true;
    try {
      const res = await api.get(`/conversations/${convId}/messages`, {
        params: { limit: 100 },
      });
      messages.value = res.data.messages;
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      loadingMsgs.value = false;
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
      // Refresh conversation list to update last message / unread count
      fetchConversations();
    });

    socket.on('chat:deleted', (data: { msgId: string }) => {
      const msg = messages.value.find(m => m.zaloMsgId === data.msgId);
      if (msg) {
        msg.isDeleted = true;
      }
    });

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
  };
}
