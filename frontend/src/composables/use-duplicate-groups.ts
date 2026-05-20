/**
 * Composable for feature 0018 — duplicate contact detection + merge.
 *
 * Wraps the 5 backend endpoints into a typed surface the views can use:
 *   - fetchList(filters)
 *   - fetchDetail(id)
 *   - scan(levels?)
 *   - merge(groupId, primaryId, fieldsToKeep?)
 *   - dismiss(groupId, reason?)
 */
import { ref } from 'vue';
import { api } from '@/api/index';

export type DuplicateLevel = 'phone_exact' | 'zaloUid_exact' | 'name_fuzzy';
export type GroupStatus = 'pending' | 'merged' | 'dismissed';

export interface DuplicateContactPreview {
  id: string;
  fullName: string | null;
  phone: string | null;
}

export interface DuplicateGroupListItem {
  id: string;
  level: DuplicateLevel;
  confidence: number;
  status: GroupStatus;
  contactCount: number;
  contactsPreview: DuplicateContactPreview[];
  detectedAt: string;
  resolvedAt: string | null;
  primaryContactId: string | null;
}

export interface DuplicateContactDetail {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  status: string | null;
  tags: string[];
  createdAt: string;
  assignedUser: { id: string; fullName: string } | null;
  stats: {
    conversations: number;
    orders: number;
    appointments: number;
    notes: number;
  };
}

export interface DuplicateGroupDetail {
  id: string;
  level: DuplicateLevel;
  confidence: number;
  status: GroupStatus;
  contacts: DuplicateContactDetail[];
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: { id: string; fullName: string } | null;
  primaryContactId: string | null;
}

export interface ScanResult {
  status: 'completed' | 'queued';
  groupsCreated?: number;
  groupsExisting?: number;
  contactsScanned?: number;
  durationMs?: number;
  jobId?: string;
  estimatedSeconds?: number;
  nameSkipped?: boolean;
}

export interface MergeMoved {
  conversations: number;
  orders: number;
  appointments: number;
  notes: number;
  campaignTargets: number;
  skippedDuplicateTargets: number;
  mergedConversations: number;
}

export interface MergeResult {
  status: 'merged';
  primaryContactId: string;
  mergedContactIds: string[];
  moved: MergeMoved;
}

export const LEVEL_LABELS: Record<DuplicateLevel, string> = {
  phone_exact: 'Trùng số điện thoại',
  zaloUid_exact: 'Trùng Zalo UID',
  name_fuzzy: 'Trùng tên (gần đúng)',
};

export const STATUS_LABELS: Record<GroupStatus, string> = {
  pending: 'Chờ xử lý',
  merged: 'Đã gộp',
  dismissed: 'Đã bỏ qua',
};

export function useDuplicateGroups() {
  const groups = ref<DuplicateGroupListItem[]>([]);
  const total = ref(0);
  const page = ref(1);
  const limit = ref(50);
  const loading = ref(false);
  const error = ref('');

  async function fetchList(filters: {
    status?: GroupStatus | 'all';
    level?: DuplicateLevel;
    page?: number;
    limit?: number;
  } = {}) {
    loading.value = true;
    error.value = '';
    try {
      const params: Record<string, string | number> = {};
      if (filters.status) params.status = filters.status;
      if (filters.level) params.level = filters.level;
      if (filters.page) params.page = filters.page;
      if (filters.limit) params.limit = filters.limit;
      const res = await api.get<{
        groups: DuplicateGroupListItem[];
        total: number;
        page: number;
        limit: number;
      }>('/duplicate-groups', { params });
      groups.value = res.data.groups;
      total.value = res.data.total;
      page.value = res.data.page;
      limit.value = res.data.limit;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      groups.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function fetchDetail(id: string): Promise<DuplicateGroupDetail | null> {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get<DuplicateGroupDetail>(`/duplicate-groups/${id}`);
      return res.data;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function scan(levels?: DuplicateLevel[]): Promise<ScanResult | null> {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.post<ScanResult>('/contacts/scan-duplicates', { levels });
      return res.data;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function merge(
    groupId: string,
    primaryContactId: string,
    fieldsToKeep?: Record<string, string>,
  ): Promise<MergeResult | null> {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.post<MergeResult>(`/duplicate-groups/${groupId}/merge`, {
        primaryContactId,
        fieldsToKeep,
      });
      return res.data;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function dismiss(groupId: string, reason?: string): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      await api.post(`/duplicate-groups/${groupId}/dismiss`, { reason });
      return true;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      return false;
    } finally {
      loading.value = false;
    }
  }

  return {
    groups,
    total,
    page,
    limit,
    loading,
    error,
    fetchList,
    fetchDetail,
    scan,
    merge,
    dismiss,
  };
}
