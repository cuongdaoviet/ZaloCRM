import { ref } from 'vue';
import { api } from '@/api/index';

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled';

export type TargetStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface CampaignFilter {
  status?: string[];
  source?: string[];
  tags?: string[];
}

export interface CampaignInput {
  name: string;
  zaloAccountId: string;
  message: string;
  filter: CampaignFilter;
  scheduledAt?: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  message: string;
  status: CampaignStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalTargets: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
  createdBy?: { id: string; fullName: string };
  zaloAccount?: { id: string; displayName: string | null };
}

export interface CampaignTarget {
  id: string;
  status: TargetStatus;
  errorMessage: string | null;
  sentAt: string | null;
  attemptCount: number;
  contact: {
    id: string;
    fullName: string | null;
    phone: string | null;
    zaloUid: string | null;
    avatarUrl: string | null;
  };
}

export function useCampaigns() {
  const campaigns = ref<Campaign[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchCampaigns(status?: CampaignStatus) {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/campaigns', { params: status ? { status } : {} });
      campaigns.value = res.data.campaigns;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
    } finally {
      loading.value = false;
    }
  }

  async function createCampaign(
    input: CampaignInput,
  ): Promise<{ ok: true; campaign: Campaign } | { ok: false; error: string }> {
    try {
      const res = await api.post('/campaigns', input);
      return { ok: true, campaign: res.data };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function transition(
    id: string,
    action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry-failed',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await api.post(`/campaigns/${id}/${action}`);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function deleteCampaign(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await api.delete(`/campaigns/${id}`);
      campaigns.value = campaigns.value.filter((c) => c.id !== id);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  return {
    campaigns, loading, error,
    fetchCampaigns, createCampaign, transition, deleteCampaign,
  };
}

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Nháp',
  scheduled: 'Đã lên lịch',
  running: 'Đang chạy',
  paused: 'Tạm dừng',
  completed: 'Hoàn tất',
  cancelled: 'Đã huỷ',
};

export const STATUS_COLORS: Record<CampaignStatus, string> = {
  draft: 'grey',
  scheduled: 'info',
  running: 'success',
  paused: 'warning',
  completed: 'primary',
  cancelled: 'error',
};
