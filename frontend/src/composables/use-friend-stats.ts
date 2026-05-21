/**
 * Composable for friend aggregate stats (feature 0033).
 *
 * Wraps `GET /api/v1/friends/stats` — a per-ZaloAccount breakdown of
 *  - acceptedNicksCount (Friend rows for that nick)
 *  - chattingNicksCount (friends with inbound message in the last N days)
 *
 * Stays read-only; backend caches 60s so re-fetching on view focus is cheap.
 */
import { ref } from 'vue';
import { api } from '@/api/index';

export interface FriendStatRow {
  zaloAccountId: string;
  displayName: string | null;
  acceptedNicksCount: number;
  chattingNicksCount: number;
}

export interface FriendStatsResponse {
  byAccount: FriendStatRow[];
  totals: {
    acceptedNicksCount: number;
    chattingNicksCount: number;
  };
  windowDays: number;
}

export function useFriendStats() {
  const stats = ref<FriendStatsResponse | null>(null);
  const byAccount = ref<Record<string, FriendStatRow>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchStats(): Promise<FriendStatsResponse | null> {
    loading.value = true;
    error.value = null;
    try {
      const res = await api.get<FriendStatsResponse>('/friends/stats');
      stats.value = res.data;
      const map: Record<string, FriendStatRow> = {};
      for (const row of res.data.byAccount) {
        map[row.zaloAccountId] = row;
      }
      byAccount.value = map;
      return res.data;
    } catch (err: any) {
      error.value = err?.response?.data?.error || err?.message || 'Không tải được thống kê bạn bè';
      return null;
    } finally {
      loading.value = false;
    }
  }

  return { stats, byAccount, loading, error, fetchStats };
}
