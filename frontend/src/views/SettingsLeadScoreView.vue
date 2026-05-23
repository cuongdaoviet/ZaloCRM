<template>
  <div>
    <h1 class="text-h5 mb-4">
      <v-icon class="mr-2" color="primary">mdi-fire</v-icon>
      Cấu hình lead score
    </h1>

    <v-alert
      v-if="!authStore.isAdmin"
      type="warning"
      variant="tonal"
      class="mb-4"
    >
      Chỉ admin/chủ sở hữu mới có thể chỉnh sửa cấu hình.
    </v-alert>

    <v-alert v-if="!isCustom" type="info" density="comfortable" class="mb-4" variant="tonal">
      Đang dùng cấu hình mặc định (BR-0001..BR-0004). Mọi thay đổi sẽ được lưu
      vào tổ chức.
    </v-alert>

    <v-alert v-if="error" type="error" density="comfortable" class="mb-4" closable @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card class="mb-4 pa-4">
      <h3 class="text-h6 mt-0 mb-2">Recency — Tin nhắn inbound gần nhất (tối đa 40)</h3>
      <p class="text-body-2 text-medium-emphasis mb-3">
        Mỗi dòng: nếu inbound cuối ≤ <code>hours</code>, cộng <code>points</code> điểm.
        Hệ thống chọn dòng đầu tiên khớp (đã sắp xếp tăng dần theo giờ).
      </p>
      <v-table density="compact">
        <thead>
          <tr>
            <th>Hours (≤)</th>
            <th>Points</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(bucket, idx) in config.recencyBuckets" :key="idx">
            <td>
              <v-text-field
                v-model.number="bucket.hours"
                type="number"
                density="compact"
                hide-details
                :disabled="!authStore.isAdmin"
                min="0"
              />
            </td>
            <td>
              <v-text-field
                v-model.number="bucket.points"
                type="number"
                density="compact"
                hide-details
                :disabled="!authStore.isAdmin"
                min="0"
              />
            </td>
            <td>
              <v-btn
                icon size="small" variant="text" color="error"
                :disabled="!authStore.isAdmin || config.recencyBuckets.length === 1"
                @click="removeRecency(idx)"
              >
                <v-icon size="18">mdi-delete</v-icon>
              </v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>
      <v-btn
        size="small" variant="text" class="mt-2"
        prepend-icon="mdi-plus"
        :disabled="!authStore.isAdmin"
        @click="config.recencyBuckets.push({ hours: 24, points: 10 })"
      >
        Thêm dòng
      </v-btn>
    </v-card>

    <v-card class="mb-4 pa-4">
      <h3 class="text-h6 mt-0 mb-2">Engagement — Số tin inbound 30 ngày (tối đa 30)</h3>
      <p class="text-body-2 text-medium-emphasis mb-3">
        1 điểm / tin, cap tại giá trị dưới.
      </p>
      <v-text-field
        v-model.number="config.engagementCap"
        type="number"
        label="Engagement cap"
        :disabled="!authStore.isAdmin"
        min="0"
        style="max-width: 240px;"
      />
    </v-card>

    <v-card class="mb-4 pa-4">
      <h3 class="text-h6 mt-0 mb-2">Status — Điểm theo pipeline (tối đa 20)</h3>
      <v-row dense>
        <v-col
          v-for="status in STATUS_KEYS"
          :key="status"
          cols="12" sm="6" md="4"
        >
          <v-text-field
            v-model.number="config.statusPoints[status]"
            :label="statusLabel(status)"
            type="number"
            density="compact"
            :disabled="!authStore.isAdmin"
            min="0"
          />
        </v-col>
      </v-row>
    </v-card>

    <v-card class="mb-4 pa-4">
      <h3 class="text-h6 mt-0 mb-2">Appointment — Lịch hẹn sắp tới (tối đa 10)</h3>
      <p class="text-body-2 text-medium-emphasis mb-3">
        Mỗi dòng: nếu lịch hẹn gần nhất ≤ <code>daysWindow</code> ngày,
        cộng <code>points</code> điểm.
      </p>
      <v-table density="compact">
        <thead>
          <tr>
            <th>Days window (≤)</th>
            <th>Points</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(bucket, idx) in config.appointmentBuckets" :key="idx">
            <td>
              <v-text-field
                v-model.number="bucket.daysWindow"
                type="number"
                density="compact"
                hide-details
                :disabled="!authStore.isAdmin"
                min="0"
              />
            </td>
            <td>
              <v-text-field
                v-model.number="bucket.points"
                type="number"
                density="compact"
                hide-details
                :disabled="!authStore.isAdmin"
                min="0"
              />
            </td>
            <td>
              <v-btn
                icon size="small" variant="text" color="error"
                :disabled="!authStore.isAdmin"
                @click="config.appointmentBuckets.splice(idx, 1)"
              >
                <v-icon size="18">mdi-delete</v-icon>
              </v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>
      <v-btn
        size="small" variant="text" class="mt-2"
        prepend-icon="mdi-plus"
        :disabled="!authStore.isAdmin"
        @click="config.appointmentBuckets.push({ daysWindow: 30, points: 5 })"
      >
        Thêm dòng
      </v-btn>
    </v-card>

    <!-- Feature 0039 EC-0005 — sticky action bar on mobile.
         The lead-score editor is long (4 cards + 4 buckets) and the save
         button used to scroll off-screen on a 360px viewport. We pin the
         action row to the bottom on `xs/sm` so admins can save without
         scrolling back. Desktop keeps the inline placement. -->
    <div class="settings-action-bar d-flex align-center" style="gap: 8px;">
      <v-btn
        color="primary"
        :loading="saving"
        :disabled="!authStore.isAdmin"
        size="large"
        @click="onSave"
      >
        Lưu cấu hình
      </v-btn>
      <v-btn
        variant="text"
        :disabled="!authStore.isAdmin || !isCustom"
        @click="onReset"
      >
        Khôi phục mặc định
      </v-btn>
    </div>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="3000">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<style scoped>
/* Feature 0039 EC-0005 — sticky save bar on phones so the long lead-score
   form has its primary action reachable without scrolling back to the
   bottom. Above 600px we render inline. We use `position: sticky` (not
   fixed) so the bar still scrolls with content above 600px and is part
   of the natural document flow. */
.settings-action-bar {
  padding: 8px 0;
}
@media (max-width: 600px) {
  .settings-action-bar {
    position: sticky;
    /* MobileLayout adds 56px nav + safe-area inset to v-main's bottom
       padding, so anchoring at 0 puts us flush with the visible viewport
       bottom (above the nav). */
    bottom: 0;
    background: rgb(var(--v-theme-surface));
    z-index: 5;
    padding-top: 12px;
    padding-bottom: 12px;
    margin-top: 16px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }
}

/* Strip the default v-table cell border-bottom — on this page the rows
   are input groups (hours + points + delete), not tabular data, so the
   horizontal rules between rows just add visual noise around the input
   fields. `:deep` reaches past the scoped attribute selector into
   Vuetify's internal table markup. */
:deep(.v-table td),
:deep(.v-table th) {
  border-bottom: 0 !important;
}

/* Each <v-text-field> in the bucket tables defaults to the global
   `outlined` variant (set in vuetify.ts), which draws a 1px box around
   every input. Side by side in a table, those boxes read as "table cell
   borders" — the original complaint. Flatten the inputs inside this
   page's v-tables only: drop the outline, drop the inset shadow, keep
   the input usable on focus by tinting the background. */
:deep(.v-table .v-field) {
  background: transparent;
  box-shadow: none !important;
}
:deep(.v-table .v-field__outline) {
  display: none;
}
:deep(.v-table .v-field--focused) {
  background: rgba(var(--v-theme-primary), 0.06);
  border-radius: 6px;
}
</style>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useLeadScoreConfig } from '@/composables/use-lead-score';

const authStore = useAuthStore();
const {
  config,
  isCustom,
  saving,
  error,
  fetch: fetchConfig,
  save,
  reset,
} = useLeadScoreConfig();

const toast = ref({ show: false, text: '', color: 'success' });

const STATUS_KEYS = ['new', 'contacted', 'interested', 'converted', 'lost'];

function statusLabel(s: string) {
  const map: Record<string, string> = {
    new: 'Mới',
    contacted: 'Đã liên hệ',
    interested: 'Quan tâm',
    converted: 'Chuyển đổi',
    lost: 'Mất',
  };
  return map[s] ?? s;
}

function removeRecency(idx: number) {
  if (config.recencyBuckets.length === 1) return;
  config.recencyBuckets.splice(idx, 1);
}

async function onSave() {
  const r = await save();
  toast.value = r.ok
    ? { show: true, text: 'Đã lưu cấu hình lead score', color: 'success' }
    : { show: true, text: r.error ?? 'Lỗi không xác định', color: 'error' };
}

async function onReset() {
  const r = await reset();
  if (r.ok) {
    toast.value = { show: true, text: 'Đã khôi phục mặc định', color: 'success' };
  }
}

onMounted(fetchConfig);
</script>
