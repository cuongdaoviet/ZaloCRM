<template>
  <div
    class="message-thread d-flex flex-column flex-grow-1"
    style="height: 100%; position: relative;"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- Drag-over overlay -->
    <div v-if="isDragging" class="drag-overlay">
      <v-icon icon="mdi-cloud-upload-outline" size="64" color="primary" />
      <p class="text-h6 mt-2">Thả file để gửi</p>
    </div>

    <!-- Empty state -->
    <div v-if="!conversation" class="d-flex align-center justify-center flex-grow-1">
      <div class="text-center text-grey">
        <v-icon icon="mdi-chat-outline" size="96" color="grey-lighten-2" />
        <p class="text-h6 mt-4">Chọn cuộc trò chuyện</p>
      </div>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="pa-3 d-flex align-center" style="border-bottom: 1px solid var(--border-glow, rgba(0,242,255,0.1));">
        <v-avatar size="36" color="grey-lighten-2" class="mr-3">
          <v-icon v-if="conversation.threadType === 'group'" icon="mdi-account-group" />
          <v-img v-else-if="conversation.contact?.avatarUrl" :src="conversation.contact.avatarUrl" />
          <v-icon v-else icon="mdi-account" />
        </v-avatar>
        <div class="flex-grow-1">
          <div class="d-flex align-center" style="gap: 6px;">
            <span class="font-weight-medium">{{ conversation.contact?.fullName || 'Unknown' }}</span>
            <!-- Feature 0024 — muted Zalo display name in chat header
                 (BR-0005). Only renders when different from fullName. -->
            <span
              v-if="zaloSecondary !== null"
              class="text-caption text-grey"
              :title="zaloSecondary || ''"
            >({{ zaloSecondary }})</span>
          </div>
          <div class="text-caption text-grey">{{ conversation.zaloAccount?.displayName || 'Zalo' }}</div>
        </div>
        <v-btn
          :icon="isPinned ? 'mdi-pin' : 'mdi-pin-outline'"
          size="small" variant="text"
          :color="isPinned ? 'primary' : undefined"
          :title="isPinned ? 'Bỏ ghim cuộc trò chuyện' : 'Ghim cuộc trò chuyện'"
          @click="$emit('toggle-pin')"
        />
        <v-btn
          :icon="showContactPanel ? 'mdi-account-details' : 'mdi-account-details-outline'"
          size="small" variant="text"
          :color="showContactPanel ? 'primary' : undefined"
          @click="$emit('toggle-contact-panel')"
        />
      </div>

      <!-- Messages -->
      <!--
        Feature 0043 — three render paths for the message body:
          1. cache miss + loading → skeleton bubbles (no blank flash)
          2. long thread (> 100 msgs) → VVirtualScroll, only ~visible rows mount (AC-0003)
          3. short thread → normal v-for (current behaviour)
        All three live inside the same scroll container so scroll-to-bottom
        and scroll-position-preservation logic stays unified.
      -->
      <div
        ref="messagesContainer"
        class="flex-grow-1 overflow-y-auto pa-3 chat-messages-area"
        :class="{ 'thread-fade-in': !loading && messages.length > 0 }"
        @scroll="onThreadScroll"
      >
        <v-progress-linear v-if="loading && messages.length > 0" indeterminate color="primary" class="mb-2" />

        <!-- Cache-miss initial load: show skeleton bubbles -->
        <MessageSkeleton v-if="loading && messages.length === 0" :count="6" />

        <!-- Long thread → virtualized -->
        <v-virtual-scroll
          v-else-if="useVirtual"
          ref="virtualScrollRef"
          :items="messages"
          :item-height="64"
          item-key="id"
          class="virtual-thread"
          data-testid="virtual-message-list"
        >
          <template #default="{ item: msg }">
            <div class="mb-2 d-flex message-row" :class="msg.senderType === 'self' ? 'justify-end' : 'justify-start'">
              <div style="max-width: 70%;">
                <div v-if="conversation.threadType === 'group' && msg.senderType !== 'self'" class="text-caption text-primary font-weight-medium mb-1">
                  {{ msg.senderName || 'Unknown' }}
                </div>
                <div class="bubble-wrapper" :class="msg.senderType === 'self' ? 'bubble-wrapper--self' : 'bubble-wrapper--contact'">
                  <div class="message-bubble pa-2 px-3 rounded-lg" :class="msg.senderType === 'self' ? 'bg-primary text-white' : 'bg-white'" style="word-wrap: break-word;">
                    <div v-if="msg.isDeleted" class="text-decoration-line-through font-italic" style="opacity: 0.6;">
                      {{ msg.content || '(tin nhắn)' }}<span class="text-caption"> (đã thu hồi)</span>
                    </div>
                    <div v-else-if="getImageUrl(msg)">
                      <img :src="getImageUrl(msg)!" alt="Hình ảnh" loading="lazy" class="chat-image" @click="previewImageUrl = getImageUrl(msg)!" />
                    </div>
                    <div v-else-if="getFileInfo(msg)" class="file-card">
                      <v-icon size="20" class="mr-2" color="info">mdi-file-document-outline</v-icon>
                      <div class="flex-grow-1">
                        <div class="text-body-2 font-weight-medium">{{ getFileInfo(msg)!.name }}</div>
                        <div class="text-caption" style="opacity: 0.6;">{{ getFileInfo(msg)!.size }}</div>
                      </div>
                      <v-btn v-if="getFileInfo(msg)!.href" icon size="x-small" variant="text" @click="openFile(getFileInfo(msg)!.href)">
                        <v-icon size="16">mdi-download</v-icon>
                      </v-btn>
                    </div>
                    <div v-else-if="msg.contentType === 'sticker'">🏷️ Sticker</div>
                    <video
                      v-else-if="getVideoInfo(msg)"
                      controls preload="metadata"
                      class="chat-video"
                      :src="getVideoInfo(msg)!.href"
                      :poster="getVideoInfo(msg)!.poster || undefined"
                    />
                    <div v-else-if="msg.contentType === 'video'">🎥 Video</div>
                    <div v-else-if="msg.contentType === 'voice'">🎤 Tin nhắn thoại</div>
                    <div v-else-if="msg.contentType === 'gif'">GIF</div>
                    <!-- Zinstant bank/QR card (feature 0029) — same render
                         path as the short-thread branch below. Tolerant
                         parser; falls back to muted "Thông tin Zalo" chip
                         when payload is unrecognisable (EC-0001). -->
                    <ZinstantCard
                      v-else-if="msg.contentType === 'zinstant' && parsedZinstant(msg)"
                      :data="parsedZinstant(msg)!"
                      @preview="previewImageUrl = $event"
                    />
                    <div
                      v-else-if="msg.contentType === 'zinstant'"
                      class="zinstant-fallback"
                    >
                      <v-icon size="16" class="mr-1">mdi-package-variant-closed</v-icon>
                      Thông tin Zalo
                    </div>
                    <div v-else-if="isReminderMessage(msg)" class="reminder-card">
                      <div class="d-flex align-center mb-1">
                        <v-icon size="16" color="warning" class="mr-1">mdi-calendar-clock</v-icon>
                        <span class="text-caption text-warning font-weight-bold">Nhắc hẹn</span>
                      </div>
                      <div class="text-body-2">{{ getReminderTitle(msg) }}</div>
                      <div v-if="getReminderTime(msg)" class="text-caption mt-1" style="opacity: 0.7;">
                        <v-icon size="12" class="mr-1">mdi-clock-outline</v-icon>{{ getReminderTime(msg) }}
                      </div>
                      <v-btn size="x-small" variant="tonal" color="warning" class="mt-2" prepend-icon="mdi-calendar-sync" @click="syncAppointment(msg)">
                        Đồng bộ lịch
                      </v-btn>
                    </div>
                    <!-- Default text — feature 0026 renders @<uid> tokens as
                         mention chips in group conversations. Mirrors the
                         non-virtualized branch above so AC-0007/0008 still
                         pass in long threads. -->
                    <div v-else class="message-text">
                      <template
                        v-for="(part, partIdx) in renderTextParts(msg)"
                        :key="partIdx"
                      >
                        <span
                          v-if="part.kind === 'mention'"
                          class="mention-chip"
                          :class="{ 'mention-chip--unknown': !part.found }"
                        >@{{ part.displayName }}</span>
                        <template v-else>{{ part.text }}</template>
                      </template>
                    </div>
                    <div class="text-caption mt-1 msg-time" :class="msg.senderType === 'self' ? 'msg-time-self' : 'msg-time-contact'" style="font-size: 0.7rem;">
                      {{ formatMessageTime(msg.sentAt) }}
                    </div>
                  </div>
                </div>
                <ReactionChips
                  v-if="(msg.reactions ?? []).length > 0"
                  :reactions="msg.reactions ?? []"
                  :self-user-id="selfUserId ?? null"
                  :zalo-account-uid="conversation.zaloAccount?.zaloUid ?? null"
                  :align="msg.senderType === 'self' ? 'right' : 'left'"
                  @toggle="onToggleReactionFromChip(msg.id, $event)"
                />
              </div>
            </div>
          </template>
        </v-virtual-scroll>

        <!-- Short thread → original v-for path -->
        <div v-else v-for="msg in messages" :key="msg.id" class="mb-2 d-flex message-row" :class="msg.senderType === 'self' ? 'justify-end' : 'justify-start'">
          <div style="max-width: 70%;">
            <div
              v-if="conversation.threadType === 'group' && msg.senderType !== 'self'"
              class="d-flex align-center mb-1"
            >
              <!-- Feature 0030 — clickable avatar in group chats opens the Zalo user info popover. -->
              <button
                v-if="msg.senderUid"
                type="button"
                class="sender-avatar-btn"
                :title="'Xem thông tin ' + (msg.senderName || 'người dùng')"
                @click.stop="onAvatarClick(msg, $event)"
              >
                <v-icon size="18">mdi-account-circle</v-icon>
              </button>
              <span class="text-caption text-primary font-weight-medium">
                {{ msg.senderName || 'Unknown' }}
              </span>
            </div>
            <!-- Bubble + hover reaction trigger -->
            <div class="bubble-wrapper" :class="msg.senderType === 'self' ? 'bubble-wrapper--self' : 'bubble-wrapper--contact'">
              <div class="message-bubble pa-2 px-3 rounded-lg" :class="msg.senderType === 'self' ? 'bg-primary text-white' : 'bg-white'" style="word-wrap: break-word;">
                <!-- Deleted -->
                <div v-if="msg.isDeleted" class="text-decoration-line-through font-italic" style="opacity: 0.6;">
                  {{ msg.content || '(tin nhắn)' }}<span class="text-caption"> (đã thu hồi)</span>
                </div>
                <!-- Image -->
                <div v-else-if="getImageUrl(msg)">
                  <img :src="getImageUrl(msg)!" alt="Hình ảnh" class="chat-image" @click="previewImageUrl = getImageUrl(msg)!" />
                </div>
                <!-- File/PDF -->
                <div v-else-if="getFileInfo(msg)" class="file-card">
                  <v-icon size="20" class="mr-2" color="info">mdi-file-document-outline</v-icon>
                  <div class="flex-grow-1">
                    <div class="text-body-2 font-weight-medium">{{ getFileInfo(msg)!.name }}</div>
                    <div class="text-caption" style="opacity: 0.6;">{{ getFileInfo(msg)!.size }}</div>
                  </div>
                  <v-btn v-if="getFileInfo(msg)!.href" icon size="x-small" variant="text" @click="openFile(getFileInfo(msg)!.href)">
                    <v-icon size="16">mdi-download</v-icon>
                  </v-btn>
                </div>
                <!-- Sticker/Video/Voice/GIF -->
                <div v-else-if="msg.contentType === 'sticker'">🏷️ Sticker</div>
                <!-- Video (feature 0025) — inline HTML5 player with native
                     controls. User-uploaded Zalo videos don't ship captions,
                     so no <track> elements (Web:S4084 acceptable). -->
                <!-- NOSONAR -->
                <video
                  v-else-if="getVideoInfo(msg)"
                  controls preload="metadata"
                  class="chat-video"
                  :src="getVideoInfo(msg)!.href"
                  :poster="getVideoInfo(msg)!.poster || undefined"
                />
                <div v-else-if="msg.contentType === 'video'">🎥 Video</div>
                <div v-else-if="msg.contentType === 'voice'">🎤 Tin nhắn thoại</div>
                <div v-else-if="msg.contentType === 'gif'">GIF</div>
                <!-- Zinstant bank/QR card (feature 0029) — tolerant parser;
                     falls back to muted "📦 Thông tin Zalo" chip when the
                     payload is unrecognisable (EC-0001). -->
                <ZinstantCard
                  v-else-if="msg.contentType === 'zinstant' && parsedZinstant(msg)"
                  :data="parsedZinstant(msg)!"
                  @preview="previewImageUrl = $event"
                />
                <div
                  v-else-if="msg.contentType === 'zinstant'"
                  class="zinstant-fallback"
                >
                  <v-icon size="16" class="mr-1">mdi-package-variant-closed</v-icon>
                  Thông tin Zalo
                </div>
                <!-- Reminder/Calendar -->
                <div v-else-if="isReminderMessage(msg)" class="reminder-card">
                  <div class="d-flex align-center mb-1">
                    <v-icon size="16" color="warning" class="mr-1">mdi-calendar-clock</v-icon>
                    <span class="text-caption text-warning font-weight-bold">Nhắc hẹn</span>
                  </div>
                  <div class="text-body-2">{{ getReminderTitle(msg) }}</div>
                  <div v-if="getReminderTime(msg)" class="text-caption mt-1" style="opacity: 0.7;">
                    <v-icon size="12" class="mr-1">mdi-clock-outline</v-icon>{{ getReminderTime(msg) }}
                  </div>
                  <v-btn size="x-small" variant="tonal" color="warning" class="mt-2" prepend-icon="mdi-calendar-sync" @click="syncAppointment(msg)">
                    Đồng bộ lịch
                  </v-btn>
                </div>
                <!-- Default text — feature 0026 renders @<uid> tokens as
                     mention chips in group conversations. parseDisplayContent
                     handles JSON-shaped link cards (legacy text path). -->
                <div v-else class="message-text">
                  <template
                    v-for="(part, partIdx) in renderTextParts(msg)"
                    :key="partIdx"
                  >
                    <span
                      v-if="part.kind === 'mention'"
                      class="mention-chip"
                      :class="{ 'mention-chip--unknown': !part.found }"
                    >@{{ part.displayName }}</span>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </div>
                <!-- Timestamp -->
                <div class="text-caption mt-1 msg-time" :class="msg.senderType === 'self' ? 'msg-time-self' : 'msg-time-contact'" style="font-size: 0.7rem;">
                  {{ formatMessageTime(msg.sentAt) }}
                </div>
              </div>
              <!-- Feature 0021 — hover-triggered reaction picker -->
              <!-- Hidden on deleted bubbles; positioned opposite the bubble. -->
              <div
                v-if="canReact && !msg.isDeleted"
                class="reaction-trigger"
                :class="msg.senderType === 'self' ? 'reaction-trigger--self' : 'reaction-trigger--contact'"
              >
                <button
                  type="button"
                  class="reaction-trigger-btn"
                  :aria-label="'Thả cảm xúc cho tin nhắn'"
                  @click.stop="togglePicker(msg.id)"
                >
                  <v-icon size="16">mdi-emoticon-happy-outline</v-icon>
                </button>
                <ReactionPicker
                  v-if="openPickerMsgId === msg.id"
                  class="reaction-picker-popover"
                  :class="msg.senderType === 'self' ? 'reaction-picker-popover--self' : 'reaction-picker-popover--contact'"
                  @pick="onPickReaction(msg.id, $event)"
                />
              </div>
            </div>
            <!-- Feature 0021 — chip stack under bubble -->
            <ReactionChips
              v-if="(msg.reactions ?? []).length > 0"
              :reactions="msg.reactions ?? []"
              :self-user-id="selfUserId ?? null"
              :zalo-account-uid="conversation.zaloAccount?.zaloUid ?? null"
              :align="msg.senderType === 'self' ? 'right' : 'left'"
              @toggle="onToggleReactionFromChip(msg.id, $event)"
            />
          </div>
        </div>
        <div v-if="!loading && messages.length === 0" class="text-center pa-8 text-grey">Chưa có tin nhắn</div>
      </div>

      <!-- Appointment suggestion chip (feature 0017) -->
      <div v-if="appointmentSuggestion && !suggestionDismissed" class="px-2 pt-2">
        <v-chip
          color="primary"
          variant="tonal"
          prepend-icon="mdi-calendar-clock"
          closable
          @click:close="suggestionDismissed = true"
        >
          <span class="text-body-2">
            Gợi ý lịch hẹn: {{ formatSuggestionTime(appointmentSuggestion.date) }}
          </span>
          <v-btn
            size="x-small"
            variant="text"
            class="ml-2"
            color="primary"
            @click.stop="emitAppointmentSuggest"
          >
            Tạo
          </v-btn>
        </v-chip>
      </div>

      <!-- Pending attachment preview -->
      <div v-if="pendingFile" class="pa-2 pb-0">
        <v-card variant="outlined" class="pa-2 d-flex align-center">
          <img v-if="pendingPreviewUrl" :src="pendingPreviewUrl" alt="preview" class="attachment-thumb mr-3" />
          <v-icon v-else size="32" class="mr-3" color="info">mdi-file-document-outline</v-icon>
          <div class="flex-grow-1">
            <div class="text-body-2 font-weight-medium text-truncate" style="max-width: 320px;">{{ pendingFile.name }}</div>
            <div class="text-caption text-grey">{{ formatBytes(pendingFile.size) }}</div>
          </div>
          <v-btn icon size="small" variant="text" @click="clearPending" :disabled="sending">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card>
      </div>

      <!-- Input -->
      <div class="pa-2 d-flex align-end chat-input-area" style="position: relative;">
        <QuickReplyPopover
          ref="popoverRef"
          :open="quickReplyOpen"
          :query="quickReplyQuery"
          :replies="quickReplies"
          :highlighted-index="quickReplyHighlighted"
          @select="applyQuickReply"
          @hover="quickReplyHighlighted = $event"
        />
        <!-- Feature 0026 — mention picker. Mirrors quick-reply popover; only
             active in group conversations (parent gates via groupMembers prop). -->
        <MentionPicker
          :open="mentionOpen"
          :members="mentionFiltered"
          :highlighted-index="mentionHighlighted"
          :query="mentionTriggerQuery"
          @select="applyMention"
          @hover="mentionHighlighted = $event"
        />
        <v-btn
          icon size="small" variant="text" class="mr-1"
          title="Đính kèm ảnh hoặc file"
          :disabled="sending"
          @click="openFilePicker"
        ><v-icon>mdi-paperclip</v-icon></v-btn>
        <input
          ref="fileInputEl"
          type="file"
          :accept="ACCEPTED_TYPES"
          style="display: none"
          @change="onFilePicked"
        />
        <v-textarea
          ref="textareaRef"
          v-model="inputText"
          :placeholder="pendingFile ? 'Thêm ghi chú (tuỳ chọn)...' : 'Nhập tin nhắn... (gõ / để dùng tin mẫu)'"
          variant="solo-filled" density="compact" hide-details auto-grow rows="1" max-rows="3"
          @keydown="onTextareaKeyDown"
          @input="onInputUpdate"
          @click="onCaretMove"
          @keyup="onCaretMove"
          @blur="onComposerBlur"
          class="flex-grow-1 mr-2"
        />
        <v-btn
          icon color="primary"
          :loading="sending"
          :disabled="!inputText.trim() && !pendingFile"
          @click="handleSend"
        ><v-icon>mdi-send</v-icon></v-btn>
      </div>
    </template>

    <!-- Image preview dialog -->
    <v-dialog v-model="showImagePreview" max-width="900" content-class="elevation-0">
      <div class="text-center" @click="showImagePreview = false" style="cursor: pointer;">
        <img :src="previewImageUrl" alt="Preview" style="max-width: 100%; max-height: 85vh; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);" />
        <div class="text-caption mt-2" style="color: #aaa;">Nhấn để đóng</div>
      </div>
    </v-dialog>

    <!-- Sync snackbar -->
    <v-snackbar v-model="syncSnack.show" :color="syncSnack.color" timeout="3000">{{ syncSnack.text }}</v-snackbar>

    <!-- Feature 0030 — Zalo user info popover (group chats) -->
    <UserInfoPopover
      :open="userPopoverOpen"
      :uid="userPopoverUid"
      :account-id="conversation?.zaloAccount?.id ?? null"
      :anchor-el="userPopoverAnchor"
      @close="closeUserPopover"
      @create-contact="onCreateContactFromPopover"
      @open-contact="onOpenContactFromPopover"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue';
import type { Conversation, Message } from '@/composables/use-chat';
import {
  useQuickReplies,
  substitutePlaceholders,
  type QuickReply,
} from '@/composables/use-quick-replies';
import {
  useAppointmentParser,
  type ParsedAppointment,
} from '@/composables/use-appointment-parser';
import { api } from '@/api/index';
import QuickReplyPopover from './QuickReplyPopover.vue';
import ReactionPicker from './ReactionPicker.vue';
import ReactionChips from './ReactionChips.vue';
import MessageSkeleton from './MessageSkeleton.vue';
import ZinstantCard from './ZinstantCard.vue';
import MentionPicker from './MentionPicker.vue';
import { secondaryZaloName } from '@/composables/use-contact-name';
import UserInfoPopover, {
  type CreateContactPayload,
} from './UserInfoPopover.vue';
import { parseZinstant } from '@/utils/parse-zinstant';
import {
  parseMentions,
  detectMentionTrigger,
  filterMembers,
  applyMentionInsert,
  type GroupMember,
  type MentionPart,
  type MentionTrigger,
} from '@/composables/use-mentions';

// Feature 0043 — virtual scroll kicks in past this many messages. Below the
// threshold the v-for path stays so short threads pay no virtualization
// overhead (DOM swap cost, item-height estimate inaccuracy, etc.).
const VIRTUAL_SCROLL_THRESHOLD = 100;

const props = defineProps<{
  conversation: Conversation | null;
  messages: Message[];
  loading: boolean;
  sending: boolean;
  showContactPanel?: boolean;
  isPinned?: boolean;
  /** Feature 0021 — current user id (used for "is this mine" + optimistic stub). */
  selfUserId?: string | null;
  /**
   * Feature 0021 — caller-provided handler. The parent owns the optimistic
   * state on `messages`; MessageThread just dispatches user intent. When
   * absent, the picker is hidden (read-only viewers).
   */
  onReact?: (messageId: string, emoji: string) => void;
  /**
   * Feature 0026 — group member roster for mention chip render + composer
   * picker. Empty array (or non-group conversation) disables auto-complete
   * and renders raw uid fallback for any @<uid> tokens in messages.
   */
  groupMembers?: GroupMember[];
}>();

const emit = defineEmits<{
  send: [content: string];
  'send-attachment': [file: File];
  'toggle-contact-panel': [];
  'toggle-pin': [];
  'appointment-suggest': [payload: ParsedAppointment];
  react: [messageId: string, emoji: string];
  /** Feature 0030 — user clicked "Tạo Contact" inside the Zalo user popover. */
  'create-contact-from-zalo': [payload: CreateContactPayload];
  /** Feature 0030 — user clicked "Xem trong CRM" inside the popover. */
  'open-contact': [contactId: string];
}>();

// ── Feature 0030 — Zalo user info popover state ─────────────────────────────
const userPopoverOpen = ref(false);
const userPopoverUid = ref<string | null>(null);
const userPopoverAnchor = ref<HTMLElement | null>(null);

function onAvatarClick(msg: Message, evt: MouseEvent) {
  // BR-0003 — never open the popover for the rep's own avatar.
  if (msg.senderType === 'self') return;
  if (!msg.senderUid) return;
  userPopoverUid.value = msg.senderUid;
  userPopoverAnchor.value = (evt.currentTarget as HTMLElement) ?? null;
  userPopoverOpen.value = true;
}

function closeUserPopover() {
  userPopoverOpen.value = false;
  userPopoverUid.value = null;
  userPopoverAnchor.value = null;
}

function onCreateContactFromPopover(payload: CreateContactPayload) {
  emit('create-contact-from-zalo', payload);
  closeUserPopover();
}

function onOpenContactFromPopover(contactId: string) {
  emit('open-contact', contactId);
  closeUserPopover();
}

// ── Feature 0021 — reaction picker state ─────────────────────────────────────
const openPickerMsgId = ref<string | null>(null);
const canReact = computed(() => !!props.selfUserId);

// Feature 0024 — muted Zalo display name shown next to the CRM name in the
// chat header (BR-0005). Null when fullName/zaloDisplayName are the same
// (case-insensitive) or zaloDisplayName is empty.
const zaloSecondary = computed<string | null>(() =>
  secondaryZaloName(props.conversation?.contact ?? null),
);

function togglePicker(messageId: string) {
  openPickerMsgId.value = openPickerMsgId.value === messageId ? null : messageId;
}

function onPickReaction(messageId: string, emoji: string) {
  openPickerMsgId.value = null;
  dispatchReaction(messageId, emoji);
}

function onToggleReactionFromChip(messageId: string, emoji: string) {
  dispatchReaction(messageId, emoji);
}

function dispatchReaction(messageId: string, emoji: string) {
  if (props.onReact) props.onReact(messageId, emoji);
  emit('react', messageId, emoji);
}

// Dismiss the picker on any outside click. Capture-phase so we close BEFORE
// the page re-renders on the click target itself.
function closePickerOnOutsideClick(e: MouseEvent) {
  if (!openPickerMsgId.value) return;
  const target = e.target as HTMLElement | null;
  if (target && target.closest('.reaction-trigger')) return;
  openPickerMsgId.value = null;
}
onMounted(() => window.addEventListener('click', closePickerOnOutsideClick, true));
onBeforeUnmount(() => window.removeEventListener('click', closePickerOnOutsideClick, true));

const inputText = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
// Feature 0043 — VVirtualScroll instance ref. We use it to call
// scrollToIndex when new messages arrive in virtualized mode (the parent
// scroll container's scrollHeight trick doesn't apply once rows are
// windowed).
interface VirtualScrollInstance {
  scrollToIndex: (index: number) => void;
}
const virtualScrollRef = ref<VirtualScrollInstance | null>(null);

/**
 * Feature 0043 — derive whether to render the virtualized list. We gate
 * on length only (not loading) so the v-for path keeps short threads
 * lightweight. AC-0003: with 500+ messages this flips to true.
 */
const useVirtual = computed<boolean>(
  () => props.messages.length > VIRTUAL_SCROLL_THRESHOLD,
);

/**
 * Feature 0043 — track whether the user is parked near the bottom. When
 * true (default), incoming messages auto-scroll to bottom (EC-0002).
 * When false (user has scrolled up to read history), we keep scroll
 * position so new messages don't yank the viewport.
 */
const stickToBottom = ref(true);
const SCROLL_BOTTOM_TOLERANCE_PX = 80;

function onThreadScroll(): void {
  const el = messagesContainer.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  stickToBottom.value = distanceFromBottom <= SCROLL_BOTTOM_TOLERANCE_PX;
}
const previewImageUrl = ref('');
const showImagePreview = computed({ get: () => !!previewImageUrl.value, set: (v) => { if (!v) previewImageUrl.value = ''; } });
const syncSnack = ref({ show: false, text: '', color: 'success' });

// ── Attachment upload state (feature 0003) ───────────────────────────────────
const ACCEPTED_TYPES =
  'image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,application/zip';
const ACCEPTED_TYPES_SET = new Set(ACCEPTED_TYPES.split(','));
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const fileInputEl = ref<HTMLInputElement | null>(null);
const pendingFile = ref<File | null>(null);
const pendingPreviewUrl = ref<string | null>(null);
const isDragging = ref(false);
let dragDepth = 0;

function openFilePicker() {
  fileInputEl.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) acceptFile(f);
  input.value = ''; // reset so picking the same file twice still fires
}

function acceptFile(file: File) {
  if (!ACCEPTED_TYPES_SET.has(file.type)) {
    syncSnack.value = { show: true, text: `Không hỗ trợ loại tệp: ${file.type || 'unknown'}`, color: 'error' };
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    syncSnack.value = { show: true, text: 'File quá lớn (tối đa 20MB)', color: 'error' };
    return;
  }
  pendingFile.value = file;
  if (pendingPreviewUrl.value) URL.revokeObjectURL(pendingPreviewUrl.value);
  pendingPreviewUrl.value = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
}

function clearPending() {
  if (pendingPreviewUrl.value) URL.revokeObjectURL(pendingPreviewUrl.value);
  pendingFile.value = null;
  pendingPreviewUrl.value = null;
}

function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  isDragging.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) isDragging.value = false;
}
function onDrop(e: DragEvent) {
  dragDepth = 0;
  isDragging.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) acceptFile(f);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function handleSend() {
  // Guard against double-fire while a previous send is still in flight
  if (props.sending) return;
  // Attachment path takes precedence — text caption can be sent separately afterwards
  if (pendingFile.value) {
    emit('send-attachment', pendingFile.value);
    clearPending();
    return;
  }
  if (!inputText.value.trim()) return;
  emit('send', inputText.value);
  inputText.value = '';
}

// ── Quick replies (feature 0004) ─────────────────────────────────────────────
const { replies: quickReplies, fetchReplies } = useQuickReplies();
const popoverRef = ref<{ filtered: QuickReply[] } | null>(null);
const quickReplyOpen = ref(false);
const quickReplyQuery = ref('');
const quickReplyHighlighted = ref(0);

onMounted(() => fetchReplies());

/**
 * Detect a slash command at the cursor: the input must end with `/<word>`
 * where `<word>` is at the very start of input OR immediately follows a
 * whitespace character. This avoids triggering inside words like `bạn/chị`.
 */
function detectSlashCommand(value: string): string | null {
  // Pull the last "word" — characters since the last space or start of string
  const lastSpaceIdx = Math.max(value.lastIndexOf(' '), value.lastIndexOf('\n'));
  const lastWord = value.slice(lastSpaceIdx + 1);
  if (!lastWord.startsWith('/')) return null;
  const query = lastWord.slice(1);
  // Limit query length so we don't keep popover open forever
  if (query.length > 30) return null;
  return query;
}

function onInputUpdate() {
  const q = detectSlashCommand(inputText.value);
  if (q === null) {
    quickReplyOpen.value = false;
  } else {
    quickReplyOpen.value = true;
    quickReplyQuery.value = q;
    quickReplyHighlighted.value = 0;
  }
  // Feature 0026 — refresh mention picker state on every input. Caret may
  // not have moved yet (input fires before selectionchange) so we re-read
  // the native textarea on the next tick.
  void nextTick(() => refreshMentionTrigger());
}

function onTextareaKeyDown(e: KeyboardEvent) {
  // Vietnamese IME (and other composition-based IMEs) fires a final Enter
  // keydown when committing a candidate. isComposing=true means the user is
  // still composing — pressing Enter at that moment must not send.
  if (e.isComposing || e.keyCode === 229) return;

  // Feature 0026 — mention picker keyboard handling takes precedence over
  // quick-reply and the default Enter→send. Only active when both a trigger
  // is detected AND we have a non-empty filtered member list.
  if (mentionOpen.value) {
    const memberItems = mentionFiltered.value;
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionTrigger.value = null;
      return;
    }
    if (memberItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionHighlighted.value =
          (mentionHighlighted.value + 1) % memberItems.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionHighlighted.value =
          (mentionHighlighted.value - 1 + memberItems.length) % memberItems.length;
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void applyMention(memberItems[mentionHighlighted.value]);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        void applyMention(memberItems[mentionHighlighted.value]);
        return;
      }
    }
  }

  if (!quickReplyOpen.value) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    return;
  }
  const items = popoverRef.value?.filtered ?? [];
  if (items.length === 0) {
    if (e.key === 'Escape') {
      e.preventDefault();
      quickReplyOpen.value = false;
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    quickReplyHighlighted.value = (quickReplyHighlighted.value + 1) % items.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    quickReplyHighlighted.value = (quickReplyHighlighted.value - 1 + items.length) % items.length;
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    applyQuickReply(items[quickReplyHighlighted.value]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    quickReplyOpen.value = false;
  } else if (e.key === 'Tab') {
    e.preventDefault();
    applyQuickReply(items[quickReplyHighlighted.value]);
  }
}

function applyQuickReply(reply: QuickReply) {
  const text = inputText.value;
  // Replace the trailing /<query> with the resolved content
  const lastSpaceIdx = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'));
  const prefix = text.slice(0, lastSpaceIdx + 1);
  const resolved = substitutePlaceholders(reply.content, props.conversation?.contact);
  inputText.value = prefix + resolved;
  quickReplyOpen.value = false;
}
function formatMessageTime(d: string) { return new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); }
function openFile(url: string) { window.open(url, '_blank'); }

/** Extract image URL from JSON content */
function getImageUrl(msg: Message): string | null {
  if (msg.contentType === 'image' && msg.content) {
    if (msg.content.startsWith('http')) return msg.content;
    try { const p = JSON.parse(msg.content); return p.href || p.thumb || p.hdUrl || null; } catch {}
  }
  if (msg.content?.startsWith('{')) {
    try {
      const p = JSON.parse(msg.content);
      const href = p.href || p.thumb || '';
      if (href && /\.(jpg|jpeg|png|webp|gif)/i.test(href)) return href;
      if (href && href.includes('zdn.vn') && !p.params?.includes('fileExt')) return href;
    } catch {}
  }
  return null;
}

/** Extract file info from JSON content (PDF, docs, etc.) */
function getFileInfo(msg: Message): { name: string; size: string; href: string } | null {
  if (!msg.content?.startsWith('{')) return null;
  try {
    const p = JSON.parse(msg.content);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    if (params?.fileExt || params?.fType === 1) {
      const bytes = parseInt(params.fileSize || '0');
      const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
      return { name: p.title || `file.${params.fileExt || 'unknown'}`, size, href: p.href || '' };
    }
  } catch {}
  return null;
}

/**
 * Extract video URL from a video message (feature 0025).
 * Zalo video messages come in as JSON content with `href` for the playable
 * mp4 and an optional `thumb` for the poster image. Returns null if we
 * can't find a usable URL — caller falls through to the "🎥 Video" text
 * placeholder.
 */
function getVideoInfo(
  msg: Message,
): { href: string; poster: string | null } | null {
  if (msg.contentType !== 'video') return null;
  if (!msg.content) return null;
  // Plain URL form (rare but possible)
  if (msg.content.startsWith('http')) {
    return { href: msg.content, poster: null };
  }
  if (!msg.content.startsWith('{')) return null;
  try {
    const p = JSON.parse(msg.content);
    const href = p.hdUrl || p.href || '';
    if (!href || !href.startsWith('http')) return null;
    const poster = typeof p.thumb === 'string' && p.thumb.startsWith('http') ? p.thumb : null;
    return { href, poster };
  } catch {
    return null;
  }
}

/**
 * Feature 0029 — memoised per-message zinstant parse. Computed inside
 * `parsedZinstant(msg)` so we don't re-JSON.parse the same payload on
 * every re-render. Returns null when the payload isn't extractable
 * (caller falls through to the generic "📦 Thông tin Zalo" chip).
 */
const zinstantCache = new Map<string, ReturnType<typeof parseZinstant>>();
function parsedZinstant(msg: Message): ReturnType<typeof parseZinstant> {
  if (msg.contentType !== 'zinstant') return null;
  if (!msg.content) return null;
  const cached = zinstantCache.get(msg.id);
  if (cached !== undefined) return cached;
  const parsed = parseZinstant(msg.content);
  zinstantCache.set(msg.id, parsed);
  return parsed;
}

function parseDisplayContent(content: string | null): string {
  if (!content) return '';
  if (!content.startsWith('{')) return content;
  try {
    const p = JSON.parse(content);
    if (p.title && p.href) return `🔗 ${p.title}`;
    if (p.title) return p.title;
    if (p.href) return `🔗 ${p.description || p.href}`;
    return content;
  } catch { return content; }
}

// ── Feature 0026 — mention chip render ───────────────────────────────────
/**
 * Build a per-uid member map (lazily memoized by the groupMembers prop)
 * for parseMentions. Recomputes when the prop array reference changes.
 */
const groupMemberMap = computed<Map<string, GroupMember>>(() => {
  const list = props.groupMembers ?? [];
  return new Map(list.map((m) => [m.uid, m]));
});

/**
 * Resolve the parts to render for a message bubble.
 *
 * - Group conversation with text content → parseMentions splits the string.
 * - Anywhere else → single text part with the legacy parseDisplayContent
 *   transformation (handles JSON link cards). BR-0003 — never parse mentions
 *   in user-to-user conversations.
 */
function renderTextParts(msg: Message): MentionPart[] {
  const isGroup = props.conversation?.threadType === 'group';
  const raw = msg.content ?? '';
  if (!isGroup) {
    return [{ kind: 'text', text: parseDisplayContent(msg.content) }];
  }
  // JSON-shaped content (link card, reminder fallthrough) → keep legacy
  // single-string render. Mentions are only meaningful in plain text.
  if (raw.startsWith('{')) {
    return [{ kind: 'text', text: parseDisplayContent(msg.content) }];
  }
  return parseMentions(raw, groupMemberMap.value);
}

// ── Feature 0026 — mention picker state (composer) ───────────────────────
const textareaRef = ref<{ $el?: HTMLElement } | null>(null);
const mentionTrigger = ref<MentionTrigger | null>(null);
const mentionHighlighted = ref(0);

const mentionOpen = computed<boolean>(() => {
  if (!mentionTrigger.value) return false;
  // BR-0003 — only group conversations expose the picker.
  if (props.conversation?.threadType !== 'group') return false;
  return (props.groupMembers?.length ?? 0) > 0;
});

const mentionTriggerQuery = computed<string>(
  () => mentionTrigger.value?.query ?? '',
);

const mentionFiltered = computed<GroupMember[]>(() => {
  if (!mentionOpen.value) return [];
  return filterMembers(props.groupMembers ?? [], mentionTriggerQuery.value);
});

/**
 * Resolve the inner <textarea> element from the v-textarea ref.
 * Vuetify wraps the native input — we drill into $el to read caret.
 */
function getNativeTextarea(): HTMLTextAreaElement | null {
  const root = textareaRef.value?.$el;
  if (!root) return null;
  return root.querySelector('textarea');
}

/**
 * Recompute the mention trigger from the current input + caret position.
 * Closes the picker when no trigger is active so the textarea behaves
 * normally outside `@`-tokens.
 */
function refreshMentionTrigger(): void {
  if (props.conversation?.threadType !== 'group') {
    mentionTrigger.value = null;
    return;
  }
  const native = getNativeTextarea();
  const caret = native?.selectionStart ?? inputText.value.length;
  const next = detectMentionTrigger(inputText.value, caret);
  mentionTrigger.value = next;
  // Reset highlight whenever the active trigger changes (different @-token
  // or first time we open). Don't reset on every keystroke inside the same
  // trigger — that would clobber ↑/↓ navigation.
  if (next === null) {
    mentionHighlighted.value = 0;
  } else if (mentionHighlighted.value >= mentionFiltered.value.length) {
    mentionHighlighted.value = 0;
  }
}

function onCaretMove() {
  refreshMentionTrigger();
}

function onComposerBlur() {
  // Close after a tick so click-on-picker still fires its @select handler.
  setTimeout(() => {
    mentionTrigger.value = null;
  }, 120);
}

/** Apply the selected member: splice "@<uid> " into input, restore caret. */
async function applyMention(member: GroupMember) {
  if (!mentionTrigger.value) return;
  const { value, caret } = applyMentionInsert(
    inputText.value,
    mentionTrigger.value,
    member,
  );
  inputText.value = value;
  mentionTrigger.value = null;
  mentionHighlighted.value = 0;
  await nextTick();
  const native = getNativeTextarea();
  if (native) {
    native.focus();
    native.setSelectionRange(caret, caret);
  }
}

function isReminderMessage(msg: Message): boolean {
  if (!msg.content) return false;
  try { const p = JSON.parse(msg.content); return p.action === 'msginfo.actionlist'; } catch { return false; }
}

function getReminderTitle(msg: Message): string {
  try { return JSON.parse(msg.content!).title || ''; } catch { return msg.content || ''; }
}

function getReminderTime(msg: Message): string | null {
  try {
    const p = JSON.parse(msg.content!);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    for (const h of (params?.highLightsV2 || [])) {
      if (h.ts > 1e12) return new Date(h.ts).toLocaleString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  } catch {}
  return null;
}

/** Sync Zalo reminder to CRM appointments via API */
async function syncAppointment(msg: Message) {
  if (!props.conversation?.contact?.id) { syncSnack.value = { show: true, text: 'Không có thông tin khách hàng', color: 'error' }; return; }
  try {
    const p = JSON.parse(msg.content!);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    let appointmentDate: string | null = null;
    for (const h of (params?.highLightsV2 || [])) {
      if (h.ts > 1e12) { appointmentDate = new Date(h.ts).toISOString(); break; }
    }
    if (!appointmentDate) { syncSnack.value = { show: true, text: 'Không tìm thấy thời gian hẹn', color: 'warning' }; return; }
    await api.post('/appointments', {
      contactId: props.conversation.contact.id,
      appointmentDate,
      appointmentTime: new Date(appointmentDate).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      type: 'tai_kham',
      notes: `[Zalo] ${p.title || ''}`,
    });
    syncSnack.value = { show: true, text: 'Đã đồng bộ lịch hẹn thành công!', color: 'success' };
  } catch (err: any) {
    syncSnack.value = { show: true, text: err.response?.data?.error || 'Đồng bộ thất bại', color: 'error' };
  }
}

/**
 * Feature 0043 — scroll-to-bottom is now branched by render mode AND by
 * stickToBottom (EC-0005). Original behaviour was unconditional snap which
 * yanked the viewport when an inbound message arrived while the user was
 * scrolled up reading history. Now we only snap when the user is already
 * pinned to the bottom; otherwise we leave scroll alone.
 */
watch(() => props.messages.length, async (newLen, oldLen) => {
  await nextTick();
  // New conversation (len went from 0 → N) → always land at bottom and
  // restore stickToBottom so subsequent inbound messages auto-scroll.
  const isInitialLoad = (oldLen ?? 0) === 0 && newLen > 0;
  if (isInitialLoad) stickToBottom.value = true;
  if (!stickToBottom.value && !isInitialLoad) return;

  if (useVirtual.value && virtualScrollRef.value) {
    // VVirtualScroll's scrollToIndex windows to the row, which is the only
    // reliable way to land at the bottom once rows are virtualized.
    virtualScrollRef.value.scrollToIndex(newLen - 1);
  } else if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }

  // Feature 0043 perf measurement — pair with the `conv-click` mark set in
  // selectConversation. Only logs in dev, only when both marks exist.
  if (import.meta.env?.DEV && typeof performance !== 'undefined') {
    try {
      const clickEntry = performance.getEntriesByName('conv-click').pop();
      if (clickEntry) {
        performance.mark('thread-rendered');
        const delta = performance.now() - clickEntry.startTime;
        // eslint-disable-next-line no-console
        console.debug(`[perf 0043] conv switch render: ${delta.toFixed(1)}ms`);
        performance.clearMarks('conv-click');
        performance.clearMarks('thread-rendered');
      }
    } catch { /* perf API quirks — non-fatal */ }
  }
});

// Reset stickToBottom whenever the conversation changes so the new thread
// always lands pinned to the bottom regardless of how the previous one
// was scrolled. Use conversation.id (not messages identity) to detect.
watch(() => props.conversation?.id, () => {
  stickToBottom.value = true;
});

// ── Appointment suggestion (feature 0017) ─────────────────────────────────────
const { parseLatestIncoming } = useAppointmentParser();
const appointmentSuggestion = ref<ParsedAppointment | null>(null);
const suggestionDismissed = ref(false);
let lastSuggestedPhrase: string | null = null;

async function refreshAppointmentSuggestion() {
  // Skip parser when nothing to parse — avoid useless calls during empty
  // states (e.g. before a conversation is opened).
  if (!props.messages?.length) {
    appointmentSuggestion.value = null;
    lastSuggestedPhrase = null;
    return;
  }
  const parsed = await parseLatestIncoming(props.messages);
  appointmentSuggestion.value = parsed;
  // A genuinely new suggestion → clear the dismissed flag so the user sees it.
  if (parsed && parsed.matchedPhrase !== lastSuggestedPhrase) {
    lastSuggestedPhrase = parsed.matchedPhrase;
    suggestionDismissed.value = false;
  }
}

watch(
  () => props.messages.map((m) => m.id).join(','),
  () => { refreshAppointmentSuggestion(); },
);

function formatSuggestionTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mm}, ${day}/${mon}`;
}

function emitAppointmentSuggest() {
  if (!appointmentSuggestion.value) return;
  emit('appointment-suggest', appointmentSuggestion.value);
  suggestionDismissed.value = true;
}
</script>

<style scoped>
/* Feature 0030 — clickable sender avatar in group messages. */
.sender-avatar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(var(--v-theme-primary), 0.12);
  border: none;
  cursor: pointer;
  color: rgb(var(--v-theme-primary));
  transition: background 0.15s ease;
  padding: 0;
}
.sender-avatar-btn:hover { background: rgba(var(--v-theme-primary), 0.24); }
.sender-avatar-btn:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.message-bubble { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); }
.reminder-card { padding: 8px 12px; border-left: 3px solid rgb(var(--v-theme-warning)); border-radius: 8px; background: rgba(var(--v-theme-warning), 0.08); }
.file-card { display: flex; align-items: center; padding: 8px 12px; border-radius: 8px; background: rgba(0, 242, 255, 0.05); border: 1px solid rgba(0, 242, 255, 0.1); }
.zinstant-fallback { display: inline-flex; align-items: center; opacity: 0.65; font-style: italic; font-size: 0.85rem; }
.chat-image { max-width: 100%; max-height: 300px; border-radius: 12px; cursor: pointer; transition: transform 0.2s; }
.chat-image:hover { transform: scale(1.02); }
.chat-video { max-width: 100%; max-height: 360px; border-radius: 12px; background: #000; display: block; }
.attachment-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
}
.drag-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(0, 242, 255, 0.12);
  border: 2px dashed rgba(0, 242, 255, 0.55);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: rgb(var(--v-theme-primary));
}

/* ── Feature 0021 — reaction picker affordance ─────────────────────────── */
.bubble-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.bubble-wrapper--self { flex-direction: row-reverse; }

/* The hover trigger lives next to the bubble; hidden by default, fades in
   when the row is hovered. Doesn't shift bubble layout. */
.reaction-trigger {
  position: relative;
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.15s ease;
  margin: 0 6px;
}
.message-row:hover .reaction-trigger,
.reaction-trigger:focus-within {
  opacity: 1;
}
.reaction-trigger-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.92);
  border-radius: 999px;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.6);
  transition: background-color 0.12s ease, color 0.12s ease;
}
.reaction-trigger-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: rgba(0, 0, 0, 0.85);
}
/* Picker popover floats above and to the side of the trigger. */
.reaction-picker-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  z-index: 20;
}
.reaction-picker-popover--contact { left: 0; }
.reaction-picker-popover--self    { right: 0; }

/* ── Feature 0043 — message body transition + virtual scroll sizing ──── */
.thread-fade-in {
  /* Subtle fade so the cached-render case doesn't look stuttery when it
     swaps the skeleton out. Honors reduced-motion preference. */
  animation: thread-fade 180ms ease-out;
}
@keyframes thread-fade {
  from { opacity: 0.4; }
  to   { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .thread-fade-in { animation: none; }
}
.virtual-thread {
  /* VVirtualScroll needs an explicit height; fill its scrolling parent. */
  height: 100%;
}

/* ── Feature 0026 — mention chip render inside message bubble ──────────── */
.message-text {
  white-space: pre-wrap;
  word-wrap: break-word;
}
.mention-chip {
  display: inline-block;
  padding: 0 4px;
  margin: 0 1px;
  border-radius: 4px;
  background: rgba(0, 242, 255, 0.18);
  color: rgb(var(--v-theme-primary));
  font-weight: 500;
}
/* Fallback when the mentioned uid is not in the group member roster (left
   the group, deleted, etc.) — render muted so the reader knows it's an
   unresolved reference. See SPEC BR-0002 / EC-0001..EC-0002. */
.mention-chip--unknown {
  background: rgba(0, 0, 0, 0.05);
  color: rgba(0, 0, 0, 0.55);
  font-weight: normal;
}
/* Inside a self-bubble (white text on coloured bg) we need higher contrast. */
.bg-primary .mention-chip {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}
.bg-primary .mention-chip--unknown {
  background: rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.75);
}
</style>
