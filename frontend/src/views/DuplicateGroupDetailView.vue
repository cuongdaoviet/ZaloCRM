<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px;">
      <v-btn icon variant="text" @click="router.back()">
        <v-icon>mdi-arrow-left</v-icon>
      </v-btn>
      <h1 class="text-h5">Chi tiết nhóm trùng</h1>
      <v-spacer />
      <v-chip
        v-if="group"
        size="small"
        variant="tonal"
        :color="statusColor(group.status)"
      >{{ STATUS_LABELS[group.status] }}</v-chip>
    </div>

    <v-alert
      v-if="error"
      type="error"
      density="compact"
      closable
      class="mb-3"
      @click:close="error = ''"
    >{{ error }}</v-alert>

    <v-alert
      v-if="successMessage"
      type="success"
      density="compact"
      closable
      class="mb-3"
      @click:close="successMessage = ''"
    >{{ successMessage }}</v-alert>

    <v-progress-linear v-if="loading" indeterminate />

    <template v-if="group && !loading">
      <v-card class="pa-3 mb-4">
        <div class="d-flex flex-wrap align-center" style="gap: 12px;">
          <div>
            <div class="text-body-1 font-weight-medium">
              {{ LEVEL_LABELS[group.level] }}
            </div>
            <div class="text-caption text-grey">
              Phát hiện: {{ formatDate(group.detectedAt) }} ·
              Confidence: {{ (group.confidence * 100).toFixed(0) }}%
            </div>
          </div>
          <v-spacer />
          <template v-if="group.status === 'pending' && group.contacts.length >= 2">
            <v-btn
              color="grey"
              variant="outlined"
              prepend-icon="mdi-close-circle-outline"
              :loading="dismissing"
              @click="onDismiss"
            >Bỏ qua</v-btn>
            <v-btn
              color="primary"
              prepend-icon="mdi-call-merge"
              :disabled="!primaryId"
              :loading="merging"
              @click="onMerge"
            >Gộp về primary</v-btn>
          </template>
        </div>
      </v-card>

      <v-alert
        v-if="group.status !== 'pending'"
        type="info"
        density="compact"
        class="mb-3"
      >
        Nhóm này đã được xử lý ({{ STATUS_LABELS[group.status] }}).
        <span v-if="group.resolvedBy">— bởi {{ group.resolvedBy.fullName }}</span>
      </v-alert>

      <v-row v-if="group.status === 'pending'">
        <v-col cols="12">
          <v-card class="pa-3 mb-3">
            <div class="text-body-1 font-weight-medium mb-2">Chọn contact giữ lại (primary)</div>
            <v-radio-group v-model="primaryId" hide-details>
              <v-radio
                v-for="c in group.contacts"
                :key="c.id"
                :label="contactLabel(c)"
                :value="c.id"
              />
            </v-radio-group>
          </v-card>
        </v-col>
      </v-row>

      <v-row>
        <v-col
          v-for="c in group.contacts"
          :key="c.id"
          cols="12"
          :md="group.contacts.length === 2 ? 6 : 12 / Math.min(group.contacts.length, 3)"
        >
          <v-card class="pa-4" :class="{ 'primary-card': c.id === primaryId }">
            <div class="d-flex align-center mb-2">
              <div class="text-body-1 font-weight-medium">
                {{ c.fullName || '(không tên)' }}
              </div>
              <v-spacer />
              <v-chip
                v-if="c.id === primaryId"
                size="x-small"
                color="primary"
                variant="tonal"
              >Primary</v-chip>
            </div>
            <div class="text-caption text-grey mb-3">
              Tạo: {{ formatDate(c.createdAt) }}
            </div>

            <v-list density="compact" class="bg-transparent">
              <v-list-item>
                <template #prepend><v-icon size="16">mdi-phone</v-icon></template>
                <v-list-item-title>{{ c.phone || '—' }}</v-list-item-title>
              </v-list-item>
              <v-list-item>
                <template #prepend><v-icon size="16">mdi-email</v-icon></template>
                <v-list-item-title>{{ c.email || '—' }}</v-list-item-title>
              </v-list-item>
              <v-list-item>
                <template #prepend><v-icon size="16">mdi-source-branch</v-icon></template>
                <v-list-item-title>{{ c.source || '—' }}</v-list-item-title>
              </v-list-item>
              <v-list-item>
                <template #prepend><v-icon size="16">mdi-account-tag</v-icon></template>
                <v-list-item-title>
                  <v-chip
                    v-for="tag in c.tags"
                    :key="tag"
                    size="x-small"
                    variant="tonal"
                    class="mr-1"
                  >{{ tag }}</v-chip>
                  <span v-if="!c.tags || c.tags.length === 0" class="text-grey">—</span>
                </v-list-item-title>
              </v-list-item>
              <v-list-item>
                <template #prepend><v-icon size="16">mdi-account-circle</v-icon></template>
                <v-list-item-title>
                  {{ c.assignedUser?.fullName || 'Chưa gán' }}
                </v-list-item-title>
              </v-list-item>
            </v-list>

            <v-divider class="my-3" />

            <div class="text-caption text-grey mb-1">Số liệu</div>
            <div class="d-flex flex-wrap" style="gap: 8px;">
              <v-chip size="x-small" variant="tonal">
                {{ c.stats.conversations }} hội thoại
              </v-chip>
              <v-chip size="x-small" variant="tonal">
                {{ c.stats.orders }} đơn
              </v-chip>
              <v-chip size="x-small" variant="tonal">
                {{ c.stats.appointments }} lịch hẹn
              </v-chip>
              <v-chip size="x-small" variant="tonal">
                {{ c.stats.notes }} ghi chú
              </v-chip>
            </div>
          </v-card>
        </v-col>
      </v-row>

      <v-card v-if="group.status === 'pending' && primaryId" class="pa-3 mt-4">
        <div class="text-body-1 font-weight-medium mb-2">
          Ghi đè trường vào primary (tuỳ chọn)
        </div>
        <div class="text-caption text-grey mb-3">
          Mặc định primary giữ field của chính nó. Chọn contact nguồn cho từng field bên dưới để override.
        </div>
        <v-row>
          <v-col
            v-for="field in OVERRIDE_FIELDS"
            :key="field.value"
            cols="12"
            md="6"
          >
            <v-select
              v-model="fieldsToKeep[field.value]"
              :items="overrideItems"
              item-title="title"
              item-value="value"
              :label="field.title"
              density="compact"
              variant="outlined"
              hide-details
              clearable
            />
          </v-col>
        </v-row>
      </v-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import {
  useDuplicateGroups,
  LEVEL_LABELS,
  STATUS_LABELS,
  type DuplicateGroupDetail,
  type DuplicateContactDetail,
  type GroupStatus,
} from '@/composables/use-duplicate-groups';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

if (!authStore.isAdmin) {
  router.replace('/');
}

const { loading, error, fetchDetail, merge, dismiss } = useDuplicateGroups();

const group = ref<DuplicateGroupDetail | null>(null);
const primaryId = ref<string | null>(null);
const fieldsToKeep = ref<Record<string, string | null>>({});
const merging = ref(false);
const dismissing = ref(false);
const successMessage = ref('');

const OVERRIDE_FIELDS = [
  { title: 'Họ tên', value: 'fullName' },
  { title: 'Số điện thoại', value: 'phone' },
  { title: 'Email', value: 'email' },
  { title: 'Nguồn', value: 'source' },
  { title: 'Người phụ trách', value: 'assignedUserId' },
];

const overrideItems = computed(() => {
  if (!group.value) return [];
  return group.value.contacts.map((c) => ({
    title: `${c.fullName || '(không tên)'} — ${c.phone || '—'}`,
    value: c.id,
  }));
});

function statusColor(status: GroupStatus): string {
  if (status === 'pending') return 'warning';
  if (status === 'merged') return 'success';
  return 'grey';
}

function contactLabel(c: DuplicateContactDetail): string {
  const parts: string[] = [];
  parts.push(c.fullName || '(không tên)');
  if (c.phone) parts.push(c.phone);
  parts.push(`${c.stats.orders} đơn`);
  parts.push(`${c.stats.conversations} hội thoại`);
  return parts.join(' · ');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

async function load() {
  const groupId = route.params.id as string;
  const detail = await fetchDetail(groupId);
  if (!detail) return;
  group.value = detail;
  // Suggest primary = contact with most orders (UX nicety)
  if (!primaryId.value && detail.contacts.length > 0) {
    const sorted = [...detail.contacts].sort(
      (a, b) => b.stats.orders - a.stats.orders,
    );
    primaryId.value = sorted[0].id;
  }
}

async function onMerge() {
  if (!group.value || !primaryId.value) return;
  if (!confirm('Bạn chắc chắn muốn gộp các contact? Thao tác KHÔNG thể hoàn tác.')) {
    return;
  }
  merging.value = true;
  try {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(fieldsToKeep.value)) {
      if (v) cleaned[k] = v;
    }
    const r = await merge(group.value.id, primaryId.value, cleaned);
    if (r) {
      successMessage.value = `Đã gộp ${r.mergedContactIds.length} contact vào primary.`;
      await load();
    }
  } finally {
    merging.value = false;
  }
}

async function onDismiss() {
  if (!group.value) return;
  if (!confirm('Bỏ qua nhóm này? Hệ thống sẽ không hiện lại các contact đó.')) {
    return;
  }
  dismissing.value = true;
  try {
    const ok = await dismiss(group.value.id);
    if (ok) {
      successMessage.value = 'Đã bỏ qua nhóm.';
      await load();
    }
  } finally {
    dismissing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.primary-card {
  border: 2px solid rgb(var(--v-theme-primary));
}
</style>
