<template>
  <v-card class="mb-4">
    <v-card-title class="d-flex align-center">
      <v-icon class="mr-2">mdi-webhook</v-icon>
      Webhook delivery log
      <v-spacer />
      <v-btn
        size="small" variant="text" :loading="loading"
        prepend-icon="mdi-refresh"
        @click="reload(1)"
      >Làm mới</v-btn>
    </v-card-title>

    <v-card-text>
      <div class="d-flex align-center mb-3" style="gap: 12px;">
        <v-btn-toggle v-model="statusFilter" mandatory density="compact" color="primary">
          <v-btn value="all" size="small">Tất cả</v-btn>
          <v-btn value="success" size="small">Thành công</v-btn>
          <v-btn value="failed" size="small">Thất bại</v-btn>
        </v-btn-toggle>
        <span class="text-body-2 text-grey">
          <span v-if="total > 0">{{ total }} attempt</span>
          <span v-else-if="!loading">Chưa có attempt nào</span>
        </span>
      </div>

      <v-alert v-if="error" type="error" density="compact" closable class="mb-3" @click:close="error = ''">
        {{ error }}
      </v-alert>

      <v-data-table
        :headers="headers"
        :items="deliveries"
        :loading="loading"
        item-value="id"
        hide-default-footer
        density="compact"
      >
        <template #item.responseStatus="{ item }">
          <v-chip
            :color="statusColor(item.responseStatus, item.errorMessage)"
            size="x-small" variant="tonal"
          >
            {{ item.errorMessage ? 'ERR' : (item.responseStatus ?? '—') }}
          </v-chip>
        </template>
        <template #item.durationMs="{ item }">
          <span class="text-body-2">{{ item.durationMs != null ? `${item.durationMs}ms` : '—' }}</span>
        </template>
        <template #item.createdAt="{ item }">
          <span class="text-body-2">{{ formatDate(item.createdAt) }}</span>
        </template>
        <template #item.actions="{ item }">
          <v-btn icon size="x-small" variant="text" @click="openDetail(item.id)" title="Chi tiết">
            <v-icon size="16">mdi-eye</v-icon>
          </v-btn>
          <v-btn
            icon size="x-small" variant="text" color="primary"
            :loading="replayingId === item.id"
            @click="onReplay(item.id)" title="Replay"
          >
            <v-icon size="16">mdi-replay</v-icon>
          </v-btn>
        </template>
      </v-data-table>

      <div v-if="totalPages > 1" class="d-flex justify-end align-center mt-2">
        <v-btn icon size="small" variant="text" :disabled="page <= 1" @click="reload(page - 1)">
          <v-icon>mdi-chevron-left</v-icon>
        </v-btn>
        <span class="text-body-2 mx-2">{{ page }} / {{ totalPages }}</span>
        <v-btn icon size="small" variant="text" :disabled="page >= totalPages" @click="reload(page + 1)">
          <v-icon>mdi-chevron-right</v-icon>
        </v-btn>
      </div>
    </v-card-text>

    <!-- Detail dialog -->
    <v-dialog v-model="detailOpen" max-width="800">
      <v-card>
        <v-card-title>Webhook delivery detail</v-card-title>
        <v-card-text v-if="detail">
          <div class="text-body-2 mb-2">
            <strong>Event:</strong> {{ detail.event }}<br>
            <strong>URL:</strong> {{ detail.url }}<br>
            <strong>Status:</strong> {{ detail.responseStatus ?? '—' }}
              <span v-if="detail.errorMessage" class="text-error"> · {{ detail.errorMessage }}</span><br>
            <strong>Duration:</strong> {{ detail.durationMs != null ? `${detail.durationMs}ms` : '—' }}<br>
            <strong>Signature:</strong>
            <code style="font-size: 11px;">{{ detail.signature || '—' }}</code>
          </div>
          <div class="text-body-2"><strong>Payload:</strong></div>
          <pre class="payload-pre">{{ prettyJson(detail.payload) }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="detailOpen = false">Đóng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import {
  useWebhookDeliveries,
  statusColor,
  type DeliveryStatusFilter,
  type WebhookDeliveryDetail,
} from '@/composables/use-webhook-deliveries';

const emit = defineEmits<{ notify: [text: string, color?: string] }>();

const {
  deliveries, total, page, totalPages, loading, error,
  fetchDeliveries, fetchDetail, replay,
} = useWebhookDeliveries();

const statusFilter = ref<DeliveryStatusFilter>('all');
const detailOpen = ref(false);
const detail = ref<WebhookDeliveryDetail | null>(null);
const replayingId = ref('');

const headers = [
  { title: 'Event', key: 'event' },
  { title: 'Status', key: 'responseStatus', width: '80px' },
  { title: 'Duration', key: 'durationMs', width: '100px' },
  { title: 'Thời gian', key: 'createdAt' },
  { title: '', key: 'actions', sortable: false, width: '80px' },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

async function reload(targetPage: number) {
  await fetchDeliveries({ status: statusFilter.value, page: targetPage, limit: 50 });
}

async function openDetail(id: string) {
  detail.value = await fetchDetail(id);
  if (detail.value) detailOpen.value = true;
}

async function onReplay(id: string) {
  if (!confirm('Gửi lại webhook này?')) return;
  replayingId.value = id;
  const res = await replay(id);
  replayingId.value = '';
  if (res) {
    const ok = res.responseStatus && res.responseStatus >= 200 && res.responseStatus < 300;
    emit('notify', ok ? `Replay thành công (${res.responseStatus})` : `Replay thất bại (${res.responseStatus ?? 'lỗi'})`, ok ? 'success' : 'error');
    await reload(1);
  }
}

watch(statusFilter, () => reload(1));
onMounted(() => reload(1));
</script>

<style scoped>
.payload-pre {
  background: rgba(0, 0, 0, 0.04);
  padding: 8px;
  border-radius: 4px;
  font-size: 11px;
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
