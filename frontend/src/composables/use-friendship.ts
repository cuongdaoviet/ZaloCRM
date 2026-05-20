/**
 * Composable for friendship lifecycle (feature 0020).
 *
 * Wraps the 5 backend endpoints, plus convenience labels/colors for the UI.
 * Mirrors the shape of use-campaigns.ts so consumers feel consistent.
 */
import { ref } from 'vue';
import { api } from '@/api/index';

export type FriendshipState =
  | 'queued'
  | 'looking_up'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'timeout'
  | 'error'
  | 'cancelled';

export interface FriendshipAttempt {
  id: string;
  orgId: string;
  contactId: string;
  zaloAccountId: string;
  createdByUserId: string | null;
  state: FriendshipState;
  zaloUidFound: string | null;
  requestMsg: string | null;
  resolvedMsg: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  queuedAt: string;
  lookedUpAt: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contact?: {
    id: string;
    fullName: string | null;
    phone: string | null;
    avatarUrl: string | null;
  };
  zaloAccount?: { id: string; displayName: string | null };
  createdBy?: { id: string; fullName: string } | null;
}

export interface BulkResult {
  queued: Array<{ contactId: string; attemptId: string }>;
  skipped: Array<{ contactId: string; reason: string }>;
  totalQueued: number;
  totalSkipped: number;
}

export interface ListParams {
  state?: FriendshipState[] | string;
  zaloAccountId?: string;
  contactId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export function useFriendship() {
  const attempts = ref<FriendshipAttempt[]>([]);
  const total = ref(0);
  const page = ref(1);
  const limit = ref(20);
  const totalPages = ref(1);
  const loading = ref(false);
  const error = ref('');

  async function fetchAttempts(params: ListParams = {}): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const query: Record<string, string | number> = {};
      if (params.state) {
        query.state = Array.isArray(params.state) ? params.state.join(',') : params.state;
      }
      if (params.zaloAccountId) query.zaloAccountId = params.zaloAccountId;
      if (params.contactId) query.contactId = params.contactId;
      if (params.from) query.from = params.from;
      if (params.to) query.to = params.to;
      if (params.page) query.page = params.page;
      if (params.limit) query.limit = params.limit;
      const res = await api.get('/friendship-attempts', { params: query });
      attempts.value = res.data.attempts;
      total.value = res.data.total;
      page.value = res.data.page;
      limit.value = res.data.limit;
      totalPages.value = res.data.totalPages;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchAttempt(id: string): Promise<FriendshipAttempt | null> {
    try {
      const res = await api.get(`/friendship-attempts/${id}`);
      return res.data;
    } catch {
      return null;
    }
  }

  async function enqueueForContact(
    contactId: string,
    zaloAccountId: string,
    message?: string,
  ): Promise<{ ok: true; attempt: FriendshipAttempt } | { ok: false; error: string; code?: string }> {
    try {
      const res = await api.post(`/contacts/${contactId}/friendship`, {
        zaloAccountId,
        message: message ?? null,
      });
      return { ok: true, attempt: res.data };
    } catch (err: any) {
      return {
        ok: false,
        error: err.response?.data?.error || err.message,
        code: err.response?.data?.code,
      };
    }
  }

  async function bulkEnqueue(
    zaloAccountId: string,
    contactIds: string[],
    message?: string,
  ): Promise<{ ok: true; result: BulkResult } | { ok: false; error: string }> {
    try {
      const res = await api.post('/friendship-attempts/bulk', {
        zaloAccountId,
        contactIds,
        message: message ?? null,
      });
      return { ok: true, result: res.data };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function cancelAttempt(
    id: string,
  ): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
    try {
      await api.post(`/friendship-attempts/${id}/cancel`);
      return { ok: true };
    } catch (err: any) {
      return {
        ok: false,
        error: err.response?.data?.error || err.message,
        code: err.response?.data?.code,
      };
    }
  }

  return {
    attempts,
    total,
    page,
    limit,
    totalPages,
    loading,
    error,
    fetchAttempts,
    fetchAttempt,
    enqueueForContact,
    bulkEnqueue,
    cancelAttempt,
  };
}

// ── UI labels & colors — Vuetify theme tokens only (no hex literals) ────────
export const STATE_LABELS: Record<FriendshipState, string> = {
  queued: 'Trong hàng đợi',
  looking_up: 'Đang tra UID',
  sent: 'Đã gửi lời mời',
  accepted: 'Đã chấp nhận',
  declined: 'Đã từ chối',
  timeout: 'Hết hạn',
  error: 'Lỗi',
  cancelled: 'Đã huỷ',
};

export const STATE_COLORS: Record<FriendshipState, string> = {
  queued: 'grey',
  looking_up: 'info',
  sent: 'primary',
  accepted: 'success',
  declined: 'warning',
  timeout: 'warning',
  error: 'error',
  cancelled: 'grey-darken-1',
};

export const STATE_ICONS: Record<FriendshipState, string> = {
  queued: 'mdi-clock-outline',
  looking_up: 'mdi-account-search-outline',
  sent: 'mdi-send-outline',
  accepted: 'mdi-account-check',
  declined: 'mdi-account-cancel',
  timeout: 'mdi-timer-sand-empty',
  error: 'mdi-alert-circle-outline',
  cancelled: 'mdi-cancel',
};
