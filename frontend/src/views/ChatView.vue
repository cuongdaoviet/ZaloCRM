<template>
  <div
    class="chat-container d-flex"
    :class="{ 'chat-container--mobile-thread': isMobile && hasSelection }"
    style="height: calc(100vh - 64px);"
  >
    <!-- Conversation list — fixed 320px rail (BR-0001, AC-0001). On mobile
         (< 768px, EC-0003) the rail covers the full screen until a row is
         selected; opening a conversation slides the thread into view. -->
    <div class="chat-panel-left">
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
    </div>

    <!-- Message thread — flexible center.
         Feature 0042: wrapped in .chat-panel-thread so the mobile back bar
         (EC-0003) stacks above the thread. Preserves the Feature 0030 Zalo
         popover handlers (@create-contact-from-zalo / @open-contact). -->
    <div class="chat-panel-thread">
      <!-- Mobile back button — only visible while the thread is in view -->
      <div v-if="isMobile && hasSelection" class="chat-mobile-back-bar">
        <v-btn
          variant="text"
          density="comfortable"
          prepend-icon="mdi-arrow-left"
          @click="onMobileBack"
        >Cuộc trò chuyện</v-btn>
      </div>
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
        style="flex: 1; min-width: 0;"
      />
    </div>

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
      <div class="resize-handle resize-handle-left" @mousedown="startResize($event)" />
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
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
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

// Feature 0042 — fixed 320px rail (BR-0001). Only the right contact panel
// remains user-resizable (keeps message thread comfortable when you have
// long contact notes).
const rightWidth = ref(parseInt(localStorage.getItem('chat-right-width') || '320'));

let resizing = false;
let startX = 0;
let startWidth = 0;

function startResize(e: MouseEvent) {
  resizing = true;
  startX = e.clientX;
  startWidth = rightWidth.value;
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResize(e: MouseEvent) {
  if (!resizing) return;
  const diff = e.clientX - startX;
  // Drag handle is on the LEFT edge of the right panel, so growing the
  // panel means dragging leftward (diff < 0).
  rightWidth.value = Math.max(250, Math.min(500, startWidth - diff));
}

function stopResize() {
  if (resizing) {
    localStorage.setItem('chat-right-width', String(rightWidth.value));
  }
  resizing = false;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

// Feature 0042 — mobile pane switching (EC-0003). Under 768px the rail and
// thread occupy the full screen one at a time. Selecting a row reveals the
// thread; the back button clears the selection to slide back to the list.
const isMobile = ref(false);
const hasSelection = computed(() => selectedConvId.value !== null);

function updateMobile() {
  isMobile.value = typeof window !== 'undefined' && window.innerWidth < 768;
}

function onMobileBack() {
  selectedConvId.value = null;
}

onMounted(() => {
  selfUserId.value = auth.user?.id ?? null;
  selfFullName.value = auth.user?.fullName ?? null;
  fetchConversations();
  fetchConversationCounts();
  fetchPinned();
  initSocket();
  updateMobile();
  window.addEventListener('resize', updateMobile);
});
onUnmounted(() => {
  destroySocket();
  window.removeEventListener('resize', updateMobile);
});

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
  position: relative;
}

/* Feature 0042 — fixed 320px rail (BR-0001 / AC-0001). */
.chat-panel-left {
  position: relative;
  flex-shrink: 0;
  width: 320px;
  border-right: 1px solid var(--smax-grey-200, rgba(0,0,0,0.08));
  background: var(--smax-bg, #ffffff);
}

.chat-panel-thread {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.chat-mobile-back-bar {
  display: none;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--smax-grey-200, rgba(0,0,0,0.08));
  background: var(--smax-bg, #ffffff);
}

.chat-panel-right {
  position: relative;
  flex-shrink: 0;
  min-width: 250px;
  max-width: 500px;
}

/* Resize handle — thin vertical line on the left edge of the right panel */
.resize-handle {
  position: absolute;
  top: 0;
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
  left: -2px;
}

/* Feature 0042 — EC-0003 mobile breakpoint. Below 768px the rail and
   thread fill the full viewport one at a time. The active mode is
   controlled by the `chat-container--mobile-thread` modifier. */
@media (max-width: 767.98px) {
  .chat-panel-left {
    width: 100%;
    border-right: none;
  }
  .chat-panel-thread {
    display: none;
  }
  .chat-panel-right {
    display: none;
  }
  .chat-container--mobile-thread .chat-panel-left {
    display: none;
  }
  .chat-container--mobile-thread .chat-panel-thread {
    display: flex;
    width: 100%;
  }
  .chat-mobile-back-bar {
    display: flex;
  }
}
</style>
