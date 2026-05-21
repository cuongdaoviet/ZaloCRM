<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">
        <v-icon class="mr-2" color="primary">mdi-pipe</v-icon>
        Workflow tự động
      </h1>
      <v-spacer />
      <v-btn
        v-if="authStore.isAdmin"
        color="primary"
        prepend-icon="mdi-plus"
        @click="openCreate"
      >
        Tạo workflow
      </v-btn>
    </div>

    <p class="text-body-2 text-grey mb-3">
      Khi inbound message khớp điều kiện, hệ thống chạy chuỗi bước tuần tự
      (gửi tin nhắn, thêm tag, gán nhân viên, chờ). Cooldown 24h để tránh
      kích hoạt lặp lại với cùng contact.
    </p>

    <v-alert
      v-if="error"
      type="error"
      density="compact"
      closable
      class="mb-3"
      @click:close="error = ''"
    >
      {{ error }}
    </v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="workflows"
        :loading="loading"
        no-data-text="Chưa có workflow nào"
        density="comfortable"
      >
        <template #item.isActive="{ item }">
          <v-chip
            :color="item.isActive ? 'success' : 'grey'"
            size="x-small"
            variant="flat"
          >
            {{ item.isActive ? 'Bật' : 'Tắt' }}
          </v-chip>
        </template>
        <template #item.stepCount="{ item }">
          {{ Array.isArray(item.steps) ? item.steps.length : 0 }} bước
        </template>
        <template #item.executions="{ item }">
          {{ item._count?.executions ?? 0 }}
        </template>
        <template #item.controls="{ item }">
          <v-btn
            icon
            size="small"
            variant="text"
            title="Xem lịch sử"
            @click="openExecutions(item)"
          >
            <v-icon>mdi-history</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon
            size="small"
            variant="text"
            title="Sửa"
            @click="openEdit(item)"
          >
            <v-icon>mdi-pencil</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon
            size="small"
            variant="text"
            color="error"
            title="Xoá"
            @click="confirmDelete(item)"
          >
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialogOpen" max-width="640" persistent>
      <v-card>
        <v-card-title>{{ editingId ? 'Sửa workflow' : 'Tạo workflow' }}</v-card-title>
        <v-card-text>
          <WorkflowEditor v-model="form" :user-options="userOptions" />

          <v-alert
            v-if="dialogError"
            type="error"
            density="compact"
            closable
            class="mt-3"
            @click:close="dialogError = ''"
          >
            {{ dialogError }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn :disabled="saving" @click="dialogOpen = false">Hủy</v-btn>
          <v-btn
            color="primary"
            :loading="saving"
            :disabled="!isValid"
            @click="onSave"
          >
            Lưu
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xoá</v-card-title>
        <v-card-text>
          Xoá workflow "{{ deleteTarget?.name }}"? Toàn bộ lịch sử chạy của
          workflow này cũng sẽ bị xoá.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">Hủy</v-btn>
          <v-btn color="error" @click="runDelete">Xoá</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Executions log dialog -->
    <v-dialog v-model="execDialog" max-width="720">
      <v-card>
        <v-card-title>
          Lịch sử chạy — {{ execTarget?.name }}
        </v-card-title>
        <v-card-text>
          <v-data-table
            :headers="execHeaders"
            :items="executions"
            :loading="execLoading"
            no-data-text="Chưa có lượt chạy nào"
            density="comfortable"
          >
            <template #item.status="{ item }">
              <v-chip
                :color="STATUS_COLORS[item.status] ?? 'default'"
                size="x-small"
                variant="flat"
              >
                {{ STATUS_LABELS[item.status] ?? item.status }}
              </v-chip>
            </template>
            <template #item.contact="{ item }">
              {{ item.contact?.fullName ?? '—' }}
            </template>
            <template #item.startedAt="{ item }">
              {{ formatDate(item.startedAt) }}
            </template>
            <template #item.currentStepIdx="{ item }">
              {{ item.currentStepIdx }}
            </template>
          </v-data-table>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="execDialog = false">Đóng</v-btn>
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
import WorkflowEditor, {
  type WorkflowFormValue,
  type WorkflowStepForm,
} from '@/components/workflow/WorkflowEditor.vue';

interface WorkflowDefinition {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  trigger: WorkflowFormValue['trigger'];
  steps: WorkflowStepForm[];
  _count?: { executions: number };
}

interface WorkflowExecution {
  id: string;
  status: string;
  currentStepIdx: number;
  startedAt: string;
  completedAt: string | null;
  contact?: { id: string; fullName: string | null };
}

const authStore = useAuthStore();

const workflows = ref<WorkflowDefinition[]>([]);
const loading = ref(false);
const error = ref('');
const saving = ref(false);

const dialogOpen = ref(false);
const deleteDialog = ref(false);
const execDialog = ref(false);

const editingId = ref<string | null>(null);
const deleteTarget = ref<WorkflowDefinition | null>(null);
const execTarget = ref<WorkflowDefinition | null>(null);
const executions = ref<WorkflowExecution[]>([]);
const execLoading = ref(false);

const dialogError = ref('');
const toast = ref({ show: false, text: '', color: 'success' });

const headers = [
  { title: 'Tên', key: 'name' },
  { title: 'Trạng thái', key: 'isActive' },
  { title: 'Số bước', key: 'stepCount', sortable: false },
  { title: 'Đã chạy', key: 'executions', align: 'end' as const },
  { title: '', key: 'controls', sortable: false, align: 'end' as const, width: 180 },
];

const execHeaders = [
  { title: 'Contact', key: 'contact', sortable: false },
  { title: 'Trạng thái', key: 'status' },
  { title: 'Step đang chạy', key: 'currentStepIdx', align: 'end' as const },
  { title: 'Bắt đầu', key: 'startedAt' },
];

const STATUS_LABELS: Record<string, string> = {
  running: 'Đang chạy',
  completed: 'Hoàn tất',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
};
const STATUS_COLORS: Record<string, string> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'grey',
};

function emptyForm(): WorkflowFormValue {
  return {
    name: '',
    description: null,
    isActive: true,
    trigger: { type: 'inbound_message', messageMatch: '', contactStatus: [], isFirstInbound: false },
    steps: [{ type: 'send_message', delayMinutes: 0, content: '' }],
  };
}

const form = ref<WorkflowFormValue>(emptyForm());

const userOptions = ref<{ title: string; value: string }[]>([]);

const isValid = computed(() => {
  const f = form.value;
  if (f.name.trim().length === 0) return false;
  if (f.steps.length === 0) return false;
  for (const step of f.steps) {
    if (step.type === 'send_message' && !(step.content ?? '').trim()) return false;
    if (step.type === 'add_tag' && !(step.tag ?? '').trim()) return false;
    if (step.type === 'assign_user' && !(step.userId ?? '').trim()) return false;
    if (step.type === 'wait' && (!step.delayMinutes || step.delayMinutes < 1)) return false;
  }
  return true;
});

async function fetchWorkflows(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.get('/workflows');
    workflows.value = res.data.workflows ?? [];
  } catch (err: unknown) {
    error.value = getErrMsg(err);
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = null;
  form.value = emptyForm();
  dialogError.value = '';
  dialogOpen.value = true;
}

function openEdit(wf: WorkflowDefinition): void {
  editingId.value = wf.id;
  form.value = {
    name: wf.name,
    description: wf.description,
    isActive: wf.isActive,
    trigger: {
      type: 'inbound_message',
      messageMatch: wf.trigger?.messageMatch ?? '',
      contactStatus: wf.trigger?.contactStatus ?? [],
      isFirstInbound: wf.trigger?.isFirstInbound ?? false,
    },
    steps: Array.isArray(wf.steps)
      ? wf.steps.map((s) => ({ ...s, delayMinutes: s.delayMinutes ?? 0 }))
      : [],
  };
  dialogError.value = '';
  dialogOpen.value = true;
}

async function onSave(): Promise<void> {
  saving.value = true;
  dialogError.value = '';
  try {
    const payload = {
      name: form.value.name.trim(),
      description: form.value.description?.trim() || null,
      isActive: form.value.isActive,
      trigger: {
        type: 'inbound_message',
        ...(form.value.trigger.messageMatch?.trim()
          ? { messageMatch: form.value.trigger.messageMatch.trim() }
          : {}),
        ...(form.value.trigger.contactStatus && form.value.trigger.contactStatus.length > 0
          ? { contactStatus: form.value.trigger.contactStatus }
          : {}),
        ...(form.value.trigger.isFirstInbound ? { isFirstInbound: true } : {}),
      },
      steps: form.value.steps.map((s) => {
        const base: Record<string, unknown> = {
          type: s.type,
          delayMinutes: s.delayMinutes ?? 0,
        };
        if (s.type === 'send_message') base.content = s.content;
        if (s.type === 'add_tag') base.tag = s.tag;
        if (s.type === 'assign_user') base.userId = s.userId;
        return base;
      }),
    };
    if (editingId.value) {
      await api.put(`/workflows/${editingId.value}`, payload);
    } else {
      await api.post('/workflows', payload);
    }
    dialogOpen.value = false;
    toast.value = { show: true, text: 'Đã lưu', color: 'success' };
    await fetchWorkflows();
  } catch (err: unknown) {
    dialogError.value = getErrMsg(err);
  } finally {
    saving.value = false;
  }
}

function confirmDelete(wf: WorkflowDefinition): void {
  deleteTarget.value = wf;
  deleteDialog.value = true;
}

async function runDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  try {
    await api.delete(`/workflows/${deleteTarget.value.id}`);
    deleteDialog.value = false;
    toast.value = { show: true, text: 'Đã xoá', color: 'success' };
    await fetchWorkflows();
  } catch (err: unknown) {
    toast.value = { show: true, text: getErrMsg(err) || 'Xoá thất bại', color: 'error' };
  }
}

async function openExecutions(wf: WorkflowDefinition): Promise<void> {
  execTarget.value = wf;
  execDialog.value = true;
  execLoading.value = true;
  try {
    const res = await api.get(`/workflows/${wf.id}/executions`);
    executions.value = res.data.executions ?? [];
  } catch (err: unknown) {
    toast.value = { show: true, text: getErrMsg(err), color: 'error' };
  } finally {
    execLoading.value = false;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('vi-VN');
  } catch {
    return iso;
  }
}

function getErrMsg(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    return e.response?.data?.error ?? e.message ?? 'Đã xảy ra lỗi';
  }
  return 'Đã xảy ra lỗi';
}

onMounted(async () => {
  await fetchWorkflows();
  try {
    const res = await api.get('/users');
    const list = res.data.users ?? res.data ?? [];
    userOptions.value = list.map((u: { id: string; fullName: string; email: string }) => ({
      title: `${u.fullName} (${u.email})`,
      value: u.id,
    }));
  } catch {
    // Non-critical — leave assign_user options empty if list fails
  }
});
</script>
