<template>
  <div class="conversation-notes">
    <div class="d-flex align-center mb-2">
      <v-icon size="16" class="mr-1">mdi-note-text-outline</v-icon>
      <span class="text-body-2 font-weight-medium">Ghi chú nội bộ</span>
      <v-spacer />
      <span v-if="notes.length > 0" class="text-caption text-grey">{{ notes.length }}</span>
    </div>

    <v-textarea
      v-model="newContent"
      placeholder="Ghi chú riêng cho team (khách không thấy)..."
      density="compact" variant="outlined" hide-details="auto"
      auto-grow rows="2" maxlength="2000"
    />
    <div class="d-flex justify-end mt-1 mb-3">
      <v-btn
        size="small" color="primary"
        :disabled="!newContent.trim()"
        :loading="creating"
        @click="onCreate"
      >Thêm</v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" closable class="mb-2" @click:close="error = ''">
      {{ error }}
    </v-alert>

    <div v-if="notes.length === 0 && !loading" class="text-caption text-grey text-center pa-3">
      Chưa có ghi chú nào
    </div>

    <div v-for="note in notes" :key="note.id" class="note-item mb-2">
      <div class="d-flex align-start">
        <div class="flex-grow-1">
          <div class="d-flex align-center text-caption text-grey">
            <strong>{{ note.author.fullName }}</strong>
            <span class="mx-1">·</span>
            <span>{{ formatDate(note.createdAt) }}</span>
            <span v-if="note.createdAt !== note.updatedAt" class="ml-1">(đã sửa)</span>
          </div>
          <div v-if="editingId === note.id" class="mt-1">
            <v-textarea
              v-model="editContent"
              density="compact" variant="outlined" hide-details="auto"
              auto-grow rows="2" maxlength="2000"
            />
            <div class="d-flex justify-end mt-1" style="gap: 4px;">
              <v-btn size="x-small" @click="cancelEdit">Hủy</v-btn>
              <v-btn size="x-small" color="primary" @click="onUpdate(note.id)">Lưu</v-btn>
            </div>
          </div>
          <p v-else class="text-body-2 mt-1 note-content" style="white-space: pre-wrap;">{{ note.content }}</p>
        </div>
        <div v-if="canEdit(note) && editingId !== note.id" class="ml-1">
          <v-btn icon size="x-small" variant="text" @click="startEdit(note)">
            <v-icon size="14">mdi-pencil</v-icon>
            <v-tooltip activator="parent" location="top" text="Sửa" />
          </v-btn>
          <v-btn icon size="x-small" variant="text" color="error" @click="onDelete(note.id)">
            <v-icon size="14">mdi-delete</v-icon>
            <v-tooltip activator="parent" location="top" text="Xoá" />
          </v-btn>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import {
  useConversationNotes,
  type ConversationNote,
} from '@/composables/use-conversation-notes';

const props = defineProps<{ conversationId: string }>();
const authStore = useAuthStore();
const { notes, loading, error, fetchNotes, createNote, updateNote, deleteNote } = useConversationNotes();

const newContent = ref('');
const creating = ref(false);
const editingId = ref<string | null>(null);
const editContent = ref('');

function canEdit(note: ConversationNote): boolean {
  return authStore.isAdmin || note.authorId === authStore.user?.id;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

async function onCreate() {
  if (!newContent.value.trim()) return;
  creating.value = true;
  const result = await createNote(props.conversationId, newContent.value.trim());
  creating.value = false;
  if (result.ok) {
    newContent.value = '';
  } else {
    error.value = result.error;
  }
}

function startEdit(note: ConversationNote) {
  editingId.value = note.id;
  editContent.value = note.content;
}

function cancelEdit() {
  editingId.value = null;
  editContent.value = '';
}

async function onUpdate(noteId: string) {
  if (!editContent.value.trim()) return;
  const result = await updateNote(noteId, editContent.value.trim());
  if (result.ok) {
    cancelEdit();
  } else {
    error.value = result.error;
  }
}

async function onDelete(noteId: string) {
  if (!confirm('Xoá ghi chú này?')) return;
  const result = await deleteNote(noteId);
  if (!result.ok) {
    error.value = result.error;
  }
}

// Fetch on mount and whenever the conversation id changes
watch(
  () => props.conversationId,
  (id) => {
    if (id) fetchNotes(id);
  },
  { immediate: true },
);
</script>

<style scoped>
.note-item {
  padding: 8px;
  background: rgba(0, 242, 255, 0.04);
  border-left: 2px solid rgba(0, 242, 255, 0.3);
  border-radius: 4px;
}
.note-content {
  color: inherit;
}
</style>
