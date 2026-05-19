import { ref } from 'vue';
import { api } from '@/api/index';

export interface MessageSearchFilters {
  q: string;
  from?: string | null;
  to?: string | null;
  senderType?: 'self' | 'contact' | null;
  contentType?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  page?: number;
  limit?: number;
}

export interface MessageSearchResult {
  id: string;
  content: string | null;
  snippet: string;
  contentType: string;
  senderType: 'self' | 'contact';
  senderName: string | null;
  sentAt: string;
  conversation: {
    id: string;
    contact: { id: string; fullName: string | null; avatarUrl: string | null } | null;
    zaloAccount: { id: string; displayName: string | null } | null;
  };
}

export interface MessageSearchResponse {
  messages: MessageSearchResult[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function useMessageSearch() {
  const messages = ref<MessageSearchResult[]>([]);
  const total = ref(0);
  const page = ref(1);
  const totalPages = ref(0);
  const loading = ref(false);
  const error = ref('');

  async function search(filters: MessageSearchFilters) {
    if (!filters.q || filters.q.length < 2) {
      messages.value = [];
      total.value = 0;
      totalPages.value = 0;
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      // Strip empty values so the API doesn't see explicit nulls as filters
      const params: Record<string, string | number> = { q: filters.q };
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      if (filters.senderType) params.senderType = filters.senderType;
      if (filters.contentType) params.contentType = filters.contentType;
      if (filters.accountId) params.accountId = filters.accountId;
      if (filters.conversationId) params.conversationId = filters.conversationId;
      if (filters.contactId) params.contactId = filters.contactId;
      if (filters.page) params.page = filters.page;
      if (filters.limit) params.limit = filters.limit;

      const res = await api.get<MessageSearchResponse>('/search/messages', { params });
      messages.value = res.data.messages;
      total.value = res.data.total;
      page.value = res.data.page;
      totalPages.value = res.data.totalPages;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      messages.value = [];
    } finally {
      loading.value = false;
    }
  }

  return { messages, total, page, totalPages, loading, error, search };
}

/**
 * Convert a snippet with **match** markers into safe HTML. We escape every
 * other char ourselves so the rendered string can be dropped into v-html
 * without trusting message content from Zalo.
 */
export function snippetToHtml(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Now turn our own marker (which can't appear post-escape) into <mark>
  return escaped.replace(/\*\*(.+?)\*\*/g, '<mark>$1</mark>');
}
