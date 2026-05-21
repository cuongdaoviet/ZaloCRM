/**
 * Composable for the friend grid view (feature 0042).
 *
 * Wraps `GET /api/v1/friends` — paginated list of Friend rows across all
 * Zalo accounts the caller can see. Distinct from `use-friendship.ts`
 * which deals with the friendship-attempt lifecycle (queued, sent, etc.).
 */
import { ref, computed } from 'vue';
import { api } from '@/api/index';

export interface FriendListItem {
  id: string;
  zaloUid: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  zaloAccountId: string;
  zaloAccountName: string | null;
  contactId: string | null;
  contact: {
    id: string;
    fullName: string | null;
    phone: string | null;
    avatarUrl: string | null;
  } | null;
}

export interface FriendListPagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface FriendListResponse {
  data: FriendListItem[];
  pagination: FriendListPagination;
}

export interface FriendListParams {
  accountId?: string | null;
  search?: string;
  page?: number;
  perPage?: number;
}

export function useFriends() {
  const friends = ref<FriendListItem[]>([]);
  const pagination = ref<FriendListPagination>({
    page: 1,
    perPage: 24,
    total: 0,
    totalPages: 1,
  });
  const loading = ref(false);
  const error = ref<string | null>(null);

  const total = computed(() => pagination.value.total);

  async function fetchFriends(
    params: FriendListParams = {},
  ): Promise<FriendListResponse | null> {
    loading.value = true;
    error.value = null;
    try {
      const queryParams: Record<string, string> = {};
      if (params.accountId) queryParams.accountId = params.accountId;
      if (params.search && params.search.trim().length > 0) {
        queryParams.search = params.search.trim();
      }
      queryParams.page = String(params.page ?? 1);
      queryParams.perPage = String(params.perPage ?? 24);

      const res = await api.get<FriendListResponse>('/friends', {
        params: queryParams,
      });
      friends.value = res.data.data;
      pagination.value = res.data.pagination;
      return res.data;
    } catch (err: any) {
      error.value =
        err?.response?.data?.error ||
        err?.message ||
        'Không tải được danh sách bạn bè';
      return null;
    } finally {
      loading.value = false;
    }
  }

  return {
    friends,
    pagination,
    loading,
    error,
    total,
    fetchFriends,
  };
}
