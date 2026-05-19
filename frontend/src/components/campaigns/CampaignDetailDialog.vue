<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    max-width="900"
  >
    <v-card v-if="campaign">
      <v-card-title class="d-flex align-center">
        {{ campaign.name }}
        <v-chip :color="STATUS_COLORS[campaign.status]" size="small" variant="flat" class="ml-3">
          {{ STATUS_LABELS[campaign.status] }}
        </v-chip>
        <v-spacer />
        <v-btn icon variant="text" @click="$emit('update:modelValue', false)">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </v-card-title>

      <v-card-text>
        <!-- Progress -->
        <div class="mb-3">
          <v-progress-linear
            :model-value="progressPercent"
            color="primary"
            height="20"
            rounded
          >
            <strong>{{ campaign.sentCount }} / {{ campaign.totalTargets }}</strong>
          </v-progress-linear>
        </div>

        <v-row dense class="mb-3">
          <v-col cols="3">
            <v-card variant="outlined" class="pa-3 text-center">
              <div class="text-caption text-grey">Tổng</div>
              <div class="text-h5">{{ campaign.totalTargets }}</div>
            </v-card>
          </v-col>
          <v-col cols="3">
            <v-card variant="outlined" class="pa-3 text-center">
              <div class="text-caption text-success">Đã gửi</div>
              <div class="text-h5 text-success">{{ campaign.sentCount }}</div>
            </v-card>
          </v-col>
          <v-col cols="3">
            <v-card variant="outlined" class="pa-3 text-center">
              <div class="text-caption text-error">Lỗi</div>
              <div class="text-h5 text-error">{{ campaign.failedCount }}</div>
            </v-card>
          </v-col>
          <v-col cols="3">
            <v-card variant="outlined" class="pa-3 text-center">
              <div class="text-caption text-grey">Bỏ qua</div>
              <div class="text-h5">{{ campaign.skippedCount }}</div>
            </v-card>
          </v-col>
        </v-row>

        <!-- Meta -->
        <p class="text-body-2 text-grey mb-1">
          <strong>Tài khoản Zalo:</strong> {{ campaign.zaloAccount?.displayName || '—' }}<br>
          <strong>Người tạo:</strong> {{ campaign.createdBy?.fullName || '—' }}<br>
          <strong>Tạo lúc:</strong> {{ formatDate(campaign.createdAt) }}<br>
          <strong v-if="campaign.scheduledAt">Lên lịch:</strong>
          <span v-if="campaign.scheduledAt">{{ formatDate(campaign.scheduledAt) }}<br></span>
          <strong v-if="campaign.startedAt">Bắt đầu:</strong>
          <span v-if="campaign.startedAt">{{ formatDate(campaign.startedAt) }}<br></span>
          <strong v-if="campaign.completedAt">Kết thúc:</strong>
          <span v-if="campaign.completedAt">{{ formatDate(campaign.completedAt) }}</span>
        </p>

        <v-card variant="outlined" class="pa-3 mb-3">
          <p class="text-caption text-grey mb-1">Nội dung tin nhắn:</p>
          <p class="text-body-2" style="white-space: pre-wrap;">{{ campaign.message }}</p>
        </v-card>

        <!-- Targets table -->
        <v-card variant="outlined">
          <v-card-title class="d-flex align-center text-body-1">
            Khách hàng nhận tin
            <v-spacer />
            <v-btn-toggle
              v-model="targetFilter"
              mandatory density="compact" variant="outlined"
              @update:model-value="loadTargets(1)"
            >
              <v-btn value="all" size="small">Tất cả</v-btn>
              <v-btn value="sent" size="small" color="success">Đã gửi</v-btn>
              <v-btn value="failed" size="small" color="error">Lỗi</v-btn>
              <v-btn value="skipped" size="small">Bỏ qua</v-btn>
              <v-btn value="pending" size="small">Chờ</v-btn>
            </v-btn-toggle>
          </v-card-title>
          <v-data-table
            :headers="targetHeaders"
            :items="targets"
            :loading="loadingTargets"
            no-data-text="Không có target"
            density="compact"
            hide-default-footer
          >
            <template #item.contact="{ item }">
              <div class="d-flex align-center">
                <v-avatar size="28" color="grey-lighten-2" class="mr-2">
                  <v-img v-if="item.contact.avatarUrl" :src="item.contact.avatarUrl" />
                  <v-icon v-else size="16">mdi-account</v-icon>
                </v-avatar>
                <span>{{ item.contact.fullName || '—' }}</span>
              </div>
            </template>
            <template #item.status="{ item }">
              <v-chip :color="targetStatusColor(item.status)" size="x-small" variant="flat">
                {{ item.status }}
              </v-chip>
            </template>
            <template #item.sentAt="{ item }">
              {{ item.sentAt ? formatDate(item.sentAt) : '—' }}
            </template>
            <template #item.error="{ item }">
              <span v-if="item.errorMessage" class="text-error text-caption">{{ item.errorMessage }}</span>
            </template>
          </v-data-table>
          <div v-if="targetsTotal > targetsLimit" class="pa-2 d-flex align-center justify-end">
            <span class="text-caption text-grey mr-2">
              Trang {{ targetsPage }}/{{ targetsTotalPages }}
            </span>
            <v-btn icon size="small" variant="text" :disabled="targetsPage <= 1" @click="loadTargets(targetsPage - 1)">
              <v-icon>mdi-chevron-left</v-icon>
            </v-btn>
            <v-btn icon size="small" variant="text" :disabled="targetsPage >= targetsTotalPages" @click="loadTargets(targetsPage + 1)">
              <v-icon>mdi-chevron-right</v-icon>
            </v-btn>
          </div>
        </v-card>
      </v-card-text>

      <v-card-actions>
        <v-btn
          v-if="campaign.status === 'draft'"
          color="success" prepend-icon="mdi-play"
          @click="runAction('start')"
        >Bắt đầu</v-btn>
        <v-btn
          v-if="campaign.status === 'running'"
          color="warning" prepend-icon="mdi-pause"
          @click="runAction('pause')"
        >Tạm dừng</v-btn>
        <v-btn
          v-if="campaign.status === 'paused'"
          color="success" prepend-icon="mdi-play"
          @click="runAction('resume')"
        >Tiếp tục</v-btn>
        <v-btn
          v-if="campaign.failedCount > 0 && (campaign.status === 'completed' || campaign.status === 'paused')"
          color="warning" prepend-icon="mdi-replay"
          @click="runAction('retry-failed')"
        >Retry failed ({{ campaign.failedCount }})</v-btn>
        <v-spacer />
        <v-btn
          v-if="['running', 'paused', 'scheduled'].includes(campaign.status)"
          color="error" variant="text"
          @click="runAction('cancel')"
        >Huỷ chiến dịch</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { api } from '@/api/index';
import {
  STATUS_LABELS, STATUS_COLORS,
  useCampaigns,
  type Campaign, type CampaignTarget,
} from '@/composables/use-campaigns';

const props = defineProps<{ modelValue: boolean; campaignId: string }>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; action: [] }>();

const { transition } = useCampaigns();

const campaign = ref<Campaign | null>(null);
const targets = ref<CampaignTarget[]>([]);
const targetsTotal = ref(0);
const targetsPage = ref(1);
const targetsLimit = ref(50);
const targetsTotalPages = ref(0);
const targetFilter = ref<'all' | 'sent' | 'failed' | 'skipped' | 'pending'>('all');
const loadingTargets = ref(false);

const targetHeaders = [
  { title: 'Khách hàng', key: 'contact' },
  { title: 'Trạng thái', key: 'status' },
  { title: 'Gửi lúc', key: 'sentAt' },
  { title: 'Lỗi', key: 'error' },
];

const progressPercent = computed(() => {
  if (!campaign.value || campaign.value.totalTargets === 0) return 0;
  const done = campaign.value.sentCount + campaign.value.failedCount + campaign.value.skippedCount;
  return Math.round((done / campaign.value.totalTargets) * 100);
});

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

function targetStatusColor(s: string): string {
  return s === 'sent' ? 'success' : s === 'failed' ? 'error' : s === 'skipped' ? 'grey' : 'default';
}

async function fetchCampaign() {
  try {
    const res = await api.get(`/campaigns/${props.campaignId}`);
    campaign.value = res.data;
  } catch {
    campaign.value = null;
  }
}

async function loadTargets(page: number) {
  loadingTargets.value = true;
  try {
    const params: Record<string, string | number> = { page, limit: targetsLimit.value };
    if (targetFilter.value !== 'all') params.status = targetFilter.value;
    const res = await api.get(`/campaigns/${props.campaignId}/targets`, { params });
    targets.value = res.data.targets;
    targetsTotal.value = res.data.total;
    targetsTotalPages.value = res.data.totalPages;
    targetsPage.value = res.data.page;
  } finally {
    loadingTargets.value = false;
  }
}

async function runAction(action: 'start' | 'pause' | 'resume' | 'cancel' | 'retry-failed') {
  if (!campaign.value) return;
  await transition(campaign.value.id, action);
  emit('action');
  await fetchCampaign();
}

// Re-fetch when dialog opens for a new campaign
watch(
  () => [props.modelValue, props.campaignId],
  async ([open]) => {
    if (open && props.campaignId) {
      await fetchCampaign();
      await loadTargets(1);
    }
  },
);
</script>
