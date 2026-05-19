import { ref } from 'vue';
import { api } from '@/api/index';

export interface AutoReplyRule {
  id: string;
  zaloAccountId: string;
  enabled: boolean;
  daysOfWeek: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
  message: string;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoReplyInput {
  enabled: boolean;
  daysOfWeek: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
  message: string;
  cooldownMinutes: number;
}

export function useAutoReply() {
  const rule = ref<AutoReplyRule | null>(null);
  const loading = ref(false);
  const error = ref('');

  async function fetchRule(accountId: string) {
    loading.value = true;
    error.value = '';
    rule.value = null;
    try {
      const res = await api.get(`/zalo-accounts/${accountId}/auto-reply`);
      rule.value = res.data;
    } catch (err: any) {
      if (err.response?.status === 404) {
        // Just no rule yet — not an error
        rule.value = null;
      } else {
        error.value = err.response?.data?.error || err.message;
      }
    } finally {
      loading.value = false;
    }
  }

  async function saveRule(
    accountId: string,
    input: AutoReplyInput,
  ): Promise<{ ok: true; rule: AutoReplyRule } | { ok: false; error: string }> {
    try {
      const res = await api.put(`/zalo-accounts/${accountId}/auto-reply`, input);
      rule.value = res.data;
      return { ok: true, rule: res.data };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function deleteRule(accountId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await api.delete(`/zalo-accounts/${accountId}/auto-reply`);
      rule.value = null;
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  return { rule, loading, error, fetchRule, saveRule, deleteRule };
}

/** Convert "HH:MM" to minutes since midnight (0-1440) */
export function timeStringToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Convert minutes since midnight to "HH:MM" */
export function minutesToTimeString(min: number): string {
  const h = Math.floor(min / 60).toString().padStart(2, '0');
  const m = (min % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
