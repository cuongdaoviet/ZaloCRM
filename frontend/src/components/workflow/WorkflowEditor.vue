<template>
  <div>
    <v-text-field
      v-model="form.name"
      label="Tên workflow *"
      density="compact"
      variant="outlined"
      hide-details="auto"
      maxlength="200"
      class="mb-3"
    />

    <v-textarea
      v-model="form.description"
      label="Mô tả (tuỳ chọn)"
      density="compact"
      variant="outlined"
      rows="2"
      auto-grow
      hide-details="auto"
      class="mb-3"
    />

    <v-switch
      v-model="form.isActive"
      label="Bật workflow"
      color="success"
      hide-details
      density="compact"
      class="mb-4"
    />

    <v-divider class="mb-3" />

    <p class="text-body-2 font-weight-medium mb-2">Điều kiện kích hoạt</p>
    <v-card variant="tonal" class="pa-3 mb-4">
      <v-text-field
        v-model="form.trigger.messageMatch"
        label="Nội dung tin nhắn chứa (không bắt buộc)"
        density="compact"
        variant="outlined"
        hide-details="auto"
        placeholder="VD: bảng giá"
        class="mb-2"
      />
      <v-select
        v-model="form.trigger.contactStatus"
        :items="CONTACT_STATUS_OPTIONS"
        item-title="title"
        item-value="value"
        label="Chỉ chạy khi contact ở trạng thái"
        density="compact"
        variant="outlined"
        hide-details="auto"
        multiple
        chips
        clearable
        class="mb-2"
      />
      <v-switch
        v-model="form.trigger.isFirstInbound"
        label="Chỉ chạy với tin nhắn đầu tiên của contact"
        color="primary"
        hide-details
        density="compact"
      />
    </v-card>

    <p class="text-body-2 font-weight-medium mb-2">Các bước</p>

    <v-card
      v-for="(step, idx) in form.steps"
      :key="idx"
      variant="outlined"
      class="pa-3 mb-2"
    >
      <div class="d-flex align-center mb-2">
        <span class="text-caption text-grey">Bước {{ idx + 1 }}</span>
        <v-spacer />
        <v-btn
          icon
          size="x-small"
          variant="text"
          :disabled="idx === 0"
          @click="moveStep(idx, -1)"
        >
          <v-icon size="18">mdi-arrow-up</v-icon>
        </v-btn>
        <v-btn
          icon
          size="x-small"
          variant="text"
          :disabled="idx === form.steps.length - 1"
          @click="moveStep(idx, 1)"
        >
          <v-icon size="18">mdi-arrow-down</v-icon>
        </v-btn>
        <v-btn
          icon
          size="x-small"
          variant="text"
          color="error"
          :disabled="form.steps.length <= 1"
          @click="removeStep(idx)"
        >
          <v-icon size="18">mdi-delete</v-icon>
        </v-btn>
      </div>

      <v-select
        v-model="step.type"
        :items="STEP_TYPE_OPTIONS"
        item-title="title"
        item-value="value"
        label="Loại bước"
        density="compact"
        variant="outlined"
        hide-details="auto"
        class="mb-2"
        @update:model-value="onStepTypeChange(step)"
      />

      <v-text-field
        v-model.number="step.delayMinutes"
        type="number"
        :min="step.type === 'wait' ? 1 : 0"
        label="Chờ trước khi chạy (phút)"
        density="compact"
        variant="outlined"
        hide-details="auto"
        class="mb-2"
      />

      <v-textarea
        v-if="step.type === 'send_message'"
        v-model="step.content"
        label="Nội dung tin nhắn"
        density="compact"
        variant="outlined"
        rows="3"
        auto-grow
        hide-details="auto"
        maxlength="2000"
        counter
        placeholder="VD: Chào {{ '{{contactName}}' }}, em là Sale CDI..."
        :hint="VAR_HINT"
        persistent-hint
      />

      <v-text-field
        v-if="step.type === 'add_tag'"
        v-model="step.tag"
        label="Tên tag"
        density="compact"
        variant="outlined"
        hide-details="auto"
        maxlength="64"
        placeholder="VD: hỏi-giá"
      />

      <v-select
        v-if="step.type === 'assign_user'"
        v-model="step.userId"
        :items="userOptions"
        item-title="title"
        item-value="value"
        label="Gán cho nhân viên"
        density="compact"
        variant="outlined"
        hide-details="auto"
      />
    </v-card>

    <v-btn
      prepend-icon="mdi-plus"
      variant="tonal"
      block
      :disabled="form.steps.length >= 50"
      @click="addStep"
    >
      Thêm bước
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';

export interface WorkflowStepForm {
  type: 'send_message' | 'add_tag' | 'assign_user' | 'wait';
  delayMinutes: number;
  content?: string;
  tag?: string;
  userId?: string;
}

export interface WorkflowTriggerForm {
  type: 'inbound_message';
  messageMatch?: string | null;
  contactStatus?: string[];
  isFirstInbound?: boolean;
}

export interface WorkflowFormValue {
  name: string;
  description: string | null;
  isActive: boolean;
  trigger: WorkflowTriggerForm;
  steps: WorkflowStepForm[];
}

const props = defineProps<{
  modelValue: WorkflowFormValue;
  userOptions: { title: string; value: string }[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: WorkflowFormValue] }>();

const form = computed(() => props.modelValue);

watch(
  form,
  (v) => emit('update:modelValue', v),
  { deep: true },
);

const VAR_HINT = 'Biến: {{contactName}}, {{firstName}}, {{repName}}';

const STEP_TYPE_OPTIONS = [
  { title: 'Gửi tin nhắn', value: 'send_message' },
  { title: 'Thêm tag', value: 'add_tag' },
  { title: 'Gán nhân viên', value: 'assign_user' },
  { title: 'Chờ (delay)', value: 'wait' },
];

const CONTACT_STATUS_OPTIONS = [
  { title: 'Mới', value: 'new' },
  { title: 'Đã liên hệ', value: 'contacted' },
  { title: 'Quan tâm', value: 'interested' },
  { title: 'Đã chốt', value: 'converted' },
  { title: 'Mất', value: 'lost' },
];

function addStep(): void {
  form.value.steps.push({
    type: 'send_message',
    delayMinutes: 0,
    content: '',
  });
}

function removeStep(idx: number): void {
  form.value.steps.splice(idx, 1);
}

function moveStep(idx: number, dir: -1 | 1): void {
  const target = idx + dir;
  if (target < 0 || target >= form.value.steps.length) return;
  const [item] = form.value.steps.splice(idx, 1);
  form.value.steps.splice(target, 0, item);
}

function onStepTypeChange(step: WorkflowStepForm): void {
  // Reset payload fields when switching types so stale data doesn't ride along
  // through validation. wait steps need a minimum of 1 minute.
  step.content = step.type === 'send_message' ? (step.content ?? '') : undefined;
  step.tag = step.type === 'add_tag' ? (step.tag ?? '') : undefined;
  step.userId = step.type === 'assign_user' ? (step.userId ?? '') : undefined;
  if (step.type === 'wait' && (!step.delayMinutes || step.delayMinutes < 1)) {
    step.delayMinutes = 30;
  }
}
</script>
