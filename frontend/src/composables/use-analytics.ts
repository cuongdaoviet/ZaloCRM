/**
 * Composable for the Feature 0041 advanced analytics dashboard.
 *
 * Wraps the two new admin-only endpoints:
 *   GET /api/v1/analytics/funnel
 *   GET /api/v1/analytics/team-performance
 *
 * Both responses are scoped to the caller's organization on the backend; this
 * client just forwards the optional date / team / assignee filters.
 */
import { ref } from 'vue';
import { api } from '@/api/index';

// ── Funnel ────────────────────────────────────────────────────────────────────

export type FunnelStageName = 'new' | 'contacted' | 'interested' | 'converted';

export interface FunnelStage {
  name: FunnelStageName;
  count: number;
  /** Next-stage conversion rate (percent). Null for the first stage or when the
   *  previous stage had zero contacts — undefined division. */
  conversionRate: number | null;
}

export interface FunnelResponse {
  stages: FunnelStage[];
  lost: { count: number };
  totalContacts: number;
  period: { dateFrom: string; dateTo: string };
}

// ── Team performance ──────────────────────────────────────────────────────────

export interface TeamPerfRow {
  userId: string;
  fullName: string;
  avgResponseTimeMinutes: number | null;
  outboundMessageCount: number;
  convertedContactsCount: number;
  activeConversationsCount: number;
}

export interface TeamPerfResponse {
  byUser: TeamPerfRow[];
  totals: {
    outboundMessageCount: number;
    convertedContactsCount: number;
  };
  period: { dateFrom: string; dateTo: string };
}

export interface AnalyticsFilter {
  dateFrom?: string;
  dateTo?: string;
  teamId?: string;
  assignedUserId?: string;
}

export function useAnalytics() {
  const funnel = ref<FunnelResponse | null>(null);
  const teamPerf = ref<TeamPerfResponse | null>(null);
  const loading = ref(false);
  const error = ref('');

  function toParams(f: AnalyticsFilter): Record<string, string> {
    const params: Record<string, string> = {};
    if (f.dateFrom) params.dateFrom = f.dateFrom;
    if (f.dateTo) params.dateTo = f.dateTo;
    if (f.teamId) params.teamId = f.teamId;
    if (f.assignedUserId) params.assignedUserId = f.assignedUserId;
    return params;
  }

  async function fetchFunnel(f: AnalyticsFilter = {}): Promise<void> {
    try {
      const res = await api.get<FunnelResponse>('/analytics/funnel', {
        params: toParams(f),
      });
      funnel.value = res.data;
    } catch (err: unknown) {
      funnel.value = null;
      error.value = extractError(err);
    }
  }

  async function fetchTeamPerf(f: AnalyticsFilter = {}): Promise<void> {
    try {
      const res = await api.get<TeamPerfResponse>('/analytics/team-performance', {
        params: toParams(f),
      });
      teamPerf.value = res.data;
    } catch (err: unknown) {
      teamPerf.value = null;
      error.value = extractError(err);
    }
  }

  async function fetchAll(f: AnalyticsFilter = {}): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      // Fire both in parallel — the two endpoints touch independent tables.
      await Promise.all([fetchFunnel(f), fetchTeamPerf(f)]);
    } finally {
      loading.value = false;
    }
  }

  return {
    funnel,
    teamPerf,
    loading,
    error,
    fetchFunnel,
    fetchTeamPerf,
    fetchAll,
  };
}

/** Narrow an unknown axios-style error into a user-friendly string. */
export function extractError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    return e.response?.data?.error ?? e.message ?? 'Đã xảy ra lỗi';
  }
  return 'Đã xảy ra lỗi';
}

/** Vietnamese thousand-separator count. */
export function formatCount(n: number): string {
  return n.toLocaleString('vi-VN');
}

/** Avg-response-time formatter — null safe, sub-minute → "< 1". */
export function formatMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 1) return '< 1';
  return min.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
}

/** Conversion-rate formatter — null safe, integer percent. */
export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${rate}%`;
}
