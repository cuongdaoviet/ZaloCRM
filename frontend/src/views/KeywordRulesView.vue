<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">Auto-tag từ keyword</h1>
      <v-spacer />
      <v-btn
        v-if="authStore.isAdmin"
        color="primary" prepend-icon="mdi-plus"
        @click="openCreate"
      >Tạo rule</v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" closable class="mb-3" @click:close="error = ''">
      {{ error }}
    </v-alert>

    <p class="text-body-2 text-grey mb-3">
      Khi tin nhắn từ khách hàng chứa keyword đã cấu hình, hệ thống tự động cập nhật contact (thêm tag, đổi pipeline, gán nhân viên).
    </p>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="rules"
        :loading="loading"
        no-data-text="Chưa có rule nào"
        density="comfortable"
      >
        <template #item.enabled="{ item }">
          <v-chip :color="item.enabled ? 'success' : 'grey'" size="x-small" variant="flat">
            {{ item.enabled ? 'Bật' : 'Tắt' }}
          </v-chip>
        </template>
        <template #item.keywords="{ item }">
          <v-chip v-for="kw in item.keywords" :key="kw" size="x-small" class="mr-1 mb-1" variant="outlined">
            {{ kw }}
          </v-chip>
        </template>
        <template #item.actions="{ item }">
          <v-chip v-if="item.addTag" size="x-small" color="info" class="mr-1" variant="tonal">
            +tag: {{ item.addTag }}
          </v-chip>
          <v-chip v-if="item.setStatus" size="x-small" color="primary" class="mr-1" variant="tonal">
            →{{ STATUS_LABELS[item.setStatus] }}
          </v-chip>
          <v-chip v-if="item.assignToUser" size="x-small" color="warning" variant="tonal">
            gán: {{ item.assignToUser.fullName }}
          </v-chip>
        </template>
        <template #item.triggerCount="{ item }">
          {{ item._count?.triggers ?? 0 }}
        </template>
        <template #item.controls="{ item }">
          <v-btn
            v-if="authStore.isAdmin"
            icon size="small" variant="text"
            @click="openEdit(item)"
            title="Sửa"
          ><v-icon>mdi-pencil</v-icon></v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon size="small" variant="text" color="error"
            @click="confirmDelete(item)"
            title="Xoá"
          ><v-icon>mdi-delete</v-icon></v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialogOpen" max-width="560">
      <v-card>
        <v-card-title>{{ editingId ? 'Sửa rule' : 'Tạo rule' }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="form.name"
            label="Tên rule"
            density="compact" variant="outlined" hide-details="auto"
            maxlength="200"
            class="mb-3"
          />

          <v-combobox
            v-model="form.keywords"
            label="Keywords (gõ + Enter để thêm)"
            multiple chips closable-chips
            density="compact" variant="outlined" hide-details="auto"
            class="mb-3"
          />

          <v-switch
            v-model="form.enabled"
            label="Bật rule"
            color="success" hide-details density="compact"
            class="mb-2"
          />

          <p class="text-body-2 font-weight-medium mb-2">Actions (chọn ít nhất 1)</p>

          <v-text-field
            v-model="form.addTag"
            label="Thêm tag (để trống nếu không dùng)"
            density="compact" variant="outlined" hide-details
            placeholder="VD: hỏi-giá"
            class="mb-2"
          />

          <v-select
            v-model="form.setStatus"
            :items="STATUS_OPTIONS"
            item-title="title" item-value="value"
            label="Đổi trạng thái pipeline (chỉ upgrade)"
            density="compact" variant="outlined" hide-details
            clearable
            class="mb-2"
          />

          <v-select
            v-model="form.assignToUserId"
            :items="userOptions"
            item-title="title" item-value="value"
            label="Gán cho nhân viên (chỉ khi contact chưa có)"
            density="compact" variant="outlined" hide-details
            clearable
            class="mb-2"
          />

          <v-alert v-if="dialogError" type="error" density="compact" class="mt-3" closable @click:close="dialogError = ''">
            {{ dialogError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialogOpen = false" :disabled="saving">Hủy</v-btn>
          <v-btn color="primary" :loading="saving" :disabled="!isValid" @click="onSave">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xoá</v-card-title>
        <v-card-text>Xoá rule "{{ deleteTarget?.name }}"?</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">Hủy</v-btn>
          <v-btn color="error" @click="runDelete">Xoá</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="3000">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api/index';
import {
  useKeywordRules,
  STATUS_LABELS,
  type KeywordRule,
  type KeywordRuleInput,
} from '@/composables/use-keyword-rules';

const authStore = useAuthStore();
const { rules, loading, error, fetchRules, createRule, updateRule, deleteRule } = useKeywordRules();

const STATUS_OPTIONS = Object.keys(STATUS_LABELS).map((s) => ({
  title: STATUS_LABELS[s],
  value: s,
}));

const headers = [
  { title: 'Tên', key: 'name' },
  { title: 'Trạng thái', key: 'enabled' },
  { title: 'Keywords', key: 'keywords', sortable: false },
  { title: 'Actions', key: 'actions', sortable: false },
  { title: 'Đã fire', key: 'triggerCount', align: 'end' as const },
  { title: '', key: 'controls', sortable: false, align: 'end' as const, width: 120 },
];

const dialogOpen = ref(false);
const deleteDialog = ref(false);
const editingId = ref<string | null>(null);
const deleteTarget = ref<KeywordRule | null>(null);
const saving = ref(false);
const dialogError = ref('');
const toast = ref({ show: false, text: '', color: 'success' });

const form = ref<KeywordRuleInput>({
  name: '',
  enabled: true,
  keywords: [],
  addTag: null,
  setStatus: null,
  assignToUserId: null,
});

const userOptions = ref<{ title: string; value: string }[]>([]);

const isValid = computed(() => {
  const f = form.value;
  return (
    f.name.trim().length > 0 &&
    f.keywords.length > 0 &&
    (f.addTag || f.setStatus || f.assignToUserId)
  );
});

function openCreate() {
  editingId.value = null;
  form.value = { name: '', enabled: true, keywords: [], addTag: null, setStatus: null, assignToUserId: null };
  dialogError.value = '';
  dialogOpen.value = true;
}

function openEdit(rule: KeywordRule) {
  editingId.value = rule.id;
  form.value = {
    name: rule.name,
    enabled: rule.enabled,
    keywords: [...rule.keywords],
    addTag: rule.addTag,
    setStatus: rule.setStatus,
    assignToUserId: rule.assignToUserId,
  };
  dialogError.value = '';
  dialogOpen.value = true;
}

async function onSave() {
  saving.value = true;
  dialogError.value = '';
  // Strip empty string addTag → null
  const payload: KeywordRuleInput = {
    ...form.value,
    addTag: form.value.addTag?.trim() || null,
  };
  const result = editingId.value
    ? await updateRule(editingId.value, payload)
    : await createRule(payload);
  saving.value = false;
  if (result.ok) {
    dialogOpen.value = false;
    toast.value = { show: true, text: 'Đã lưu', color: 'success' };
  } else {
    dialogError.value = result.error;
  }
}

function confirmDelete(rule: KeywordRule) {
  deleteTarget.value = rule;
  deleteDialog.value = true;
}

async function runDelete() {
  if (!deleteTarget.value) return;
  const result = await deleteRule(deleteTarget.value.id);
  if (result.ok) {
    deleteDialog.value = false;
    toast.value = { show: true, text: 'Đã xoá', color: 'success' };
  } else {
    toast.value = { show: true, text: result.error ?? 'Xoá thất bại', color: 'error' };
  }
}

onMounted(async () => {
  await fetchRules();
  try {
    const res = await api.get('/users');
    const list = res.data.users ?? res.data ?? [];
    userOptions.value = list.map((u: { id: string; fullName: string; email: string }) => ({
      title: `${u.fullName} (${u.email})`,
      value: u.id,
    }));
  } catch {
    // Non-critical — leave assignToUser disabled if list fails
  }
});
</script>
