/**
 * use-lead-score.ts — Feature 0040 (Lead scoring) FE primitives.
 *
 * Provides:
 *   - LeadScoreBreakdown + LeadScoreConfig type definitions
 *   - bandForScore() — score → 'hot' | 'warm' | 'normal' | 'cold' (BR-0011)
 *   - bandMeta — color + Vietnamese label per band (matches Vuetify palette)
 *   - useLeadScoreConfig() composable for the admin settings page
 *
 * The backend embeds `leadScore` + `leadScoreBreakdown` directly on each
 * Contact in the list/detail response, so the contact list doesn't need a
 * separate fetch — only this module's `bandMeta` helper.
 */
import { reactive, ref } from 'vue';
import { api } from '@/api/index';

export interface LeadScoreBreakdown {
  recency: number;
  engagement: number;
  status: number;
  appointment: number;
}

export interface RecencyBucket {
  hours: number;
  points: number;
}

export interface AppointmentBucket {
  daysWindow: number;
  points: number;
}

export interface LeadScoreConfig {
  recencyBuckets: RecencyBucket[];
  engagementCap: number;
  statusPoints: Record<string, number>;
  appointmentBuckets: AppointmentBucket[];
}

export type LeadScoreBand = 'hot' | 'warm' | 'normal' | 'cold';

/** Score band per BR-0011. Keep in sync with backend lead-score-helpers.ts. */
export function bandForScore(score: number): LeadScoreBand {
  if (score >= 80) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 20) return 'normal';
  return 'cold';
}

/** Vuetify color + VN label per band (BR-0011).
 * Feature 0049 F10 — pulled the band palette apart so users can
 * distinguish hot/warm/normal/cold from across the room. Previously
 * `warm`=orange and `normal`=amber were nearly identical reds, making
 * the badge feel like decoration instead of information. */
export const bandMeta: Record<LeadScoreBand, { color: string; label: string }> = {
  hot: { color: 'red-darken-2', label: 'Nóng' },        // saturated red — pull eye
  warm: { color: 'orange-darken-1', label: 'Ấm' },      // mid orange — distinct from red
  normal: { color: 'blue-grey-lighten-1', label: 'Bình thường' }, // cool muted neutral
  cold: { color: 'grey-lighten-1', label: 'Nguội' },    // lightest, fades into row
};

/** Default config — used as a placeholder before the GET resolves. */
export const DEFAULT_LEAD_SCORE_CONFIG: LeadScoreConfig = {
  recencyBuckets: [
    { hours: 1, points: 40 },
    { hours: 24, points: 30 },
    { hours: 24 * 7, points: 20 },
    { hours: 24 * 30, points: 10 },
  ],
  engagementCap: 30,
  statusPoints: {
    interested: 20,
    contacted: 10,
    new: 5,
    converted: 0,
    lost: 0,
  },
  appointmentBuckets: [
    { daysWindow: 7, points: 10 },
    { daysWindow: 30, points: 5 },
  ],
};

export function useLeadScoreConfig() {
  const config = reactive<LeadScoreConfig>({ ...DEFAULT_LEAD_SCORE_CONFIG });
  const defaults = ref<LeadScoreConfig>({ ...DEFAULT_LEAD_SCORE_CONFIG });
  const isCustom = ref(false);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref('');

  async function fetch() {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/settings/lead-score-config');
      Object.assign(config, res.data.config);
      defaults.value = res.data.defaults;
      isCustom.value = res.data.isCustom;
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
        'Không tải được cấu hình lead score';
      error.value = msg;
    } finally {
      loading.value = false;
    }
  }

  async function save(): Promise<{ ok: boolean; error?: string }> {
    saving.value = true;
    error.value = '';
    try {
      const res = await api.put('/settings/lead-score-config', config);
      Object.assign(config, res.data.config);
      isCustom.value = res.data.isCustom;
      return { ok: true };
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
        'Không lưu được cấu hình lead score';
      error.value = msg;
      return { ok: false, error: msg };
    } finally {
      saving.value = false;
    }
  }

  async function reset(): Promise<{ ok: boolean }> {
    saving.value = true;
    try {
      const res = await api.delete('/settings/lead-score-config');
      Object.assign(config, res.data.config);
      isCustom.value = false;
      return { ok: true };
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
        'Không reset được cấu hình';
      error.value = msg;
      return { ok: false };
    } finally {
      saving.value = false;
    }
  }

  return {
    config,
    defaults,
    isCustom,
    loading,
    saving,
    error,
    fetch,
    save,
    reset,
  };
}
