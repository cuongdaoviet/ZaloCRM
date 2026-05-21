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
      <div class="text-h6 mb-2">Recency — Tin nhắn inbound gần nhất (tối đa 40)</div>
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
      <div class="text-h6 mb-2">Engagement — Số tin inbound 30 ngày (tối đa 30)</div>
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
      <div class="text-h6 mb-2">Status — Điểm theo pipeline (tối đa 20)</div>
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
      <div class="text-h6 mb-2">Appointment — Lịch hẹn sắp tới (tối đa 10)</div>
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

    <div class="d-flex align-center" style="gap: 8px;">
      <v-btn
        color="primary"
        :loading="saving"
        :disabled="!authStore.isAdmin"
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
