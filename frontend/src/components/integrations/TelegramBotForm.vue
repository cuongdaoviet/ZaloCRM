<template>
  <div>
    <v-alert type="info" density="compact" class="mb-3">
      Tạo bot qua @BotFather trên Telegram để lấy bot token, sau đó mời bot
      vào channel + lấy chat ID. Chi tiết: docs/features/0038-integration-hub/SPEC.md
    </v-alert>

    <v-text-field
      v-model="local.botToken"
      label="Bot token"
      placeholder="1234567890:AAH-xyz..."
      type="password"
      autocomplete="off"
      hint="Lấy từ @BotFather sau khi /newbot"
      persistent-hint
    />
    <v-text-field
      v-model="local.chatId"
      label="Chat ID"
      placeholder="-100xxxxxxxxxx (group) hoặc số dương (user DM)"
      class="mt-3"
      hint="Mời bot vào channel rồi forward một tin về @userinfobot để lấy chat ID"
      persistent-hint
    />

    <div class="mt-4">
      <div class="text-subtitle-2 mb-2">Loại sự kiện nhận thông báo</div>
      <v-checkbox
        v-for="opt in EVENT_OPTIONS"
        :key="opt.value"
        v-model="local.eventTypes"
        :value="opt.value"
        :label="opt.label"
        density="compact"
        hide-details
      />
    </div>

    <v-expansion-panels class="mt-4">
      <v-expansion-panel title="Cài đặt nâng cao">
        <v-expansion-panel-text>
          <v-text-field
            v-model="apiEndpointModel"
            label="API endpoint (tuỳ chọn)"
            placeholder="https://api.telegram.org"
            hint="Chỉ dùng nếu cần proxy. Phải HTTPS và không phải IP nội bộ."
            persistent-hint
          />
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { TelegramBotConfig } from '@/composables/use-integrations';

const props = defineProps<{
  modelValue: TelegramBotConfig;
}>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: TelegramBotConfig): void;
}>();

const local = reactive<TelegramBotConfig>({
  botToken: props.modelValue.botToken ?? '',
  chatId: props.modelValue.chatId ?? '',
  eventTypes: [...(props.modelValue.eventTypes ?? ['contact.created'])],
  apiEndpoint: props.modelValue.apiEndpoint,
});

watch(
  () => local,
  (v) => emit('update:modelValue', { ...v, eventTypes: [...v.eventTypes] }),
  { deep: true },
);

const apiEndpointModel = computed({
  get: () => local.apiEndpoint ?? '',
  set: (v: string) => {
    local.apiEndpoint = v.trim().length > 0 ? v.trim() : undefined;
  },
});

const EVENT_OPTIONS = [
  { value: 'contact.created' as const, label: 'Khách hàng mới (contact.created)' },
  { value: 'order.created' as const, label: 'Đơn hàng mới (order.created)' },
  { value: 'appointment.reminder' as const, label: 'Nhắc lịch hẹn (appointment.reminder)' },
  { value: 'message.escalated' as const, label: 'Tin nhắn cần xử lý (message.escalated)' },
];
</script>
