<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    max-width="640"
  >
    <v-card>
      <v-card-title>
        Auto-reply ngoài giờ làm việc
        <div class="text-caption text-grey font-weight-regular">{{ accountName }}</div>
      </v-card-title>

      <v-card-text>
        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />

        <v-switch
          v-model="form.enabled"
          label="Bật auto-reply"
          color="success" hide-details density="compact"
          class="mb-3"
        />

        <p class="text-caption text-grey mb-1">Ngày làm việc (trong giờ làm KHÔNG auto-reply)</p>
        <div class="d-flex flex-wrap mb-3" style="gap: 6px;">
          <v-chip
            v-for="(label, idx) in DAY_LABELS"
            :key="idx"
            :color="isDayWorking(idx) ? 'primary' : undefined"
            :variant="isDayWorking(idx) ? 'flat' : 'outlined'"
            size="small"
            @click="toggleDay(idx)"
          >{{ label }}</v-chip>
        </div>

        <div class="d-flex" style="gap: 12px;">
          <v-text-field
            v-model="startTime"
            label="Giờ bắt đầu"
            type="time"
            density="compact" variant="outlined" hide-details
            class="flex-grow-1"
          />
          <v-text-field
            v-model="endTime"
            label="Giờ kết thúc"
            type="time"
            density="compact" variant="outlined" hide-details
            class="flex-grow-1"
          />
        </div>
        <p class="text-caption text-grey mt-1 mb-3">
          Tin nhắn đến NGOÀI khung này (hoặc ngoài các ngày đã chọn) sẽ được auto-reply.
        </p>

        <v-select
          v-model="form.timezone"
          :items="TIMEZONES"
          label="Múi giờ"
          density="compact" variant="outlined" hide-details
          class="mb-3"
        />

        <v-textarea
          v-model="form.message"
          label="Nội dung auto-reply"
          auto-grow rows="3" maxlength="1000" counter="1000"
          density="compact" variant="outlined" hide-details="auto"
          placeholder="VD: Em đã nhận tin, sẽ phản hồi vào giờ làm việc."
          class="mb-1"
        />
        <p class="text-caption text-grey mb-3">
          Placeholder: <code v-pre>{{contactName}}</code>, <code v-pre>{{firstName}}</code>.
        </p>

        <v-text-field
          v-model.number="form.cooldownMinutes"
          label="Cooldown (phút) — không gửi lại cho cùng khách trong khoảng này"
          type="number" min="1" max="10080"
          density="compact" variant="outlined" hide-details
          class="mb-2"
        />

        <v-alert v-if="error" type="error" density="compact" class="mt-3" closable @click:close="error = ''">
          {{ error }}
        </v-alert>
        <p v-if="rule?.lastTriggeredAt" class="text-caption text-grey mt-2">
          Lần kích hoạt gần nhất: {{ formatDate(rule.lastTriggeredAt) }}
        </p>
      </v-card-text>

      <v-card-actions>
        <v-btn
          v-if="rule" color="error" variant="text" size="small"
          :loading="deleting"
          @click="confirmDelete"
        >Xoá rule</v-btn>
        <v-spacer />
        <v-btn @click="$emit('update:modelValue', false)">Đóng</v-btn>
        <v-btn
          color="primary" :loading="saving"
          :disabled="!formValid"
          @click="onSave"
        >Lưu</v-btn>
      </v-card-actions>
    </v-card>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="3000">{{ toast.text }}</v-snackbar>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  useAutoReply,
  timeStringToMinutes,
  minutesToTimeString,
  type AutoReplyInput,
} from '@/composables/use-auto-reply';

const props = defineProps<{
  modelValue: boolean;
  accountId: string;
  accountName: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();

const DAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const TIMEZONES = [
  { value: 'Asia/Ho_Chi_Minh', title: 'Việt Nam (UTC+7)' },
  { value: 'Asia/Bangkok', title: 'Bangkok (UTC+7)' },
  { value: 'Asia/Singapore', title: 'Singapore (UTC+8)' },
  { value: 'UTC', title: 'UTC' },
];

const { rule, loading, error, fetchRule, saveRule, deleteRule } = useAutoReply();
const saving = ref(false);
const deleting = ref(false);
const toast = ref({ show: false, text: '', color: 'success' });

const form = ref<AutoReplyInput>({
  enabled: true,
  daysOfWeek: 62, // Mon-Fri
  startMinute: 480,
  endMinute: 1080,
  timezone: 'Asia/Ho_Chi_Minh',
  message: '',
  cooldownMinutes: 240,
});

const startTime = ref('08:00');
const endTime = ref('18:00');

const formValid = computed(() => {
  const start = timeStringToMinutes(startTime.value);
  const end = timeStringToMinutes(endTime.value);
  return (
    start < end &&
    form.value.message.trim().length > 0 &&
    form.value.message.length <= 1000 &&
    form.value.cooldownMinutes >= 1 &&
    form.value.cooldownMinutes <= 10080
  );
});

function isDayWorking(dayIdx: number): boolean {
  return (form.value.daysOfWeek & (1 << dayIdx)) !== 0;
}
function toggleDay(dayIdx: number) {
  form.value.daysOfWeek ^= 1 << dayIdx;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

async function onSave() {
  saving.value = true;
  const input: AutoReplyInput = {
    ...form.value,
    startMinute: timeStringToMinutes(startTime.value),
    endMinute: timeStringToMinutes(endTime.value),
  };
  const result = await saveRule(props.accountId, input);
  saving.value = false;
  if (result.ok) {
    toast.value = { show: true, text: 'Đã lưu', color: 'success' };
  } else {
    toast.value = { show: true, text: result.error, color: 'error' };
  }
}

async function confirmDelete() {
  if (!confirm('Xoá rule auto-reply cho tài khoản này?')) return;
  deleting.value = true;
  const result = await deleteRule(props.accountId);
  deleting.value = false;
  if (result.ok) {
    toast.value = { show: true, text: 'Đã xoá rule', color: 'success' };
    // Reset form to defaults
    form.value = {
      enabled: true,
      daysOfWeek: 62,
      startMinute: 480,
      endMinute: 1080,
      timezone: 'Asia/Ho_Chi_Minh',
      message: '',
      cooldownMinutes: 240,
    };
    startTime.value = '08:00';
    endTime.value = '18:00';
  } else {
    toast.value = { show: true, text: result.error ?? 'Xoá thất bại', color: 'error' };
  }
}

// Sync rule → form whenever a fresh rule arrives
watch(rule, (newRule) => {
  if (newRule) {
    form.value = {
      enabled: newRule.enabled,
      daysOfWeek: newRule.daysOfWeek,
      startMinute: newRule.startMinute,
      endMinute: newRule.endMinute,
      timezone: newRule.timezone,
      message: newRule.message,
      cooldownMinutes: newRule.cooldownMinutes,
    };
    startTime.value = minutesToTimeString(newRule.startMinute);
    endTime.value = minutesToTimeString(newRule.endMinute);
  }
});

// Fetch rule when the dialog opens for a specific account
watch(
  () => props.modelValue,
  (open) => {
    if (open && props.accountId) {
      fetchRule(props.accountId);
    }
  },
);
</script>
