import { ref } from 'vue';
import { api } from '@/api/index';

export interface QuickReply {
  id: string;
  shortcut: string;
  content: string;
  scope: 'user' | 'org';
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuickReplyInput {
  shortcut: string;
  content: string;
  scope: 'user' | 'org';
}

/**
 * Replace {{contactName}} and {{firstName}} placeholders client-side.
 * Mirrors backend `substitutePlaceholders` so the chat preview matches what
 * eventually gets sent (the user can still edit before clicking send).
 */
export function substitutePlaceholders(
  content: string,
  contact: { fullName?: string | null } | null | undefined,
): string {
  const full = (contact?.fullName ?? '').trim();
  const first = full.split(/\s+/)[0] ?? '';
  return content.replace(/\{\{contactName\}\}/g, full).replace(/\{\{firstName\}\}/g, first);
}

export function useQuickReplies() {
  const replies = ref<QuickReply[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchReplies() {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/quick-replies');
      replies.value = res.data.replies;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
    } finally {
      loading.value = false;
    }
  }

  async function createReply(
    input: QuickReplyInput,
  ): Promise<{ ok: true; reply: QuickReply } | { ok: false; error: string }> {
    try {
      const res = await api.post('/quick-replies', input);
      replies.value.push(res.data);
      return { ok: true, reply: res.data };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function updateReply(
    id: string,
    input: QuickReplyInput,
  ): Promise<{ ok: true; reply: QuickReply } | { ok: false; error: string }> {
    try {
      const res = await api.put(`/quick-replies/${id}`, input);
      const idx = replies.value.findIndex((r) => r.id === id);
      if (idx >= 0) replies.value[idx] = res.data;
      return { ok: true, reply: res.data };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function deleteReply(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await api.delete(`/quick-replies/${id}`);
      replies.value = replies.value.filter((r) => r.id !== id);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  return { replies, loading, error, fetchReplies, createReply, updateReply, deleteReply };
}
