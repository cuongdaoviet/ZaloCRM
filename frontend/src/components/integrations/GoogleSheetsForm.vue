<template>
  <div>
    <v-alert v-if="!hasRefreshToken" type="info" density="compact" class="mb-3">
      Cần ủy quyền Google trước khi cấu hình. Bấm "Ủy quyền Google" để mở
      cửa sổ đăng nhập.
    </v-alert>

    <v-btn
      v-if="!hasRefreshToken"
      color="primary"
      prepend-icon="mdi-google"
      :loading="oauthLoading"
      @click="launchOAuth"
    >
      Ủy quyền Google
    </v-btn>

    <v-alert v-else type="success" density="compact" class="mb-3">
      Đã ủy quyền Google. Refresh token được lưu mã hóa.
    </v-alert>

    <v-text-field
      v-model="local.spreadsheetId"
      label="Spreadsheet ID"
      placeholder="Lấy từ URL Google Sheet"
      hint="Ví dụ: 1AbC...xyz (đoạn giữa /d/ và /edit trong URL)"
      persistent-hint
      class="mt-3"
    />
    <v-text-field
      v-model="local.sheetName"
      label="Tên sheet (tab)"
      placeholder="Contacts"
      class="mt-3"
    />
    <v-select
      v-model="local.schedule"
      :items="scheduleOptions"
      label="Tần suất sync"
      class="mt-3"
    />

    <v-expansion-panels class="mt-3">
      <v-expansion-panel title="Bộ lọc nâng cao (tuỳ chọn)">
        <v-expansion-panel-text>
          <v-select
            v-model="local.filter!.status"
            :items="statusOptions"
            label="Trạng thái"
            clearable
          />
          <v-text-field
            v-model="dateFromModel"
            label="Ngày tạo từ"
            type="date"
            class="mt-2"
          />
          <v-text-field
            v-model="dateToModel"
            label="Ngày tạo đến"
            type="date"
            class="mt-2"
          />
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { GoogleSheetsConfig } from '@/composables/use-integrations';
import { useIntegrations } from '@/composables/use-integrations';

const props = defineProps<{
  modelValue: GoogleSheetsConfig;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: GoogleSheetsConfig): void;
}>();

const local = reactive<GoogleSheetsConfig>({
  refreshToken: props.modelValue.refreshToken ?? '',
  spreadsheetId: props.modelValue.spreadsheetId ?? '',
  sheetName: props.modelValue.sheetName ?? 'Contacts',
  schedule: props.modelValue.schedule ?? 'daily',
  filter: { ...(props.modelValue.filter ?? {}) },
});

watch(
  () => local,
  (v) => emit('update:modelValue', { ...v, filter: { ...(v.filter ?? {}) } }),
  { deep: true },
);

const hasRefreshToken = computed(() => local.refreshToken.length > 0);

const scheduleOptions = [
  { title: 'Thủ công (manual trigger)', value: 'manual' },
  { title: 'Mỗi giờ', value: 'hourly' },
  { title: 'Hằng ngày 06:00', value: 'daily' },
];
const statusOptions = [
  { title: 'Mới', value: 'new' },
  { title: 'Đã liên hệ', value: 'contacted' },
  { title: 'Quan tâm', value: 'interested' },
  { title: 'Chuyển đổi', value: 'converted' },
  { title: 'Mất', value: 'lost' },
];

const dateFromModel = computed({
  get: () => local.filter?.dateFrom ?? '',
  set: (v: string) => {
    if (!local.filter) local.filter = {};
    local.filter.dateFrom = v || undefined;
  },
});
const dateToModel = computed({
  get: () => local.filter?.dateTo ?? '',
  set: (v: string) => {
    if (!local.filter) local.filter = {};
    local.filter.dateTo = v || undefined;
  },
});

const { getGoogleOAuthUrl } = useIntegrations();
const oauthLoading = ref(false);

async function launchOAuth(): Promise<void> {
  oauthLoading.value = true;
  try {
    const res = await getGoogleOAuthUrl();
    if (!res.ok) {
      // eslint-disable-next-line no-alert
      alert(`Không khởi tạo được OAuth: ${res.error}`);
      return;
    }
    // Open in a popup; the callback URL returns JSON which the user
    // copy-pastes back as the refresh token (phase-1 minimal flow). Phase 2
    // will use window.opener.postMessage for a clean round-trip.
    const popup = window.open(res.value.url, 'google-oauth', 'width=600,height=700');
    if (!popup) {
      // eslint-disable-next-line no-alert
      alert('Popup bị chặn — vui lòng cho phép popups và thử lại.');
      return;
    }
    // eslint-disable-next-line no-alert
    const token = prompt(
      'Sau khi Google redirect xong, dán giá trị "refreshToken" từ trang JSON vào đây:',
    );
    if (token && token.trim().length > 0) {
      local.refreshToken = token.trim();
    }
  } finally {
    oauthLoading.value = false;
  }
}

</script>
