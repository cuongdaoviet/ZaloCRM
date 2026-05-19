import { ref } from 'vue';
import { api } from '@/api/index';

export type Period =
  | 'today'
  | 'yesterday'
  | 'last7days'
  | 'last30days'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';

export type LeaderboardMetric =
  | 'messagesSent'
  | 'revenue'
  | 'ordersCount'
  | 'newContacts';

export interface MetricCell {
  current: number;
  previous: number;
  delta: number | null;
}

export interface KpiSummary {
  range: { from: string; to: string; label: string };
  previousRange: { from: string; to: string };
  summary: {
    messagesSent: MetricCell;
    messagesReceived: MetricCell;
    newContacts: MetricCell;
    convertedContacts: MetricCell;
    ordersCount: MetricCell;
    revenue: MetricCell;
  };
}

export interface LeaderboardRow {
  userId: string;
  fullName: string;
  email: string;
  value: number;
  rank: number;
}

export interface LeaderboardResponse {
  range: { from: string; to: string };
  metric: LeaderboardMetric;
  rows: LeaderboardRow[];
}

interface RangeQuery {
  period: Period;
  from?: string;
  to?: string;
}

export function useKpi() {
  const summary = ref<KpiSummary | null>(null);
  const leaderboard = ref<LeaderboardRow[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchSummary(q: RangeQuery) {
    loading.value = true;
    error.value = '';
    try {
      const params: Record<string, string> = { period: q.period };
      if (q.period === 'custom' && q.from && q.to) {
        params.from = q.from;
        params.to = q.to;
      }
      const res = await api.get<KpiSummary>('/kpi/summary', { params });
      summary.value = res.data;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      summary.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function fetchLeaderboard(q: RangeQuery, metric: LeaderboardMetric, limit = 10) {
    try {
      const params: Record<string, string | number> = {
        period: q.period,
        metric,
        limit,
      };
      if (q.period === 'custom' && q.from && q.to) {
        params.from = q.from;
        params.to = q.to;
      }
      const res = await api.get<LeaderboardResponse>('/kpi/leaderboard', { params });
      leaderboard.value = res.data.rows;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      leaderboard.value = [];
    }
  }

  return { summary, leaderboard, loading, error, fetchSummary, fetchLeaderboard };
}

/** Format VND with thousand separators */
export function formatVND(n: number): string {
  return n.toLocaleString('vi-VN') + ' ₫';
}

/** Format an integer count with thousand separators */
export function formatCount(n: number): string {
  return n.toLocaleString('vi-VN');
}
