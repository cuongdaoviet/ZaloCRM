<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">Tin nhắn mẫu</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreateDialog">
        Tạo tin mẫu
      </v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" closable class="mb-3" @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="replies"
        :loading="loading"
        no-data-text="Chưa có tin mẫu nào — bấm Tạo tin mẫu để thêm"
      >
        <template #item.shortcut="{ item }">
          <code class="shortcut-cell">/{{ item.shortcut }}</code>
        </template>
        <template #item.content="{ item }">
          <span class="text-truncate d-inline-block" style="max-width: 480px;">
            {{ item.content }}
          </span>
        </template>
        <template #item.scope="{ item }">
          <v-chip
            size="small" variant="tonal"
            :color="item.scope === 'org' ? 'info' : 'default'"
          >
            {{ item.scope === 'org' ? 'Toàn org' : 'Cá nhân' }}
          </v-chip>
        </template>
        <template #item.actions="{ item }">
          <v-btn
            icon size="small" variant="text"
            :disabled="!canEdit(item)" :title="canEdit(item) ? 'Sửa' : 'Chỉ người tạo / admin sửa được'"
            @click="openEditDialog(item)"
          >
            <v-icon>mdi-pencil</v-icon>
          </v-btn>
          <v-btn
            icon size="small" variant="text" color="error"
            :disabled="!canEdit(item)" :title="canEdit(item) ? 'Xoá' : ''"
            @click="confirmDelete(item)"
          >
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialogOpen" max-width="560">
      <v-card>
        <v-card-title>{{ editingId ? 'Sửa tin mẫu' : 'Tạo tin mẫu' }}</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="form.shortcut" label="Shortcut (a-z, 0-9, -, _)"
            density="compact" variant="outlined" hide-details="auto"
            prefix="/"
            :rules="[(v) => /^[a-z0-9_-]{2,20}$/.test(v) || '2-20 ký tự, chỉ a-z 0-9 - _']"
            class="mb-3"
          />
          <v-textarea
            v-model="form.content" label="Nội dung tin nhắn"
            density="compact" variant="outlined" hide-details="auto"
            auto-grow rows="4" counter="2000" maxlength="2000"
            class="mb-3"
          />
          <p class="text-caption text-grey mb-2">
            💡 Placeholder: <code>{{ '{{contactName}}' }}</code> và <code>{{ '{{firstName}}' }}</code>
            sẽ được thay tên khách hàng khi chèn.
          </p>
          <v-select
            v-if="authStore.isAdmin"
            v-model="form.scope" label="Phạm vi"
            :items="[
              { value: 'user', title: 'Chỉ tôi' },
              { value: 'org', title: 'Cả tổ chức' },
            ]"
            item-title="title" item-value="value"
            density="compact" variant="outlined" hide-details
            class="mb-2"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="dialogOpen = false">Hủy</v-btn>
          <v-btn
            color="primary" :loading="saving"
            :disabled="!formValid"
            @click="saveReply"
          >Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirmation -->
    <v-dialog v-model="deleteDialogOpen" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xoá</v-card-title>
        <v-card-text>Xoá tin mẫu <code>/{{ deleteTarget?.shortcut }}</code>?</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialogOpen = false">Hủy</v-btn>
          <v-btn color="error" :loading="deleting" @click="runDelete">Xoá</v-btn>
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
import { useQuickReplies, type QuickReply, type QuickReplyInput } from '@/composables/use-quick-replies';

const authStore = useAuthStore();
const { replies, loading, error, fetchReplies, createReply, updateReply, deleteReply } = useQuickReplies();

const headers = [
  { title: 'Shortcut', key: 'shortcut', sortable: true },
  { title: 'Nội dung', key: 'content', sortable: false },
  { title: 'Phạm vi', key: 'scope', sortable: true },
  { title: 'Người tạo', key: 'createdByName', sortable: true },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const },
];

const dialogOpen = ref(false);
const deleteDialogOpen = ref(false);
const editingId = ref<string | null>(null);
const deleteTarget = ref<QuickReply | null>(null);
const saving = ref(false);
const deleting = ref(false);
const toast = ref({ show: false, text: '', color: 'success' });

const form = ref<QuickReplyInput>({ shortcut: '', content: '', scope: 'user' });

const formValid = computed(
  () =>
    /^[a-z0-9_-]{2,20}$/.test(form.value.shortcut) &&
    form.value.content.trim().length > 0 &&
    form.value.content.length <= 2000,
);

function canEdit(reply: QuickReply): boolean {
  return authStore.isAdmin || reply.createdByUserId === authStore.user?.id;
}

function openCreateDialog() {
  editingId.value = null;
  form.value = { shortcut: '', content: '', scope: 'user' };
  dialogOpen.value = true;
}

function openEditDialog(reply: QuickReply) {
  editingId.value = reply.id;
  form.value = { shortcut: reply.shortcut, content: reply.content, scope: reply.scope };
  dialogOpen.value = true;
}

async function saveReply() {
  saving.value = true;
  const result = editingId.value
    ? await updateReply(editingId.value, form.value)
    : await createReply(form.value);
  saving.value = false;
  if (result.ok) {
    dialogOpen.value = false;
    toast.value = { show: true, text: 'Đã lưu', color: 'success' };
  } else {
    toast.value = { show: true, text: result.error, color: 'error' };
  }
}

function confirmDelete(reply: QuickReply) {
  deleteTarget.value = reply;
  deleteDialogOpen.value = true;
}

async function runDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  const result = await deleteReply(deleteTarget.value.id);
  deleting.value = false;
  if (result.ok) {
    deleteDialogOpen.value = false;
    toast.value = { show: true, text: 'Đã xoá', color: 'success' };
  } else {
    toast.value = { show: true, text: result.error ?? 'Xoá thất bại', color: 'error' };
  }
}

onMounted(() => fetchReplies());
</script>

<style scoped>
.shortcut-cell {
  font-family: ui-monospace, monospace;
  color: #00B8D4;
  font-weight: 600;
}
</style>
