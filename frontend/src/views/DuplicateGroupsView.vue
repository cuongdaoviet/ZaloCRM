<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px;">
      <h1 class="text-h5">Khách trùng</h1>
      <v-spacer />
      <v-btn
        color="primary"
        :loading="scanning"
        prepend-icon="mdi-magnify-scan"
        @click="runScan"
      >Quét trùng</v-btn>
    </div>

    <v-alert
      v-if="lastScanMessage"
      type="info"
      density="compact"
      class="mb-3"
      closable
      @click:close="lastScanMessage = ''"
    >{{ lastScanMessage }}</v-alert>

    <v-alert
      v-if="error"
      type="error"
      density="compact"
      class="mb-3"
      closable
      @click:close="error = ''"
    >{{ error }}</v-alert>

    <v-card class="pa-3 mb-3">
      <div class="d-flex flex-wrap align-center" style="gap: 12px;">
        <v-select
          v-model="filters.status"
          :items="STATUS_OPTIONS"
          item-title="title"
          item-value="value"
          label="Trạng thái"
          density="compact"
          variant="outlined"
          hide-details
          style="min-width: 180px;"
          @update:model-value="reload(1)"
        />
        <v-select
          v-model="filters.level"
          :items="LEVEL_OPTIONS"
          item-title="title"
          item-value="value"
          label="Tiêu chí"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 200px;"
          @update:model-value="reload(1)"
        />
      </div>
    </v-card>

    <v-card>
      <div class="d-flex align-center pa-3 text-body-2 text-grey">
        <span v-if="total > 0">Tìm thấy <strong>{{ total }}</strong> nhóm</span>
        <span v-else-if="!loading">Không có nhóm nào</span>
      </div>
      <v-divider />
      <v-list density="comfortable">
        <v-list-item
          v-for="group in groups"
          :key="group.id"
          :to="`/duplicate-groups/${group.id}`"
        >
          <template #prepend>
            <v-avatar :color="levelColor(group.level)" size="36">
              <v-icon size="20" color="white">mdi-account-multiple</v-icon>
            </v-avatar>
          </template>
          <v-list-item-title class="d-flex align-center">
            <span class="text-body-1 font-weight-medium">
              {{ LEVEL_LABELS[group.level] }}
            </span>
            <v-chip
              size="x-small"
              variant="tonal"
              :color="statusColor(group.status)"
              class="ml-2"
            >{{ STATUS_LABELS[group.status] }}</v-chip>
            <v-chip
              size="x-small"
              variant="tonal"
              color="grey"
              class="ml-2"
            >{{ group.contactCount }} contact</v-chip>
            <v-spacer />
            <span class="text-caption text-grey">{{ formatDate(group.detectedAt) }}</span>
          </v-list-item-title>
          <v-list-item-subtitle class="mt-1">
            <span v-for="(c, idx) in group.contactsPreview" :key="c.id">
              <span class="font-weight-medium">{{ c.fullName || '(không tên)' }}</span>
              <span v-if="c.phone" class="text-grey"> · {{ c.phone }}</span>
              <span v-if="idx < group.contactsPreview.length - 1"> &nbsp; vs &nbsp; </span>
            </span>
            <span
              v-if="group.contactCount > group.contactsPreview.length"
              class="text-grey"
            > &nbsp; + {{ group.contactCount - group.contactsPreview.length }} khác</span>
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import {
  useDuplicateGroups,
  LEVEL_LABELS,
  STATUS_LABELS,
  type DuplicateLevel,
  type GroupStatus,
} from '@/composables/use-duplicate-groups';

const router = useRouter();
const authStore = useAuthStore();

if (!authStore.isAdmin) {
  router.replace('/');
}

const {
  groups,
  total,
  loading,
  error,
  fetchList,
  scan,
} = useDuplicateGroups();

const filters = ref<{
  status: GroupStatus | 'all';
  level: DuplicateLevel | undefined;
}>({ status: 'pending', level: undefined });

const scanning = ref(false);
const lastScanMessage = ref('');

const STATUS_OPTIONS = [
  { title: 'Chờ xử lý', value: 'pending' },
  { title: 'Đã gộp', value: 'merged' },
  { title: 'Đã bỏ qua', value: 'dismissed' },
  { title: 'Tất cả', value: 'all' },
];
const LEVEL_OPTIONS = [
  { title: 'Trùng SĐT', value: 'phone_exact' },
  { title: 'Trùng Zalo UID', value: 'zaloUid_exact' },
  { title: 'Trùng tên (gần đúng)', value: 'name_fuzzy' },
];

function levelColor(level: DuplicateLevel): string {
  if (level === 'phone_exact') return 'success';
  if (level === 'zaloUid_exact') return 'info';
  return 'warning';
}

function statusColor(status: GroupStatus): string {
  if (status === 'pending') return 'warning';
  if (status === 'merged') return 'success';
  return 'grey';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

async function reload(targetPage: number) {
  await fetchList({
    status: filters.value.status,
    level: filters.value.level,
    page: targetPage,
    limit: 50,
  });
}

async function runScan() {
  scanning.value = true;
  lastScanMessage.value = '';
  try {
    const r = await scan();
    if (!r) return;
    if (r.status === 'queued') {
      lastScanMessage.value = `Đang quét nền — ước tính ${r.estimatedSeconds ?? '?'}s. Tải lại sau ít phút.`;
    } else {
      lastScanMessage.value = `Quét xong: tạo ${r.groupsCreated ?? 0} nhóm mới, ${
        r.groupsExisting ?? 0
      } nhóm đã tồn tại (${r.contactsScanned ?? 0} contact, ${r.durationMs ?? 0}ms).`;
      await reload(1);
    }
  } finally {
    scanning.value = false;
  }
}

onMounted(() => reload(1));
</script>
