import { ref } from 'vue';
import { api } from '@/api/index';

export interface WebhookDeliveryRow {
  id: string;
  event: string;
  url: string;
  responseStatus: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface WebhookDeliveryDetail extends WebhookDeliveryRow {
  payload: string;
  signature: string | null;
}

export interface DeliveriesResponse {
  deliveries: WebhookDeliveryRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type DeliveryStatusFilter = 'all' | 'success' | 'failed';

export function useWebhookDeliveries() {
  const deliveries = ref<WebhookDeliveryRow[]>([]);
  const total = ref(0);
  const page = ref(1);
  const totalPages = ref(0);
  const loading = ref(false);
  const error = ref('');

  async function fetchDeliveries(opts: {
    status?: DeliveryStatusFilter;
    page?: number;
    limit?: number;
  } = {}) {
    loading.value = true;
    error.value = '';
    try {
      const params: Record<string, string | number> = {};
      if (opts.status && opts.status !== 'all') params.status = opts.status;
      if (opts.page) params.page = opts.page;
      if (opts.limit) params.limit = opts.limit;
      const res = await api.get<DeliveriesResponse>('/settings/webhook/deliveries', { params });
      deliveries.value = res.data.deliveries;
      total.value = res.data.total;
      page.value = res.data.page;
      totalPages.value = res.data.totalPages;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchDetail(id: string): Promise<WebhookDeliveryDetail | null> {
    try {
      const res = await api.get<WebhookDeliveryDetail>(`/settings/webhook/deliveries/${id}`);
      return res.data;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      return null;
    }
  }

  async function replay(id: string): Promise<WebhookDeliveryRow | null> {
    try {
      const res = await api.post<WebhookDeliveryRow>(`/settings/webhook/deliveries/${id}/replay`);
      return res.data;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      return null;
    }
  }

  return {
    deliveries, total, page, totalPages, loading, error,
    fetchDeliveries, fetchDetail, replay,
  };
}

export function statusColor(status: number | null, errorMessage: string | null): string {
  if (errorMessage || status === null) return 'error';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400) return 'error';
  return 'warning';
}
