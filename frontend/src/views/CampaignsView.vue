<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">Chiến dịch</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreateDialog">
        Tạo chiến dịch
      </v-btn>
    </div>

    <v-card class="pa-3 mb-3">
      <v-select
        v-model="filterStatus"
        :items="STATUS_FILTER_OPTIONS"
        item-title="title" item-value="value"
        label="Lọc trạng thái"
        density="compact" variant="outlined" hide-details clearable
        style="max-width: 240px;"
        @update:model-value="reload"
      />
    </v-card>

    <v-alert v-if="error" type="error" density="compact" closable class="mb-3" @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="campaigns"
        :loading="loading"
        no-data-text="Chưa có chiến dịch nào"
        @click:row="(_e: unknown, ctx: { item: Campaign }) => openDetail(ctx.item)"
        density="comfortable"
      >
        <template #item.status="{ item }">
          <v-chip :color="STATUS_COLORS[item.status]" size="small" variant="flat">
            {{ STATUS_LABELS[item.status] }}
          </v-chip>
        </template>
        <template #item.progress="{ item }">
          <span class="text-body-2">
            {{ item.sentCount }}/{{ item.totalTargets }}
            <span v-if="item.failedCount > 0" class="text-error">· {{ item.failedCount }} lỗi</span>
            <span v-if="item.skippedCount > 0" class="text-grey">· {{ item.skippedCount }} bỏ qua</span>
          </span>
        </template>
        <template #item.zaloAccount="{ item }">
          {{ item.zaloAccount?.displayName || '—' }}
        </template>
        <template #item.createdAt="{ item }">
          {{ formatDate(item.createdAt) }}
        </template>
        <template #item.actions="{ item }">
          <v-btn
            v-if="item.status === 'draft'"
            icon size="small" variant="text" color="success"
            title="Bắt đầu" @click.stop="runAction(item, 'start')"
          ><v-icon>mdi-play</v-icon></v-btn>
          <v-btn
            v-if="item.status === 'running'"
            icon size="small" variant="text" color="warning"
            title="Tạm dừng" @click.stop="runAction(item, 'pause')"
          ><v-icon>mdi-pause</v-icon></v-btn>
          <v-btn
            v-if="item.status === 'paused'"
            icon size="small" variant="text" color="success"
            title="Tiếp tục" @click.stop="runAction(item, 'resume')"
          ><v-icon>mdi-play</v-icon></v-btn>
          <v-btn
            v-if="['running', 'paused', 'scheduled'].includes(item.status)"
            icon size="small" variant="text" color="error"
            title="Huỷ" @click.stop="runAction(item, 'cancel')"
          ><v-icon>mdi-close-circle</v-icon></v-btn>
          <v-btn
            v-if="item.failedCount > 0 && (item.status === 'completed' || item.status === 'paused')"
            icon size="small" variant="text" color="warning"
            title="Retry failed" @click.stop="runAction(item, 'retry-failed')"
          ><v-icon>mdi-replay</v-icon></v-btn>
          <v-btn
            v-if="item.status === 'completed' || item.status === 'cancelled'"
            icon size="small" variant="text" color="error"
            title="Xoá" @click.stop="confirmDelete(item)"
          ><v-icon>mdi-delete</v-icon></v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create dialog -->
    <CampaignCreateDialog
      v-model="createDialogOpen"
      @created="onCreated"
    />

    <!-- Detail dialog -->
    <CampaignDetailDialog
      v-if="selectedCampaign"
      v-model="detailDialogOpen"
      :campaign-id="selectedCampaign.id"
      @action="reload"
    />

    <!-- Delete confirm -->
    <v-dialog v-model="deleteDialogOpen" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xoá</v-card-title>
        <v-card-text>Xoá chiến dịch "{{ deleteTarget?.name }}"?</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialogOpen = false">Hủy</v-btn>
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
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import {
  useCampaigns,
  STATUS_LABELS,
  STATUS_COLORS,
  type Campaign,
  type CampaignStatus,
} from '@/composables/use-campaigns';
import CampaignCreateDialog from '@/components/campaigns/CampaignCreateDialog.vue';
import CampaignDetailDialog from '@/components/campaigns/CampaignDetailDialog.vue';
import { io as socketIO, type Socket } from 'socket.io-client';

const router = useRouter();
const authStore = useAuthStore();

// Members shouldn't be here
if (!authStore.isAdmin) {
  router.replace('/');
}

const { campaigns, loading, error, fetchCampaigns, transition, deleteCampaign } = useCampaigns();

const filterStatus = ref<CampaignStatus | null>(null);
const createDialogOpen = ref(false);
const detailDialogOpen = ref(false);
const deleteDialogOpen = ref(false);
const selectedCampaign = ref<Campaign | null>(null);
const deleteTarget = ref<Campaign | null>(null);
const toast = ref({ show: false, text: '', color: 'success' });

const STATUS_FILTER_OPTIONS = [
  { title: 'Tất cả', value: null },
  ...(Object.keys(STATUS_LABELS) as CampaignStatus[]).map((s) => ({
    title: STATUS_LABELS[s],
    value: s,
  })),
];

const headers = [
  { title: 'Tên', key: 'name' },
  { title: 'Zalo', key: 'zaloAccount' },
  { title: 'Trạng thái', key: 'status', sortable: true },
  { title: 'Tiến độ', key: 'progress', sortable: false },
  { title: 'Tạo lúc', key: 'createdAt', sortable: true },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const, width: 200 },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

function openCreateDialog() {
  createDialogOpen.value = true;
}

function openDetail(campaign: Campaign) {
  selectedCampaign.value = campaign;
  detailDialogOpen.value = true;
}

async function runAction(campaign: Campaign, action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry-failed') {
  const result = await transition(campaign.id, action);
  if (result.ok) {
    toast.value = { show: true, text: 'Đã thực hiện', color: 'success' };
    await reload();
  } else {
    toast.value = { show: true, text: result.error, color: 'error' };
  }
}

function confirmDelete(campaign: Campaign) {
  deleteTarget.value = campaign;
  deleteDialogOpen.value = true;
}

async function runDelete() {
  if (!deleteTarget.value) return;
  const result = await deleteCampaign(deleteTarget.value.id);
  if (result.ok) {
    toast.value = { show: true, text: 'Đã xoá', color: 'success' };
    deleteDialogOpen.value = false;
  } else {
    toast.value = { show: true, text: result.error ?? 'Xoá thất bại', color: 'error' };
  }
}

async function onCreated() {
  toast.value = { show: true, text: 'Đã tạo chiến dịch (Nháp)', color: 'success' };
  await reload();
}

async function reload() {
  await fetchCampaigns(filterStatus.value ?? undefined);
}

// Socket.IO subscriptions for live updates
let socket: Socket | null = null;
onMounted(async () => {
  await reload();
  socket = socketIO({ transports: ['websocket', 'polling'] });
  socket.on('campaign:status', () => reload());
  socket.on('campaign:progress', (data: { campaignId: string; sentCount: number; failedCount: number; skippedCount: number; totalTargets: number }) => {
    const c = campaigns.value.find((c) => c.id === data.campaignId);
    if (c) {
      c.sentCount = data.sentCount;
      c.failedCount = data.failedCount;
      c.skippedCount = data.skippedCount;
    }
  });
});
onUnmounted(() => {
  socket?.disconnect();
});
</script>
