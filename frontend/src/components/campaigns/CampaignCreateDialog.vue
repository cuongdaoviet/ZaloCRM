<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    max-width="720"
    persistent
  >
    <v-card>
      <v-card-title>Tạo chiến dịch mới</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="form.name"
          label="Tên chiến dịch"
          density="compact" variant="outlined" hide-details="auto"
          maxlength="200" counter
          class="mb-3"
        />

        <v-select
          v-model="form.zaloAccountId"
          :items="zaloOptions"
          item-title="title" item-value="value"
          label="Gửi từ tài khoản Zalo"
          density="compact" variant="outlined" hide-details="auto"
          class="mb-3"
        />

        <v-textarea
          v-model="form.message"
          label="Nội dung tin nhắn"
          auto-grow rows="3" maxlength="2000" counter
          density="compact" variant="outlined" hide-details="auto"
          class="mb-1"
        />
        <p class="text-caption text-grey mb-3">
          💡 Placeholder: <code v-pre>{{contactName}}</code>, <code v-pre>{{firstName}}</code>
        </p>

        <v-divider class="mb-3" />
        <p class="text-body-2 font-weight-medium mb-2">Lọc khách hàng nhận tin</p>

        <v-select
          v-model="form.filter.status"
          :items="STATUS_OPTIONS"
          item-title="title" item-value="value"
          label="Trạng thái pipeline"
          multiple chips closable-chips
          density="compact" variant="outlined" hide-details
          class="mb-2"
        />

        <v-combobox
          v-model="form.filter.source"
          label="Nguồn (gõ + Enter để thêm)"
          multiple chips closable-chips
          density="compact" variant="outlined" hide-details
          class="mb-2"
        />

        <v-combobox
          v-model="form.filter.tags"
          label="Tags (gõ + Enter để thêm)"
          multiple chips closable-chips
          density="compact" variant="outlined" hide-details
          class="mb-3"
        />

        <v-divider class="mb-3" />

        <v-radio-group v-model="scheduleMode" inline density="compact" hide-details class="mb-2">
          <v-radio label="Gửi ngay khi bấm Bắt đầu" value="now" />
          <v-radio label="Lên lịch" value="scheduled" />
        </v-radio-group>

        <v-text-field
          v-if="scheduleMode === 'scheduled'"
          v-model="scheduledAtLocal"
          label="Thời điểm gửi"
          type="datetime-local"
          density="compact" variant="outlined" hide-details
          class="mb-2"
        />

        <v-alert v-if="error" type="error" density="compact" class="mt-2" closable @click:close="error = ''">
          {{ error }}
        </v-alert>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn @click="$emit('update:modelValue', false)" :disabled="saving">Hủy</v-btn>
        <v-btn
          color="primary" :loading="saving"
          :disabled="!isValid"
          @click="onSubmit"
        >Tạo (Nháp)</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '@/api/index';
import { useCampaigns, type CampaignInput } from '@/composables/use-campaigns';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; created: [] }>();

const { createCampaign } = useCampaigns();

const STATUS_OPTIONS = [
  { title: 'Mới', value: 'new' },
  { title: 'Đã liên hệ', value: 'contacted' },
  { title: 'Quan tâm', value: 'interested' },
  { title: 'Chuyển đổi', value: 'converted' },
  { title: 'Mất', value: 'lost' },
];

const form = ref<CampaignInput>({
  name: '',
  zaloAccountId: '',
  message: '',
  filter: { status: [], source: [], tags: [] },
  scheduledAt: null,
});
const zaloOptions = ref<{ title: string; value: string }[]>([]);
const scheduleMode = ref<'now' | 'scheduled'>('now');
const scheduledAtLocal = ref('');
const saving = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    const res = await api.get('/zalo-accounts');
    const list = Array.isArray(res.data) ? res.data : res.data.accounts || [];
    zaloOptions.value = list
      .filter((a: any) => a.liveStatus === 'connected' || a.status === 'connected')
      .map((a: any) => ({ title: a.displayName || a.zaloUid || a.id, value: a.id }));
  } catch (err: any) {
    error.value = 'Không tải được danh sách Zalo: ' + (err.response?.data?.error || err.message);
  }
});

const isValid = computed(() => {
  const f = form.value;
  const hasFilter =
    (f.filter.status?.length ?? 0) > 0 ||
    (f.filter.source?.length ?? 0) > 0 ||
    (f.filter.tags?.length ?? 0) > 0;
  return (
    f.name.trim().length > 0 &&
    f.zaloAccountId &&
    f.message.trim().length > 0 &&
    hasFilter &&
    (scheduleMode.value === 'now' || scheduledAtLocal.value !== '')
  );
});

async function onSubmit() {
  saving.value = true;
  error.value = '';

  // Strip empty arrays so backend doesn't reject empty filter
  const cleanFilter: typeof form.value.filter = {};
  if ((form.value.filter.status?.length ?? 0) > 0) cleanFilter.status = form.value.filter.status;
  if ((form.value.filter.source?.length ?? 0) > 0) cleanFilter.source = form.value.filter.source;
  if ((form.value.filter.tags?.length ?? 0) > 0) cleanFilter.tags = form.value.filter.tags;

  const payload: CampaignInput = {
    ...form.value,
    filter: cleanFilter,
    scheduledAt:
      scheduleMode.value === 'scheduled' && scheduledAtLocal.value
        ? new Date(scheduledAtLocal.value).toISOString()
        : null,
  };

  const result = await createCampaign(payload);
  saving.value = false;
  if (result.ok) {
    emit('created');
    emit('update:modelValue', false);
    resetForm();
  } else {
    error.value = result.error;
  }
}

function resetForm() {
  form.value = {
    name: '',
    zaloAccountId: '',
    message: '',
    filter: { status: [], source: [], tags: [] },
    scheduledAt: null,
  };
  scheduleMode.value = 'now';
  scheduledAtLocal.value = '';
}

// Reset when dialog closes
watch(
  () => props.modelValue,
  (v) => {
    if (!v) {
      error.value = '';
    }
  },
);
</script>
