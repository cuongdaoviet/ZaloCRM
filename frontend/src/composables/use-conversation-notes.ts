import { ref } from 'vue';
import { api } from '@/api/index';

export interface ConversationNote {
  id: string;
  conversationId: string;
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  author: { id: string; fullName: string };
}

export function useConversationNotes() {
  const notes = ref<ConversationNote[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchNotes(conversationId: string) {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get(`/conversations/${conversationId}/notes`);
      notes.value = res.data.notes;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      notes.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function createNote(conversationId: string, content: string) {
    try {
      const res = await api.post(`/conversations/${conversationId}/notes`, { content });
      notes.value.unshift(res.data);
      return { ok: true as const, note: res.data };
    } catch (err: any) {
      return { ok: false as const, error: err.response?.data?.error || err.message };
    }
  }

  async function updateNote(noteId: string, content: string) {
    try {
      const res = await api.put(`/conversations/notes/${noteId}`, { content });
      const idx = notes.value.findIndex((n) => n.id === noteId);
      if (idx >= 0) notes.value[idx] = res.data;
      return { ok: true as const };
    } catch (err: any) {
      return { ok: false as const, error: err.response?.data?.error || err.message };
    }
  }

  async function deleteNote(noteId: string) {
    try {
      await api.delete(`/conversations/notes/${noteId}`);
      notes.value = notes.value.filter((n) => n.id !== noteId);
      return { ok: true as const };
    } catch (err: any) {
      return { ok: false as const, error: err.response?.data?.error || err.message };
    }
  }

  return { notes, loading, error, fetchNotes, createNote, updateNote, deleteNote };
}
