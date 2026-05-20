import { ref } from 'vue';
import { api } from '@/api/index';

export interface ActivityRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  user: { id: string; fullName: string } | null;
}

export interface ActivityFilters {
  entityType?: string;
  action?: string;
  userId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface ActivityResponse {
  activities: ActivityRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function useActivity() {
  const activities = ref<ActivityRow[]>([]);
  const total = ref(0);
  const page = ref(1);
  const totalPages = ref(0);
  const loading = ref(false);
  const error = ref('');

  async function fetchActivity(filters: ActivityFilters = {}) {
    loading.value = true;
    error.value = '';
    try {
      const params: Record<string, string | number> = {};
      if (filters.entityType) params.entityType = filters.entityType;
      if (filters.action) params.action = filters.action;
      if (filters.userId) params.userId = filters.userId;
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      if (filters.page) params.page = filters.page;
      if (filters.limit) params.limit = filters.limit;
      const res = await api.get<ActivityResponse>('/activity', { params });
      activities.value = res.data.activities;
      total.value = res.data.total;
      page.value = res.data.page;
      totalPages.value = res.data.totalPages;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      activities.value = [];
    } finally {
      loading.value = false;
    }
  }

  return { activities, total, page, totalPages, loading, error, fetchActivity };
}

// Human-readable action labels for the UI
export const ACTION_LABELS: Record<string, string> = {
  'campaign.created': 'Tạo chiến dịch',
  'campaign.started': 'Bắt đầu chiến dịch',
  'campaign.paused': 'Tạm dừng chiến dịch',
  'campaign.resumed': 'Tiếp tục chiến dịch',
  'campaign.cancelled': 'Huỷ chiến dịch',
  'campaign.completed': 'Chiến dịch hoàn tất',
  'contact.created': 'Tạo khách hàng',
  'contact.status_changed': 'Đổi trạng thái KH',
  'contact.assigned': 'Gán KH cho nhân viên',
  'contact.merged': 'Gộp khách trùng',
  'note.created': 'Tạo ghi chú',
  'note.updated': 'Sửa ghi chú',
  'note.deleted': 'Xoá ghi chú',
  'keyword_rule.fired': 'Auto-tag fire',
  'auto_reply.fired': 'Auto-reply gửi',
};

export const ENTITY_TYPE_OPTIONS = [
  { title: 'Chiến dịch', value: 'campaign' },
  { title: 'Khách hàng', value: 'contact' },
  { title: 'Ghi chú', value: 'conversation_note' },
  { title: 'Auto-tag', value: 'keyword_rule' },
  { title: 'Zalo account', value: 'zalo_account' },
];
