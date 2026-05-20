import { ref } from 'vue';
import { api } from '@/api/index';

// Feature 0019 Phase B — tags are enriched objects { id, name, color, emoji }.
// `tagNames` is the back-compat string[] shim, deprecated in Phase C.
export interface OverviewContactTag {
  id: string;
  name: string;
  color: string;
  emoji: string | null;
}

export interface OverviewContact {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  avatarUrl: string | null;
  source: string | null;
  status: string | null;
  tags: OverviewContactTag[];
  /** Deprecated: kept for clients still expecting bare string[]. Drops in Phase C. */
  tagNames: string[];
  nextAppointment: string | null;
  assignedUser: { id: string; fullName: string } | null;
  createdAt: string;
  firstContactDate: string | null;
}

export interface OverviewStats {
  lifetimeRevenue: number;
  orderCount: number;
  completedOrderCount: number;
  appointmentCount: number;
  upcomingAppointmentCount: number;
  totalMessages: number;
}

export interface RecentMessage {
  id: string;
  senderType: 'self' | 'contact';
  content: string | null;
  contentType: string;
  sentAt: string;
}

export interface OverviewConversation {
  id: string;
  zaloAccountId: string;
  lastMessageAt: string | null;
  unreadCount: number;
  recentMessages: RecentMessage[];
}

export interface OverviewOrder {
  id: string;
  orderCode: string;
  totalAmount: number;
  status: string;
  createdAt: string;
  createdBy: { id: string; fullName: string } | null;
}

export interface OverviewAppointment {
  id: string;
  appointmentDate: string;
  appointmentTime: string | null;
  status: string;
  type: string | null;
  notes: string | null;
  assignedUser: { id: string; fullName: string } | null;
}

export interface OverviewNote {
  id: string;
  content: string;
  createdAt: string;
  author: { id: string; fullName: string };
}

export interface OverviewActivity {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  user: { id: string; fullName: string } | null;
}

export interface CustomerOverview {
  contact: OverviewContact;
  stats: OverviewStats;
  primaryConversation: OverviewConversation | null;
  orders: OverviewOrder[];
  appointments: OverviewAppointment[];
  notes: OverviewNote[];
  activity: OverviewActivity[];
}

export function useCustomerOverview() {
  const overview = ref<CustomerOverview | null>(null);
  const loading = ref(false);
  const error = ref('');

  async function fetchOverview(contactId: string) {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get<CustomerOverview>(`/contacts/${contactId}/overview`);
      overview.value = res.data;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      overview.value = null;
    } finally {
      loading.value = false;
    }
  }

  return { overview, loading, error, fetchOverview };
}

export const STATUS_LABELS: Record<string, string> = {
  new: 'Mới',
  contacted: 'Đã liên hệ',
  interested: 'Quan tâm',
  converted: 'Đã chốt',
  lost: 'Mất',
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  new: 'Mới',
  confirmed: 'Đã xác nhận',
  paid: 'Đã thanh toán',
  shipped: 'Đã giao',
  completed: 'Hoàn tất',
  cancelled: 'Đã huỷ',
};

export const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Đã lên lịch',
  completed: 'Đã hoàn thành',
  cancelled: 'Đã huỷ',
  no_show: 'Không đến',
};
