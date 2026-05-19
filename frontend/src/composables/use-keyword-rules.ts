import { ref } from 'vue';
import { api } from '@/api/index';

export interface KeywordRule {
  id: string;
  name: string;
  enabled: boolean;
  keywords: string[];
  addTag: string | null;
  setStatus: string | null;
  assignToUserId: string | null;
  assignToUser?: { id: string; fullName: string } | null;
  _count?: { triggers: number };
  createdAt: string;
  updatedAt: string;
}

export interface KeywordRuleInput {
  name: string;
  enabled: boolean;
  keywords: string[];
  addTag: string | null;
  setStatus: string | null;
  assignToUserId: string | null;
}

export function useKeywordRules() {
  const rules = ref<KeywordRule[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchRules() {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/keyword-rules');
      rules.value = res.data.rules;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
    } finally {
      loading.value = false;
    }
  }

  async function createRule(
    input: KeywordRuleInput,
  ): Promise<{ ok: true; rule: KeywordRule } | { ok: false; error: string }> {
    try {
      const res = await api.post('/keyword-rules', input);
      rules.value.unshift(res.data);
      return { ok: true, rule: res.data };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function updateRule(
    id: string,
    input: KeywordRuleInput,
  ): Promise<{ ok: true; rule: KeywordRule } | { ok: false; error: string }> {
    try {
      const res = await api.put(`/keyword-rules/${id}`, input);
      const idx = rules.value.findIndex((r) => r.id === id);
      if (idx >= 0) rules.value[idx] = res.data;
      return { ok: true, rule: res.data };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function deleteRule(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await api.delete(`/keyword-rules/${id}`);
      rules.value = rules.value.filter((r) => r.id !== id);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  return { rules, loading, error, fetchRules, createRule, updateRule, deleteRule };
}

export const STATUS_LABELS: Record<string, string> = {
  new: 'Mới',
  contacted: 'Đã liên hệ',
  interested: 'Quan tâm',
  converted: 'Chuyển đổi',
  lost: 'Mất',
};
