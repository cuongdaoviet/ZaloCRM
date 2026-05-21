<template>
  <div class="chat-container d-flex" style="height: calc(100vh - 64px);">
    <!-- Conversation list — resizable -->
    <div class="chat-panel-left" :style="{ width: leftWidth + 'px' }">
      <ConversationList
        :conversations="conversations"
        :selected-id="selectedConvId"
        :loading="loadingConvs"
        :pinned-ids="pinnedIds"
        :pinned-order="pinnedOrder"
        :filters="filters"
        :has-active-filters="hasActiveFilters"
        :unread-total="unreadTotal"
        :unreplied-total="unrepliedTotal"
        :main-unread="mainUnread"
        :other-unread="otherUnread"
        :on-hover="onConversationHover"
        :on-hover-leave="onConversationHoverLeave"
        v-model:search="searchQuery"
        @select="selectConversation"
        @filter-account="onFilterAccount"
        @new-chat="showNewChatDialog = true"
        @toggle-pin="togglePin"
        @update:filters="filters = $event"
        @reset-filters="resetFilters"
        @update:tab="onTabChange"
        @set-conv-tab="onSetConvTab"
      />
      <!-- Resize handle -->
      <div class="resize-handle" @mousedown="startResize('left', $event)" />
    </div>

    <!-- Message thread — flexible center -->
    <MessageThread
      :conversation="selectedConv"
      :messages="messages"
      :loading="loadingMsgs"
      :sending="sendingMsg"
      :is-pinned="selectedConv ? pinnedIds.has(selectedConv.id) : false"
      :self-user-id="selfUserId ?? null"
      :on-react="addOrToggleReaction"
      @send="sendMessage"
      @send-attachment="onSendAttachment"
      @toggle-contact-panel="showContactPanel = !showContactPanel"
      @toggle-pin="onTogglePinHeader"
      @appointment-suggest="onAppointmentSuggest"
      @create-contact-from-zalo="onCreateContactFromZalo"
      @open-contact="onOpenContactFromZalo"
      :show-contact-panel="showContactPanel"
      style="flex: 1; min-width: 300px;"
    />

    <!-- Feature 0030 — reusing ContactDetailDialog for the "Tạo Contact" flow
         from the Zalo user popover so we don't duplicate the form logic. -->
    <ContactDetailDialog
      v-model="showZaloContactDialog"
      :contact="null"
      :prefill="zaloContactPrefill"
      @saved="onZaloContactSaved"
    />

    <!-- Contact panel — resizable -->
    <div v-if="showContactPanel && selectedConv?.contact" class="chat-panel-right" :style="{ width: rightWidth + 'px' }">
      <div class="resize-handle resize-handle-left" @mousedown="startResize('right', $event)" />
      <ChatContactPanel
        :contact-id="selectedConv.contact.id"
        :conversation-id="selectedConv.id"
        :contact="selectedConv.contact"
        :appointment-prefill="appointmentPrefill"
        @close="showContactPanel = false"
        @saved="fetchConversations()"
      />
    </div>

    <!-- New chat dialog -->
    <NewChatDialog
      v-model="showNewChatDialog"
      @created="onCreateConversation"
    />

    <!-- Attachment upload error toast -->
    <v-snackbar v-model="attachmentToast.show" :color="attachmentToast.color" timeout="4000">
      {{ attachmentToast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import ConversationList from '@/components/chat/ConversationList.vue';
import MessageThread from '@/components/chat/MessageThread.vue';
import ChatContactPanel from '@/components/chat/ChatContactPanel.vue';
import NewChatDialog from '@/components/chat/NewChatDialog.vue';
import ContactDetailDialog, {
  type ContactPrefill,
} from '@/components/contacts/ContactDetailDialog.vue';
import { useChat } from '@/composables/use-chat';
import { usePinnedConversations } from '@/composables/use-pinned-conversations';
import { useAuthStore } from '@/stores/auth';
import type { ParsedAppointment } from '@/composables/use-appointment-parser';
import type { AppointmentPrefill } from '@/components/chat/ChatAppointments.vue';

const {
  conversations, selectedConvId, selectedConv, messages,
  loadingConvs, loadingMsgs, sendingMsg, searchQuery, accountFilter,
  selfUserId, selfFullName,
  // Feature 0022 — filter state, badge counts, helpers
  filters, hasActiveFilters, unreadTotal, unrepliedTotal,
  // Feature 0023 — per-tab badges + tab mutator
  mainUnread, otherUnread, setConversationTab,
  resetFilters, fetchConversationCounts,
  fetchConversations, selectConversation, sendMessage, sendAttachment, createConversation,
  initSocket, destroySocket, addOrToggleReaction,
  // Feature 0043 — hover prefetch handles passed through to ConversationList.
  onConversationHover, onConversationHoverLeave,
} = useChat();

// Feature 0021 — feed auth identity into the chat composable so the
// reactions sub-composable can build optimistic stubs + dedupe self-listen
// rows. We do this in onMounted (below) so the auth store has rehydrated.
const auth = useAuthStore();

const { pinnedIds, pinnedOrder, fetchPinned, togglePin } = usePinnedConversations();

async function onTogglePinHeader() {
  if (!selectedConv.value) return;
  await togglePin(selectedConv.value.id);
}

const attachmentToast = ref<{ show: boolean; text: string; color: string }>({
  show: false, text: '', color: 'success',
});

async function onSendAttachment(file: File) {
  const result = await sendAttachment(file);
  if (!result.ok) {
    attachmentToast.value = { show: true, text: result.error, color: 'error' };
  }
}

function onFilterAccount(id: string | null) {
  accountFilter.value = id;
  fetchConversations();
}

// Feature 0023 — switch between the Chính / Khác inbox tabs.
function onTabChange(tab: 'main' | 'other') {
  filters.value = { ...filters.value, tab };
  // The filters watcher in use-chat refetches conversations; counts stay
  // stable when only the tab toggles so no extra fetch is needed here.
}

// Feature 0023 — context-menu archive / restore on a single conversation.
async function onSetConvTab(convId: string, tab: 'main' | 'other') {
  // EC-0001 — if the row leaves the active tab and was selected, clear the
  // selection so the user lands on the empty thread state.
  const isSelected = selectedConvId.value === convId;
  const isLeavingActiveTab = tab !== (filters.value.tab ?? 'main');
  const result = await setConversationTab(convId, tab);
  if (!result.ok) {
    attachmentToast.value = { show: true, text: result.error, color: 'error' };
    return;
  }
  if (isSelected && isLeavingActiveTab) {
    selectedConvId.value = null;
  }
  attachmentToast.value = {
    show: true,
    text: tab === 'other' ? 'Đã ẩn vào tab Khác' : 'Đã đưa về tab Chính',
    color: 'success',
  };
}

const showContactPanel = ref(false);
const showNewChatDialog = ref(false);

// ── Feature 0030 — Zalo user popover → "Tạo Contact" / "Xem trong CRM" ──
const router = useRouter();
const showZaloContactDialog = ref(false);
const zaloContactPrefill = ref<ContactPrefill | null>(null);

function onCreateContactFromZalo(payload: {
  fullName: string;
  zaloUid: string;
  avatarUrl: string | null;
  phone: string | null;
}) {
  zaloContactPrefill.value = {
    fullName: payload.fullName,
    phone: payload.phone,
    avatarUrl: payload.avatarUrl,
    zaloUid: payload.zaloUid,
  };
  showZaloContactDialog.value = true;
}

function onOpenContactFromZalo(contactId: string) {
  router.push({ name: 'Customer360', params: { id: contactId } });
}

function onZaloContactSaved() {
  zaloContactPrefill.value = null;
  // Refresh conversations so any newly-created contact attaches to the
  // existing conversation row (BR-0007 cross-reference is computed on
  // every popover open, so this only ensures the conversation panel
  // shows the new contact name immediately).
  fetchConversations();
}

// Feature 0017 — appointment suggestion handoff from MessageThread.
const appointmentPrefill = ref<AppointmentPrefill | null>(null);
let appointmentPrefillToken = 0;
function onAppointmentSuggest(payload: ParsedAppointment) {
  appointmentPrefillToken += 1;
  appointmentPrefill.value = {
    date: payload.date,
    matchedPhrase: payload.matchedPhrase,
    token: appointmentPrefillToken,
  };
  showContactPanel.value = true;
}

async function onCreateConversation(params: { accountId: string; contactId: string }) {
  await createConversation(params.accountId, params.contactId);
}

// Resizable panel widths (restored from localStorage)
const leftWidth = ref(parseInt(localStorage.getItem('chat-left-width') || '320'));
const rightWidth = ref(parseInt(localStorage.getItem('chat-right-width') || '320'));

let resizing: 'left' | 'right' | null = null;
let startX = 0;
let startWidth = 0;

function startResize(panel: 'left' | 'right', e: MouseEvent) {
  resizing = panel;
  startX = e.clientX;
  startWidth = panel === 'left' ? leftWidth.value : rightWidth.value;
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResize(e: MouseEvent) {
  if (!resizing) return;
  const diff = e.clientX - startX;
  if (resizing === 'left') {
    leftWidth.value = Math.max(200, Math.min(500, startWidth + diff));
  } else {
    rightWidth.value = Math.max(250, Math.min(500, startWidth - diff));
  }
}

function stopResize() {
  if (resizing) {
    localStorage.setItem('chat-left-width', String(leftWidth.value));
    localStorage.setItem('chat-right-width', String(rightWidth.value));
  }
  resizing = null;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onMounted(() => {
  selfUserId.value = auth.user?.id ?? null;
  selfFullName.value = auth.user?.fullName ?? null;
  fetchConversations();
  fetchConversationCounts();
  fetchPinned();
  initSocket();
});
onUnmounted(() => { destroySocket(); });

// Keep selfUserId in sync if auth profile lands AFTER ChatView mounts
// (e.g. token rehydrate races with route navigation).
watch(() => auth.user, (u) => {
  selfUserId.value = u?.id ?? null;
  selfFullName.value = u?.fullName ?? null;
});

let searchTimeout: ReturnType<typeof setTimeout>;
watch(searchQuery, () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => fetchConversations(), 300);
});
</script>

<style scoped>
.chat-container {
  margin: -12px;
}

.chat-panel-left {
  position: relative;
  flex-shrink: 0;
  min-width: 200px;
  max-width: 500px;
}

.chat-panel-right {
  position: relative;
  flex-shrink: 0;
  min-width: 250px;
  max-width: 500px;
}

/* Resize handle — thin vertical line on the edge */
.resize-handle {
  position: absolute;
  top: 0;
  right: -2px;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background 0.2s;
}

.resize-handle:hover,
.resize-handle:active {
  background: rgba(0, 242, 255, 0.3);
}

.resize-handle-left {
  right: auto;
  left: -2px;
}
</style>
