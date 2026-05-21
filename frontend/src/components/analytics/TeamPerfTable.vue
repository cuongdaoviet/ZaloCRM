<template>
  <v-card>
    <v-card-title class="d-flex align-center text-body-1">
      <v-icon class="mr-2" color="primary">mdi-account-tie</v-icon>
      Hiệu suất nhân viên
      <v-spacer />
      <span v-if="data" class="text-caption text-grey">
        {{ data.totals.outboundMessageCount }} tin · {{ data.totals.convertedContactsCount }} chuyển đổi
      </span>
    </v-card-title>
    <v-data-table
      :headers="headers"
      :items="rows"
      :loading="loading"
      no-data-text="Không có nhân viên nào trong khoảng này"
      density="compact"
      hide-default-footer
      items-per-page="-1"
    >
      <template #item.avgResponseTimeMinutes="{ item }">
        <span :class="responseClass(item.avgResponseTimeMinutes)">
          {{ formatMinutes(item.avgResponseTimeMinutes) }}
        </span>
      </template>
      <template #item.outboundMessageCount="{ item }">
        {{ formatCount(item.outboundMessageCount) }}
      </template>
      <template #item.convertedContactsCount="{ item }">
        <span class="font-weight-medium">{{ formatCount(item.convertedContactsCount) }}</span>
      </template>
      <template #item.activeConversationsCount="{ item }">
        {{ formatCount(item.activeConversationsCount) }}
      </template>
    </v-data-table>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TeamPerfResponse, TeamPerfRow } from '@/composables/use-analytics';

interface Props {
  data: TeamPerfResponse | null;
  loading?: boolean;
}
const props = defineProps<Props>();

// Vuetify 4 data-table headers — `sortable` defaults to true for these keys
// so AC-0010 (sortable table) is satisfied via column-header click.
const headers = [
  { title: 'Nhân viên', key: 'fullName', sortable: true },
  { title: 'TG phản hồi TB (phút)', key: 'avgResponseTimeMinutes', sortable: true, align: 'end' as const },
  { title: 'Tin đã gửi', key: 'outboundMessageCount', sortable: true, align: 'end' as const },
  { title: 'KH chuyển đổi', key: 'convertedContactsCount', sortable: true, align: 'end' as const },
  { title: 'Hội thoại đang hoạt động', key: 'activeConversationsCount', sortable: true, align: 'end' as const },
];

const rows = computed<TeamPerfRow[]>(() => props.data?.byUser ?? []);

function formatCount(n: number): string {
  return n.toLocaleString('vi-VN');
}

function formatMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 1) return '< 1';
  return min.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
}

function responseClass(min: number | null): string {
  if (min === null) return 'text-grey';
  if (min <= 15) return 'text-success';
  if (min <= 60) return 'text-warning';
  return 'text-error';
}
</script>
