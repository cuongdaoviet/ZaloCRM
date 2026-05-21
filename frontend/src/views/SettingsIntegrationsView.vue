<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">
        <v-icon class="mr-2" color="primary">mdi-puzzle</v-icon>
        Integrations
      </h1>
      <v-spacer />
      <v-btn
        v-if="authStore.isAdmin"
        color="primary"
        prepend-icon="mdi-plus"
        @click="openCreate"
      >
        Thêm integration
      </v-btn>
    </div>

    <p class="text-body-2 text-grey mb-3">
      Tích hợp ngoài: đẩy dữ liệu CRM ra Google Sheets theo lịch, hoặc gửi
      thông báo Telegram khi có sự kiện. Mỗi integration mã hoá lưu token —
      không xuất hiện plaintext trong response hay log.
    </p>

    <v-alert
      v-if="error"
      type="error"
      density="compact"
      closable
      class="mb-3"
      @click:close="error = ''"
    >
      {{ error }}
    </v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="integrations"
        :loading="loading"
        no-data-text="Chưa có integration nào"
        density="comfortable"
      >
        <template #item.type="{ item }">
          <v-chip size="x-small" variant="flat" :color="TYPE_COLOR[item.type] ?? 'default'">
            {{ TYPE_LABEL[item.type] ?? item.type }}
          </v-chip>
        </template>
        <template #item.enabled="{ item }">
          <v-chip
            size="x-small"
            variant="flat"
            :color="item.enabled ? 'success' : 'grey'"
          >
            {{ item.enabled ? 'Bật' : 'Tắt' }}
          </v-chip>
        </template>
        <template #item.lastSyncedAt="{ item }">
          {{ item.lastSyncedAt ? formatDate(item.lastSyncedAt) : '—' }}
        </template>
        <template #item.lastError="{ item }">
          <span v-if="!item.lastError" class="text-grey">—</span>
          <span v-else class="text-error">{{ item.lastError }}</span>
        </template>
        <template #item.controls="{ item }">
          <v-btn
            v-if="item.type === 'google_sheets' && item.enabled && item.configured"
            icon
            size="small"
            variant="text"
            title="Sync ngay"
            :loading="syncingId === item.id"
            @click="triggerSync(item)"
          >
            <v-icon>mdi-cloud-upload</v-icon>
          </v-btn>
          <v-btn
            icon
            size="small"
            variant="text"
            title="Lịch sử"
            @click="openRuns(item)"
          >
            <v-icon>mdi-history</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon
            size="small"
            variant="text"
            title="Sửa"
            @click="openEdit(item)"
          >
            <v-icon>mdi-pencil</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon
            size="small"
            variant="text"
            color="error"
            title="Xoá"
            @click="confirmDelete(item)"
          >
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialogOpen" max-width="640" persistent>
      <v-card>
        <v-card-title>
          {{ editingId ? 'Sửa integration' : 'Thêm integration' }}
        </v-card-title>
        <v-card-text>
          <v-select
            v-if="!editingId"
            v-model="formType"
            :items="TYPE_OPTIONS"
            label="Loại integration"
            class="mb-3"
          />
          <v-text-field
            v-model="formName"
            label="Tên hiển thị"
            placeholder="VD: Sales daily dump"
            class="mb-3"
          />
          <GoogleSheetsForm
            v-if="formType === 'google_sheets'"
            v-model="sheetsConfig"
          />
          <TelegramBotForm
            v-else-if="formType === 'telegram_bot'"
            v-model="telegramConfig"
          />

          <v-alert
            v-if="dialogError"
            type="error"
            density="compact"
            closable
            class="mt-3"
            @click:close="dialogError = ''"
          >
            {{ dialogError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn :disabled="saving" @click="dialogOpen = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="saving" @click="onSave">
            Lưu (test kết nối)
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Runs dialog -->
    <v-dialog v-model="runsOpen" max-width="720">
      <v-card>
        <v-card-title>Lịch sử chạy</v-card-title>
        <v-card-text>
          <v-data-table
            :headers="runHeaders"
            :items="runs"
            :loading="runsLoading"
            no-data-text="Chưa có lượt chạy nào"
            density="comfortable"
          >
            <template #item.status="{ item }">
              <v-chip
                size="x-small"
                variant="flat"
                :color="STATUS_COLORS[item.status] ?? 'default'"
              >
                {{ STATUS_LABELS[item.status] ?? item.status }}
              </v-chip>
            </template>
            <template #item.startedAt="{ item }">
              {{ formatDate(item.startedAt) }}
            </template>
            <template #item.errorDetail="{ item }">
              <span v-if="!item.errorDetail" class="text-grey">—</span>
              <span v-else class="text-error">{{ item.errorDetail }}</span>
            </template>
          </v-data-table>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="runsOpen = false">Đóng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm -->
    <v-dialog v-model="deleteOpen" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xoá</v-card-title>
        <v-card-text>
          Xoá integration "{{ deleteTarget?.name }}"? Lịch sử chạy được giữ
          lại, nhưng cấu hình + token sẽ bị xoá vĩnh viễn.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteOpen = false">Huỷ</v-btn>
          <v-btn color="error" @click="runDelete">Xoá</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="3000">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import GoogleSheetsForm from '@/components/integrations/GoogleSheetsForm.vue';
import TelegramBotForm from '@/components/integrations/TelegramBotForm.vue';
import {
  useIntegrations,
  STATUS_LABELS,
  STATUS_COLORS,
  type Integration,
  type IntegrationRun,
  type IntegrationType,
  type GoogleSheetsConfig,
  type TelegramBotConfig,
} from '@/composables/use-integrations';

const authStore = useAuthStore();
const {
  integrations,
  loading,
  error,
  fetchAll,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  triggerSync: triggerSyncApi,
  listRuns,
} = useIntegrations();

const headers = [
  { title: 'Tên', key: 'name' },
  { title: 'Loại', key: 'type' },
  { title: 'Trạng thái', key: 'enabled' },
  { title: 'Sync gần nhất', key: 'lastSyncedAt' },
  { title: 'Lỗi gần đây', key: 'lastError', sortable: false },
  { title: '', key: 'controls', sortable: false, align: 'end' as const, width: 200 },
];

const runHeaders = [
  { title: 'Bắt đầu', key: 'startedAt' },
  { title: 'Trạng thái', key: 'status' },
  { title: 'Records', key: 'recordsProcessed', align: 'end' as const },
  { title: 'Lỗi', key: 'errorDetail', sortable: false },
];

const TYPE_OPTIONS = [
  { title: 'Google Sheets', value: 'google_sheets' },
  { title: 'Telegram Bot', value: 'telegram_bot' },
];
const TYPE_LABEL: Record<string, string> = {
  google_sheets: 'Google Sheets',
  telegram_bot: 'Telegram Bot',
};
const TYPE_COLOR: Record<string, string> = {
  google_sheets: 'green',
  telegram_bot: 'blue',
};

const dialogOpen = ref(false);
const dialogError = ref('');
const editingId = ref<string | null>(null);
const formType = ref<IntegrationType>('google_sheets');
const formName = ref('');
const saving = ref(false);

function emptySheetsConfig(): GoogleSheetsConfig {
  return {
    refreshToken: '',
    spreadsheetId: '',
    sheetName: 'Contacts',
    schedule: 'daily',
    filter: {},
  };
}
function emptyTelegramConfig(): TelegramBotConfig {
  return {
    botToken: '',
    chatId: '',
    eventTypes: ['contact.created'],
  };
}
const sheetsConfig = ref<GoogleSheetsConfig>(emptySheetsConfig());
const telegramConfig = ref<TelegramBotConfig>(emptyTelegramConfig());

const runsOpen = ref(false);
const runsLoading = ref(false);
const runs = ref<IntegrationRun[]>([]);
const runsTargetId = ref<string | null>(null);

const deleteOpen = ref(false);
const deleteTarget = ref<Integration | null>(null);

const syncingId = ref<string | null>(null);

const toast = ref({ show: false, text: '', color: 'success' });

function openCreate(): void {
  editingId.value = null;
  formType.value = 'google_sheets';
  formName.value = '';
  sheetsConfig.value = emptySheetsConfig();
  telegramConfig.value = emptyTelegramConfig();
  dialogError.value = '';
  dialogOpen.value = true;
}

function openEdit(item: Integration): void {
  editingId.value = item.id;
  formType.value = item.type;
  formName.value = item.name;
  sheetsConfig.value = emptySheetsConfig();
  telegramConfig.value = emptyTelegramConfig();
  dialogError.value = '';
  dialogOpen.value = true;
}

const currentConfig = computed(() =>
  formType.value === 'google_sheets' ? sheetsConfig.value : telegramConfig.value,
);

async function onSave(): Promise<void> {
  saving.value = true;
  dialogError.value = '';
  try {
    if (editingId.value) {
      const res = await updateIntegration(editingId.value, {
        name: formName.value,
        config: currentConfig.value,
      });
      if (!res.ok) {
        dialogError.value = res.error;
        return;
      }
    } else {
      const res = await createIntegration({
        type: formType.value,
        name: formName.value,
        config: currentConfig.value,
      });
      if (!res.ok) {
        dialogError.value = res.error;
        return;
      }
    }
    dialogOpen.value = false;
    toast.value = { show: true, text: 'Đã lưu', color: 'success' };
    await fetchAll();
  } finally {
    saving.value = false;
  }
}

function confirmDelete(item: Integration): void {
  deleteTarget.value = item;
  deleteOpen.value = true;
}

async function runDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  const res = await deleteIntegration(deleteTarget.value.id);
  deleteOpen.value = false;
  if (!res.ok) {
    toast.value = { show: true, text: res.error, color: 'error' };
    return;
  }
  toast.value = { show: true, text: 'Đã xoá', color: 'success' };
  await fetchAll();
}

async function triggerSync(item: Integration): Promise<void> {
  syncingId.value = item.id;
  const res = await triggerSyncApi(item.id);
  syncingId.value = null;
  if (!res.ok) {
    toast.value = { show: true, text: res.error, color: 'error' };
    return;
  }
  toast.value = { show: true, text: 'Đã kích hoạt sync', color: 'success' };
  // Allow background work to complete a moment before refreshing.
  setTimeout(() => fetchAll(), 1500);
}

async function openRuns(item: Integration): Promise<void> {
  runsTargetId.value = item.id;
  runsOpen.value = true;
  runsLoading.value = true;
  const res = await listRuns(item.id);
  runsLoading.value = false;
  if (res.ok) {
    runs.value = res.value;
  } else {
    toast.value = { show: true, text: res.error, color: 'error' };
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('vi-VN');
  } catch {
    return iso;
  }
}

onMounted(() => {
  void fetchAll();
});
</script>
