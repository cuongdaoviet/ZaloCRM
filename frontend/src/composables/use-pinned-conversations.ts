/**
 * Composable for feature 0015 — pinned conversations.
 *
 * Exposes a reactive Set of pinned conversation IDs and optimistic
 * pin/unpin/toggle methods. The Set lets ConversationList query membership in
 * O(1) when partitioning conversations into "pinned" and "unpinned" buckets.
 */
import { ref, computed } from 'vue';
import { api } from '@/api/index';
import type { Conversation } from '@/composables/use-chat';

export interface PinnedConversation extends Conversation {
  pinnedAt: string;
}

const pinnedIds = ref<Set<string>>(new Set());
const pinnedConversations = ref<PinnedConversation[]>([]);
const loading = ref(false);

/**
 * Stable ordering of pinned conversation IDs by `pinnedAt DESC` (most
 * recently pinned first). Used by ConversationList to sort the inline
 * "Đã ghim" section so it matches the dedicated /pinned endpoint's order.
 */
const pinnedOrder = computed<string[]>(() =>
  pinnedConversations.value.map((c) => c.id),
);

export function usePinnedConversations() {
  /** Replace local state with whatever the server has. */
  async function fetchPinned(): Promise<void> {
    loading.value = true;
    try {
      const res = await api.get('/conversations/pinned');
      const list = (res.data.conversations || []) as PinnedConversation[];
      pinnedConversations.value = list;
      pinnedIds.value = new Set(list.map((c) => c.id));
    } catch (err) {
      // Non-fatal — the UI just won't show a Pinned section
      console.error('Failed to fetch pinned conversations:', err);
    } finally {
      loading.value = false;
    }
  }

  /** Optimistic pin with rollback on failure. Returns true on success. */
  async function pin(conversationId: string): Promise<boolean> {
    if (pinnedIds.value.has(conversationId)) return true;
    // Flip local state first (clone the Set so Vue tracks the change)
    const next = new Set(pinnedIds.value);
    next.add(conversationId);
    pinnedIds.value = next;

    try {
      await api.post(`/conversations/${conversationId}/pin`);
      // Refresh from server so `pinnedConversations` is sorted by pinnedAt
      // DESC (with the new pin at the head). Cheap query — only pinned rows.
      void fetchPinned();
      return true;
    } catch (err) {
      // Rollback
      const rollback = new Set(pinnedIds.value);
      rollback.delete(conversationId);
      pinnedIds.value = rollback;
      console.error('Failed to pin conversation:', err);
      return false;
    }
  }

  /** Optimistic unpin with rollback on failure. Returns true on success. */
  async function unpin(conversationId: string): Promise<boolean> {
    if (!pinnedIds.value.has(conversationId)) return true;
    const next = new Set(pinnedIds.value);
    next.delete(conversationId);
    pinnedIds.value = next;
    // Also drop from the cached list if present
    pinnedConversations.value = pinnedConversations.value.filter((c) => c.id !== conversationId);

    try {
      await api.delete(`/conversations/${conversationId}/pin`);
      return true;
    } catch (err) {
      const rollback = new Set(pinnedIds.value);
      rollback.add(conversationId);
      pinnedIds.value = rollback;
      console.error('Failed to unpin conversation:', err);
      return false;
    }
  }

  async function togglePin(conversationId: string): Promise<boolean> {
    return pinnedIds.value.has(conversationId)
      ? unpin(conversationId)
      : pin(conversationId);
  }

  function isPinned(conversationId: string): boolean {
    return pinnedIds.value.has(conversationId);
  }

  return {
    pinnedIds,
    pinnedOrder,
    pinnedConversations,
    loading,
    fetchPinned,
    pin,
    unpin,
    togglePin,
    isPinned,
  };
}
