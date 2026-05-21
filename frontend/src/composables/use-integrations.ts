/**
 * Composable wrapping the /api/v1/integrations endpoints — Feature 0038.
 *
 * Mirrors use-keyword-rules.ts shape: ref list + per-action helpers that
 * return `{ ok, ...}` envelopes so views can show inline error messages
 * without throwing.
 */
import { ref } from 'vue';
import { api } from '@/api/index';

export type IntegrationType = 'google_sheets' | 'telegram_bot';

export interface Integration {
  id: string;
  orgId: string;
  type: IntegrationType;
  name: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationRun {
  id: string;
  integrationId: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  recordsProcessed: number;
  errorDetail: string | null;
}

export interface GoogleSheetsConfig {
  refreshToken: string;
  spreadsheetId: string;
  sheetName: string;
  schedule: 'hourly' | 'daily' | 'manual';
  filter?: {
    status?: string;
    tags?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
}

export interface TelegramBotConfig {
  botToken: string;
  chatId: string;
  eventTypes: Array<
    'contact.created' | 'order.created' | 'appointment.reminder' | 'message.escalated'
  >;
  apiEndpoint?: string;
}

export type AnyIntegrationConfig = GoogleSheetsConfig | TelegramBotConfig;

export interface CreateIntegrationInput {
  type: IntegrationType;
  name: string;
  config: AnyIntegrationConfig;
}

export interface PatchIntegrationInput {
  name?: string;
  enabled?: boolean;
  config?: AnyIntegrationConfig;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function errMsg(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    return e.response?.data?.error ?? e.message ?? 'Đã xảy ra lỗi';
  }
  return 'Đã xảy ra lỗi';
}

export function useIntegrations() {
  const integrations = ref<Integration[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchAll(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/integrations');
      integrations.value = res.data.integrations ?? [];
    } catch (err) {
      error.value = errMsg(err);
    } finally {
      loading.value = false;
    }
  }

  async function createIntegration(input: CreateIntegrationInput): Promise<Result<Integration>> {
    try {
      const res = await api.post('/integrations', input);
      integrations.value.unshift(res.data);
      return { ok: true, value: res.data };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  async function updateIntegration(
    id: string,
    input: PatchIntegrationInput,
  ): Promise<Result<Integration>> {
    try {
      const res = await api.patch(`/integrations/${id}`, input);
      const idx = integrations.value.findIndex((i) => i.id === id);
      if (idx >= 0) integrations.value[idx] = res.data;
      return { ok: true, value: res.data };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  async function deleteIntegration(id: string): Promise<Result<true>> {
    try {
      await api.delete(`/integrations/${id}`);
      integrations.value = integrations.value.filter((i) => i.id !== id);
      return { ok: true, value: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  async function triggerSync(id: string): Promise<Result<{ runId: string }>> {
    try {
      const res = await api.post(`/integrations/${id}/sync`);
      return { ok: true, value: res.data };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  async function listRuns(id: string, limit = 20): Promise<Result<IntegrationRun[]>> {
    try {
      const res = await api.get(`/integrations/${id}/runs`, { params: { limit } });
      return { ok: true, value: res.data.runs ?? [] };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  async function getGoogleOAuthUrl(): Promise<Result<{ url: string }>> {
    try {
      const res = await api.get('/integrations/oauth/google/url');
      return { ok: true, value: res.data };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  return {
    integrations,
    loading,
    error,
    fetchAll,
    createIntegration,
    updateIntegration,
    deleteIntegration,
    triggerSync,
    listRuns,
    getGoogleOAuthUrl,
  };
}

export const EVENT_TYPE_LABELS: Record<string, string> = {
  'contact.created': 'Khách hàng mới',
  'order.created': 'Đơn hàng mới',
  'appointment.reminder': 'Nhắc lịch hẹn',
  'message.escalated': 'Tin nhắn cần xử lý',
};

export const SCHEDULE_LABELS: Record<string, string> = {
  manual: 'Thủ công',
  hourly: 'Mỗi giờ',
  daily: 'Mỗi ngày',
};

export const STATUS_LABELS: Record<string, string> = {
  running: 'Đang chạy',
  succeeded: 'Thành công',
  failed: 'Lỗi',
};

export const STATUS_COLORS: Record<string, string> = {
  running: 'info',
  succeeded: 'success',
  failed: 'error',
};
