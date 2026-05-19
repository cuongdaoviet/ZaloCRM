<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">KPI &amp; Leaderboard</h1>
      <v-spacer />
      <v-select
        v-model="period"
        :items="PERIOD_OPTIONS"
        item-title="title" item-value="value"
        density="compact" variant="outlined" hide-details
        style="width: 200px;"
        @update:model-value="reload"
      />
      <template v-if="period === 'custom'">
        <v-text-field
          v-model="customFrom" type="date" label="Từ"
          density="compact" variant="outlined" hide-details
          style="width: 160px;" class="ml-2"
        />
        <v-text-field
          v-model="customTo" type="date" label="Đến"
          density="compact" variant="outlined" hide-details
          style="width: 160px;" class="ml-2"
        />
        <v-btn color="primary" class="ml-2" @click="reload">Áp dụng</v-btn>
      </template>
      <v-btn icon variant="text" class="ml-2" :loading="loading" @click="reload" title="Tải lại">
        <v-icon>mdi-refresh</v-icon>
      </v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" closable class="mb-3" @click:close="error = ''">
      {{ error }}
    </v-alert>

    <p v-if="summary" class="text-caption text-grey mb-3">
      Khoảng: <strong>{{ summary.range.label }}</strong> ({{ formatDate(summary.range.from) }} → {{ formatDate(summary.range.to) }})
    </p>

    <!-- KPI cards -->
    <v-row v-if="summary" dense>
      <v-col v-for="card in cards" :key="card.key" cols="12" sm="6" md="4">
        <v-card class="pa-4 kpi-card">
          <div class="text-caption text-grey">{{ card.label }}</div>
          <div class="text-h4 font-weight-bold my-1">{{ card.formatted }}</div>
          <div class="d-flex align-center text-caption">
            <v-icon
              size="14"
              :color="deltaColor(card.delta)"
              class="mr-1"
            >
              {{ deltaIcon(card.delta) }}
            </v-icon>
            <span :class="`text-${deltaColor(card.delta)}`">
              {{ formatDelta(card.delta) }}
            </span>
            <span class="text-grey ml-2">so với kỳ trước</span>
          </div>
        </v-card>
      </v-col>
    </v-row>

    <!-- Leaderboard -->
    <v-card class="mt-6">
      <v-card-title class="d-flex align-center">
        <span>Leaderboard</span>
        <v-spacer />
        <v-btn-toggle
          v-model="leaderboardMetric"
          mandatory density="compact" variant="outlined" color="primary"
          @update:model-value="reloadLeaderboard"
        >
          <v-btn value="revenue" size="small">Doanh thu</v-btn>
          <v-btn value="ordersCount" size="small">Số đơn</v-btn>
          <v-btn value="messagesSent" size="small">Tin gửi</v-btn>
          <v-btn value="newContacts" size="small">KH mới</v-btn>
        </v-btn-toggle>
      </v-card-title>
      <v-data-table
        :headers="leaderboardHeaders"
        :items="leaderboardRows"
        :loading="loading"
        no-data-text="Không có dữ liệu cho khoảng này"
        density="compact"
        hide-default-footer
      >
        <template #item.rank="{ item }">
          <span class="font-weight-bold">#{{ item.rank }}</span>
        </template>
        <template #item.value="{ item }">
          <span class="font-weight-medium">{{ formatLeaderboardValue(item.value) }}</span>
        </template>
      </v-data-table>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import {
  useKpi,
  formatVND,
  formatCount,
  type Period,
  type LeaderboardMetric,
  type MetricCell,
} from '@/composables/use-kpi';

const router = useRouter();
const authStore = useAuthStore();

// Guard: members shouldn't be on this page
if (!authStore.isAdmin) {
  router.replace('/');
}

const PERIOD_OPTIONS = [
  { title: 'Hôm nay', value: 'today' as const },
  { title: 'Hôm qua', value: 'yesterday' as const },
  { title: '7 ngày qua', value: 'last7days' as const },
  { title: '30 ngày qua', value: 'last30days' as const },
  { title: 'Tháng này', value: 'thisMonth' as const },
  { title: 'Tháng trước', value: 'lastMonth' as const },
  { title: 'Tuỳ chọn…', value: 'custom' as const },
];

const period = ref<Period>('last7days');
const customFrom = ref('');
const customTo = ref('');
const leaderboardMetric = ref<LeaderboardMetric>('revenue');

const { summary, leaderboard, loading, error, fetchSummary, fetchLeaderboard } = useKpi();
const leaderboardRows = computed(() => leaderboard.value);

const leaderboardHeaders = [
  { title: 'Hạng', key: 'rank', width: 60 },
  { title: 'Nhân viên', key: 'fullName' },
  { title: 'Email', key: 'email' },
  { title: 'Giá trị', key: 'value', align: 'end' as const },
];

const cards = computed(() => {
  if (!summary.value) return [];
  const s = summary.value.summary;
  return [
    { key: 'revenue', label: 'Doanh thu', ...cellFor(s.revenue, formatVND) },
    { key: 'orders', label: 'Số đơn (đã hoàn tất+)', ...cellFor(s.ordersCount, formatCount) },
    { key: 'newContacts', label: 'Khách hàng mới', ...cellFor(s.newContacts, formatCount) },
    { key: 'converted', label: 'Khách chuyển đổi', ...cellFor(s.convertedContacts, formatCount) },
    { key: 'msgSent', label: 'Tin nhắn đã gửi', ...cellFor(s.messagesSent, formatCount) },
    { key: 'msgRecv', label: 'Tin nhắn nhận', ...cellFor(s.messagesReceived, formatCount) },
  ];
});

function cellFor(cell: MetricCell, fmt: (n: number) => string) {
  return {
    formatted: fmt(cell.current),
    delta: cell.delta,
  };
}

function deltaColor(delta: number | null): string {
  if (delta === null) return 'grey';
  if (delta > 0) return 'success';
  if (delta < 0) return 'error';
  return 'grey';
}
function deltaIcon(delta: number | null): string {
  if (delta === null) return 'mdi-minus';
  if (delta > 0) return 'mdi-arrow-up';
  if (delta < 0) return 'mdi-arrow-down';
  return 'mdi-minus';
}
function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}%`;
}

function formatLeaderboardValue(value: number): string {
  return leaderboardMetric.value === 'revenue' ? formatVND(value) : formatCount(value);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('vi-VN');
}

async function reload() {
  if (period.value === 'custom' && (!customFrom.value || !customTo.value)) return;
  await Promise.all([
    fetchSummary({ period: period.value, from: customFrom.value, to: customTo.value }),
    fetchLeaderboard(
      { period: period.value, from: customFrom.value, to: customTo.value },
      leaderboardMetric.value,
    ),
  ]);
}

async function reloadLeaderboard() {
  await fetchLeaderboard(
    { period: period.value, from: customFrom.value, to: customTo.value },
    leaderboardMetric.value,
  );
}

onMounted(() => reload());
</script>

<style scoped>
.kpi-card {
  border-left: 3px solid rgba(0, 242, 255, 0.4);
}
</style>
