<template>
  <div>
    <h1 class="text-h4 mb-4">Hoạt động hệ thống</h1>

    <v-card class="pa-3 mb-3">
      <div class="d-flex flex-wrap" style="gap: 12px;">
        <v-select
          v-model="filters.entityType"
          :items="ENTITY_TYPE_OPTIONS"
          item-title="title" item-value="value"
          label="Loại đối tượng"
          density="compact" variant="outlined" hide-details clearable
          style="min-width: 180px;"
        />
        <v-text-field
          v-model="filters.action"
          label="Action code"
          density="compact" variant="outlined" hide-details
          placeholder="VD: campaign.cancelled"
          style="min-width: 200px;"
        />
        <v-text-field
          v-model="filters.from"
          label="Từ ngày" type="date"
          density="compact" variant="outlined" hide-details
          style="min-width: 160px;"
        />
        <v-text-field
          v-model="filters.to"
          label="Đến ngày" type="date"
          density="compact" variant="outlined" hide-details
          style="min-width: 160px;"
        />
        <v-btn color="primary" :loading="loading" @click="reload(1)" prepend-icon="mdi-filter">
          Lọc
        </v-btn>
      </div>
    </v-card>

    <v-alert v-if="error" type="error" density="compact" closable class="mb-3" @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card>
      <div class="d-flex align-center pa-3 text-body-2 text-grey">
        <span v-if="total > 0">
          Tìm thấy <strong>{{ total }}</strong> hoạt động
          {{ totalPages > 1 ? `— trang ${page}/${totalPages}` : '' }}
        </span>
        <span v-else-if="!loading">Không có hoạt động nào</span>
        <v-spacer />
        <v-btn
          v-if="totalPages > 1"
          icon size="small" variant="text"
          :disabled="page <= 1 || loading"
          @click="reload(page - 1)"
        ><v-icon>mdi-chevron-left</v-icon></v-btn>
        <v-btn
          v-if="totalPages > 1"
          icon size="small" variant="text"
          :disabled="page >= totalPages || loading"
          @click="reload(page + 1)"
        ><v-icon>mdi-chevron-right</v-icon></v-btn>
      </div>

      <v-divider />

      <v-list density="comfortable">
        <v-list-item v-for="row in activities" :key="row.id" class="activity-row">
          <template #prepend>
            <v-avatar size="32" :color="row.user ? 'primary' : 'grey'">
              <v-icon size="16" color="white">
                {{ row.user ? 'mdi-account' : 'mdi-robot' }}
              </v-icon>
            </v-avatar>
          </template>

          <v-list-item-title class="d-flex align-center">
            <span class="font-weight-medium">
              {{ row.user?.fullName || 'Hệ thống' }}
            </span>
            <v-chip
              size="x-small" variant="tonal" color="primary" class="ml-2"
            >{{ ACTION_LABELS[row.action] || row.action }}</v-chip>
            <v-spacer />
            <span class="text-caption text-grey">{{ formatDate(row.createdAt) }}</span>
          </v-list-item-title>

          <v-list-item-subtitle v-if="hasDetails(row)" class="mt-1">
            <v-btn
              size="x-small" variant="text"
              :prepend-icon="expanded[row.id] ? 'mdi-chevron-down' : 'mdi-chevron-right'"
              @click="toggle(row.id)"
            >Chi tiết</v-btn>
            <pre v-if="expanded[row.id]" class="details-json">{{ formatDetails(row.details) }}</pre>
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
  useActivity,
  ACTION_LABELS,
  ENTITY_TYPE_OPTIONS,
  type ActivityRow,
} from '@/composables/use-activity';

const router = useRouter();
const authStore = useAuthStore();

// Members shouldn't be here (route still works for them but only shows their own
// activity — we redirect anyway for clarity)
if (!authStore.isAdmin) {
  router.replace('/');
}

const { activities, total, page, totalPages, loading, error, fetchActivity } = useActivity();

const filters = ref<{
  entityType: string;
  action: string;
  from: string;
  to: string;
}>({ entityType: '', action: '', from: '', to: '' });

const expanded = ref<Record<string, boolean>>({});

function toggle(id: string) {
  expanded.value[id] = !expanded.value[id];
}

function hasDetails(row: ActivityRow): boolean {
  return row.details && Object.keys(row.details).length > 0;
}

function formatDetails(details: Record<string, unknown>): string {
  return JSON.stringify(details, null, 2);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

async function reload(targetPage: number) {
  await fetchActivity({
    entityType: filters.value.entityType || undefined,
    action: filters.value.action || undefined,
    from: filters.value.from ? new Date(filters.value.from).toISOString() : undefined,
    to: filters.value.to ? new Date(filters.value.to + 'T23:59:59').toISOString() : undefined,
    page: targetPage,
    limit: 50,
  });
}

onMounted(() => reload(1));
</script>

<style scoped>
.activity-row {
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
.details-json {
  background: rgba(0, 0, 0, 0.04);
  padding: 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-top: 4px;
  overflow-x: auto;
  max-width: 100%;
}
</style>
