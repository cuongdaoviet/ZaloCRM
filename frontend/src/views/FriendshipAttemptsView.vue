<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">Kết bạn</h1>
      <v-spacer />
      <v-btn
        variant="text"
        prepend-icon="mdi-refresh"
        :loading="loading"
        @click="reload"
      >Làm mới</v-btn>
    </div>

    <!-- Filters -->
    <v-card class="pa-3 mb-3">
      <div class="d-flex flex-wrap ga-3">
        <v-select
          v-model="filterStates"
          :items="STATE_OPTIONS"
          item-title="title"
          item-value="value"
          label="Trạng thái"
          density="compact"
          variant="outlined"
          hide-details
          multiple
          chips
          clearable
          style="min-width: 280px; flex: 1 1 280px;"
          @update:model-value="reload"
        />
        <v-select
          v-model="filterAccount"
          :items="accountOptions"
          item-title="title"
          item-value="value"
          label="Tài khoản Zalo"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 240px; flex: 0 1 240px;"
          @update:model-value="reload"
        />
      </div>
    </v-card>

    <v-alert
      v-if="error"
      type="error"
      density="compact"
      closable
      class="mb-3"
      @click:close="error = ''"
    >{{ error }}</v-alert>

    <!-- Summary chips -->
    <div class="d-flex flex-wrap ga-2 mb-3">
      <v-chip
        v-for="state in (Object.keys(STATE_LABELS) as FriendshipState[])"
        :key="state"
        :color="STATE_COLORS[state]"
        :prepend-icon="STATE_ICONS[state]"
        variant="tonal"
        size="small"
      >
        {{ STATE_LABELS[state] }}: {{ stateCounts[state] ?? 0 }}
      </v-chip>
    </div>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="attempts"
        :loading="loading"
        no-data-text="Chưa có lời mời kết bạn nào"
        density="comfortable"
      >
        <template #item.contact="{ item }">
          <div class="d-flex align-center">
            <v-avatar size="32" class="mr-2">
              <v-img v-if="item.contact?.avatarUrl" :src="item.contact.avatarUrl" />
              <v-icon v-else>mdi-account-circle</v-icon>
            </v-avatar>
            <div class="d-flex flex-column">
              <span class="text-body-2">{{ item.contact?.fullName ?? '—' }}</span>
              <span class="text-caption text-medium-emphasis">{{ item.contact?.phone ?? '' }}</span>
            </div>
          </div>
        </template>
        <template #item.state="{ item }">
          <v-chip
            :color="STATE_COLORS[item.state]"
            :prepend-icon="STATE_ICONS[item.state]"
            size="small"
            variant="flat"
          >{{ STATE_LABELS[item.state] }}</v-chip>
        </template>
        <template #item.zaloAccount="{ item }">
          {{ item.zaloAccount?.displayName ?? '—' }}
        </template>
        <template #item.createdBy="{ item }">
          {{ item.createdBy?.fullName ?? 'Hệ thống' }}
        </template>
        <template #item.queuedAt="{ item }">
          {{ formatDate(item.queuedAt) }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            v-if="canCancel(item.state)"
            icon="mdi-close-circle"
            size="small"
            variant="text"
            color="error"
            title="Huỷ"
            @click="confirmCancel(item)"
          />
        </template>
      </v-data-table>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="d-flex justify-center pa-3">
        <v-pagination
          v-model="currentPage"
          :length="totalPages"
          :total-visible="7"
          @update:model-value="reload"
        />
      </div>
    </v-card>

    <!-- Cancel confirm -->
    <v-dialog v-model="cancelDialogOpen" max-width="420">
      <v-card>
        <v-card-title>Xác nhận huỷ</v-card-title>
        <v-card-text>
          Huỷ lời mời kết bạn tới
          <strong>{{ cancelTarget?.contact?.fullName ?? '?' }}</strong>?
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelDialogOpen = false">Đóng</v-btn>
          <v-btn color="error" :loading="cancelling" @click="doCancel">Huỷ lời mời</v-btn>
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
import {
  useFriendship,
  STATE_LABELS,
  STATE_COLORS,
  STATE_ICONS,
  type FriendshipAttempt,
  type FriendshipState,
} from '@/composables/use-friendship';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';

const {
  attempts,
  totalPages,
  loading,
  error,
  fetchAttempts,
  cancelAttempt,
} = useFriendship();

const { accounts, fetchAccounts } = useZaloAccounts();

const filterStates = ref<FriendshipState[]>([]);
const filterAccount = ref<string | null>(null);
const currentPage = ref(1);
const cancelDialogOpen = ref(false);
const cancelTarget = ref<FriendshipAttempt | null>(null);
const cancelling = ref(false);
const toast = ref({ show: false, text: '', color: 'success' });

const STATE_OPTIONS = (Object.keys(STATE_LABELS) as FriendshipState[]).map((s) => ({
  title: STATE_LABELS[s],
  value: s,
}));

const accountOptions = computed(() => [
  ...accounts.value.map((a) => ({
    title: a.displayName ?? 'Không tên',
    value: a.id,
  })),
]);

const headers = [
  { title: 'Khách hàng', key: 'contact', sortable: false },
  { title: 'Trạng thái', key: 'state' },
  { title: 'Zalo', key: 'zaloAccount' },
  { title: 'Người tạo', key: 'createdBy' },
  { title: 'Tạo lúc', key: 'queuedAt' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const, width: 60 },
];

// Per-state counts derived from the current page (cheap; full counts would
// require a separate aggregate endpoint).
const stateCounts = computed(() => {
  const out: Partial<Record<FriendshipState, number>> = {};
  for (const a of attempts.value) {
    out[a.state] = (out[a.state] ?? 0) + 1;
  }
  return out;
});

function canCancel(state: FriendshipState): boolean {
  return state === 'queued' || state === 'looking_up';
}

function confirmCancel(item: FriendshipAttempt) {
  cancelTarget.value = item;
  cancelDialogOpen.value = true;
}

async function doCancel() {
  if (!cancelTarget.value) return;
  cancelling.value = true;
  const r = await cancelAttempt(cancelTarget.value.id);
  cancelling.value = false;
  cancelDialogOpen.value = false;
  if (r.ok) {
    toast.value = { show: true, text: 'Đã huỷ lời mời', color: 'success' };
    await reload();
  } else {
    toast.value = { show: true, text: r.error, color: 'error' };
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

async function reload() {
  await fetchAttempts({
    state: filterStates.value.length > 0 ? filterStates.value : undefined,
    zaloAccountId: filterAccount.value ?? undefined,
    page: currentPage.value,
    limit: 50,
  });
}

onMounted(async () => {
  await Promise.all([fetchAccounts(), reload()]);
});
</script>
