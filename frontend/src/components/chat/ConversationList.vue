<template>
  <div class="conversation-list d-flex flex-column" style="width: 100%; height: 100%;">
    <!-- New chat button -->
    <div class="pa-2 pb-0">
      <v-btn
        color="primary" block size="small"
        prepend-icon="mdi-message-plus"
        @click="$emit('new-chat')"
      >Chat mới với khách hàng</v-btn>
    </div>
    <!-- Account filter + Search -->
    <div class="pa-2">
      <v-select
        v-model="selectedAccountId"
        :items="accountOptions"
        item-title="text"
        item-value="value"
        label="Tất cả Zalo"
        density="compact"
        variant="solo-filled"
        hide-details
        clearable
        class="mb-2"
        @update:model-value="$emit('filter-account', $event)"
      />
      <v-text-field
        :model-value="search"
        @update:model-value="$emit('update:search', $event)"
        placeholder="Tìm kiếm..."
        prepend-inner-icon="mdi-magnify"
        variant="solo-filled"
        density="compact"
        hide-details
        clearable
      />
    </div>

    <!-- Tab bar (feature 0023): Chính / Khác — each tab has its own unread badge -->
    <v-tabs
      :model-value="activeTab"
      density="compact"
      color="primary"
      grow
      class="conv-tabs"
      @update:model-value="onTabChange"
    >
      <v-tab value="main">
        <span>Chính</span>
        <v-badge
          v-if="(mainUnread ?? 0) > 0"
          :content="mainUnread"
          color="error"
          inline
          class="ml-1"
        />
      </v-tab>
      <v-tab value="other">
        <span>Khác</span>
        <v-badge
          v-if="(otherUnread ?? 0) > 0"
          :content="otherUnread"
          color="error"
          inline
          class="ml-1"
        />
      </v-tab>
    </v-tabs>

    <!-- Filter chip row (feature 0022) -->
    <ConversationFilters
      v-if="filters"
      :filters="filters"
      :has-active-filters="hasActiveFilters ?? false"
      :unread-total="unreadTotal ?? 0"
      :unreplied-total="unrepliedTotal ?? 0"
      @update:state="$emit('update:filters', $event)"
      @reset="$emit('reset-filters')"
    />

    <!-- List -->
    <v-list class="flex-grow-1 overflow-y-auto pa-0" density="compact">
      <v-progress-linear v-if="loading" indeterminate color="primary" />

      <!-- Pinned section (feature 0015) -->
      <template v-if="pinnedConvs.length > 0">
        <v-list-subheader class="text-caption font-weight-medium text-primary px-3 py-1">
          <v-icon size="14" class="mr-1">mdi-pin</v-icon>
          Đã ghim
        </v-list-subheader>
        <v-list-item
          v-for="conv in pinnedConvs"
          :key="`pin-${conv.id}`"
          :active="conv.id === selectedId"
          @click="$emit('select', conv.id)"
          @mouseenter="onRowHover(conv.id)"
          @mouseleave="onRowHoverLeave"
          class="conversation-row"
          :class="{ 'conversation-active': conv.id === selectedId, 'conversation-unread': conv.unreadCount > 0 && conv.id !== selectedId }"
        >
          <template #prepend>
            <div class="conversation-avatar-wrap">
              <v-avatar size="40" color="grey-lighten-2">
                <v-icon v-if="conv.threadType === 'group'" icon="mdi-account-group" />
                <v-img v-else-if="conv.contact?.avatarUrl" :src="conv.contact.avatarUrl" />
                <v-icon v-else icon="mdi-account" />
              </v-avatar>
              <!-- Feature 0042 BR-0003 — unread red dot at top-right of avatar -->
              <span
                v-if="conv.unreadCount > 0"
                class="conversation-unread-badge"
                :aria-label="`${conv.unreadCount} tin chưa đọc`"
              >{{ formatUnreadCount(conv.unreadCount) }}</span>
            </div>
          </template>

          <v-list-item-title class="d-flex align-center">
            <span class="text-truncate" :class="{ 'font-weight-bold': conv.unreadCount > 0 }">
              {{ conv.threadType === 'group' ? (conv.contact?.fullName || 'Nhóm') : (conv.contact?.fullName || 'Unknown') }}
            </span>
            <!-- Feature 0024 — muted Zalo display name when it differs from
                 the CRM fullName (BR-0005). Hidden when same / when no CRM
                 name is set. -->
            <span
              v-if="zaloSecondary(conv) !== null"
              class="text-caption text-grey ml-1 text-truncate zalo-secondary"
              :title="zaloSecondary(conv) || ''"
            >({{ zaloSecondary(conv) }})</span>
            <v-chip v-if="conv.threadType === 'group'" size="x-small" color="info" variant="tonal" class="ml-1">Nhóm</v-chip>
            <v-spacer />
            <span class="text-caption text-grey ml-1">{{ formatTime(conv.lastMessageAt) }}</span>
          </v-list-item-title>

          <v-list-item-subtitle class="d-flex align-center">
            <span class="text-truncate conversation-preview" :class="{ 'font-weight-medium': conv.unreadCount > 0 }">
              {{ lastMessagePreview(conv) }}
            </span>
          </v-list-item-subtitle>

          <template #append>
            <v-btn
              icon size="x-small" variant="text"
              color="primary"
              :title="'Bỏ ghim'"
              @click.stop="$emit('toggle-pin', conv.id)"
            >
              <v-icon size="16">mdi-pin</v-icon>
            </v-btn>
          </template>
        </v-list-item>
        <v-divider class="my-1" />
      </template>

      <v-list-item
        v-for="conv in unpinnedConvs"
        :key="conv.id"
        :active="conv.id === selectedId"
        @click="$emit('select', conv.id)"
        @mouseenter="onRowHover(conv.id)"
        @mouseleave="onRowHoverLeave"
        @contextmenu.prevent="openContextMenu($event, conv)"
        class="conversation-row"
        :class="{ 'conversation-active': conv.id === selectedId, 'conversation-unread': conv.unreadCount > 0 && conv.id !== selectedId }"
      >
        <template #prepend>
          <div class="conversation-avatar-wrap">
            <v-avatar size="40" color="grey-lighten-2">
              <v-icon v-if="conv.threadType === 'group'" icon="mdi-account-group" />
              <v-img v-else-if="conv.contact?.avatarUrl" :src="conv.contact.avatarUrl" />
              <v-icon v-else icon="mdi-account" />
            </v-avatar>
            <!-- Feature 0042 BR-0003 — unread red dot at top-right of avatar -->
            <span
              v-if="conv.unreadCount > 0"
              class="conversation-unread-badge"
              :aria-label="`${conv.unreadCount} tin chưa đọc`"
            >{{ formatUnreadCount(conv.unreadCount) }}</span>
          </div>
        </template>

        <v-list-item-title class="d-flex align-center">
          <span class="text-truncate" :class="{ 'font-weight-bold': conv.unreadCount > 0 }">
            {{ conv.threadType === 'group' ? (conv.contact?.fullName || 'Nhóm') : (conv.contact?.fullName || 'Unknown') }}
          </span>
          <!-- Feature 0024 — muted Zalo display name (BR-0005). -->
          <span
            v-if="zaloSecondary(conv) !== null"
            class="text-caption text-grey ml-1 text-truncate zalo-secondary"
            :title="zaloSecondary(conv) || ''"
          >({{ zaloSecondary(conv) }})</span>
          <v-chip v-if="conv.threadType === 'group'" size="x-small" color="info" variant="tonal" class="ml-1">Nhóm</v-chip>
          <v-spacer />
          <span class="text-caption text-grey ml-1">{{ formatTime(conv.lastMessageAt) }}</span>
        </v-list-item-title>

        <v-list-item-subtitle class="d-flex align-center">
          <span class="text-truncate conversation-preview" :class="{ 'font-weight-medium': conv.unreadCount > 0 }">
            {{ lastMessagePreview(conv) }}
          </span>
        </v-list-item-subtitle>

        <!-- Zalo account indicator + pin button on hover -->
        <template #append>
          <v-btn
            icon size="x-small" variant="text"
            class="conv-pin-btn"
            :title="'Ghim cuộc trò chuyện'"
            @click.stop="$emit('toggle-pin', conv.id)"
          >
            <v-icon size="16">mdi-pin-outline</v-icon>
          </v-btn>
          <span v-if="conv.zaloAccount?.displayName" class="text-caption text-grey-darken-1 ml-1" style="font-size: 0.65rem; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            {{ conv.zaloAccount.displayName }}
          </span>
        </template>
      </v-list-item>

      <div v-if="!loading && conversations.length === 0" class="text-center pa-8 text-grey">
        Chưa có cuộc trò chuyện nào
      </div>
    </v-list>

    <!-- Context menu (feature 0023): right-click a row to hide/restore it -->
    <v-menu
      v-model="contextMenu.show"
      :target="[contextMenu.x, contextMenu.y]"
      :close-on-content-click="true"
    >
      <v-list density="compact">
        <v-list-item
          v-if="contextMenu.conv && (contextMenu.conv.tab ?? 'main') === 'main'"
          prepend-icon="mdi-archive-arrow-down-outline"
          title="Ẩn vào tab Khác"
          @click="onContextMenuArchive('other')"
        />
        <v-list-item
          v-else-if="contextMenu.conv && contextMenu.conv.tab === 'other'"
          prepend-icon="mdi-archive-arrow-up-outline"
          title="Đưa về tab Chính"
          @click="onContextMenuArchive('main')"
        />
      </v-list>
    </v-menu>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type {
  Conversation,
  ConversationFilters as ConvFilters,
  ConversationTab,
} from '@/composables/use-chat';
import ConversationFilters from '@/components/chat/ConversationFilters.vue';
import { api } from '@/api/index';
import { secondaryZaloName } from '@/composables/use-contact-name';

const props = defineProps<{
  conversations: Conversation[];
  selectedId: string | null;
  loading: boolean;
  search: string;
  pinnedIds?: Set<string>;
  /**
   * Ordered list of pinned conversation IDs by `pinnedAt DESC`. When passed,
   * the inline "Đã ghim" section sorts pinned items by pin-time instead of
   * `lastMessageAt` so the most recently-pinned thread floats to the top.
   * Falls back to the parent's list order when omitted.
   */
  pinnedOrder?: string[];
  // Feature 0022 — conversation filters (chip row above the list)
  filters?: ConvFilters;
  hasActiveFilters?: boolean;
  unreadTotal?: number;
  unrepliedTotal?: number;
  // Feature 0023 — per-tab badge counts (sourced from /conversations/counts)
  mainUnread?: number;
  otherUnread?: number;
  /**
   * Feature 0043 — hover prefetch callbacks. The parent owns the cache so
   * we hand off the conversationId on hover and let the composable decide
   * when to actually fire the request (200ms debounce internally).
   */
  onHover?: (conversationId: string) => void;
  onHoverLeave?: () => void;
}>();

const emit = defineEmits<{
  select: [id: string];
  'update:search': [value: string];
  'filter-account': [accountId: string | null];
  'new-chat': [];
  'toggle-pin': [id: string];
  // Feature 0022 — emit the full ConversationFilters object so the parent
  // composable can sync its reactive ref. Parent also receives the
  // 3.0-shape wire payload via the `update:filters` emit from
  // ConversationFilters.vue if it needs it.
  'update:filters': [filters: ConvFilters];
  'reset-filters': [];
  // Feature 0023 — Chính / Khác tab switch.
  'update:tab': [tab: ConversationTab];
  // Feature 0023 — context-menu action: move a single row between tabs.
  'set-conv-tab': [convId: string, tab: ConversationTab];
}>();

// ── Feature 0043 — Hover prefetch (BR-0001) ─────────────────────────────
// Thin pass-through to the composable callbacks supplied by ChatView. The
// 200ms debounce + cache live in use-conversation-prefetch.ts, so this
// component stays dumb about timing.
function onRowHover(convId: string): void {
  props.onHover?.(convId);
}

function onRowHoverLeave(): void {
  props.onHoverLeave?.();
}

// ── Feature 0023 — Tab bar + context menu ───────────────────────────────
const activeTab = computed<ConversationTab>(() => props.filters?.tab ?? 'main');

function onTabChange(value: unknown): void {
  const tab = value === 'other' ? 'other' : 'main';
  emit('update:tab', tab);
}

interface ContextMenuState {
  show: boolean;
  x: number;
  y: number;
  conv: Conversation | null;
}

const contextMenu = ref<ContextMenuState>({
  show: false,
  x: 0,
  y: 0,
  conv: null,
});

function openContextMenu(event: MouseEvent, conv: Conversation): void {
  // Force a fresh menu open so coords update even on consecutive right-clicks.
  contextMenu.value.show = false;
  contextMenu.value.x = event.clientX;
  contextMenu.value.y = event.clientY;
  contextMenu.value.conv = conv;
  // Re-open on the next microtask so v-menu picks up the new target coords.
  void Promise.resolve().then(() => {
    contextMenu.value.show = true;
  });
}

function onContextMenuArchive(tab: ConversationTab): void {
  const conv = contextMenu.value.conv;
  contextMenu.value.show = false;
  if (!conv) return;
  emit('set-conv-tab', conv.id, tab);
}

// Split the incoming list into pinned vs. unpinned. When `pinnedOrder` is
// supplied we sort the pinned slice by it so the section matches the
// dedicated /pinned endpoint's `pinnedAt DESC` ordering (PR #26 follow-up).
const pinnedConvs = computed(() => {
  if (!props.pinnedIds || props.pinnedIds.size === 0) return [];
  const filtered = props.conversations.filter((c) => props.pinnedIds!.has(c.id));
  if (!props.pinnedOrder || props.pinnedOrder.length === 0) return filtered;
  const rank = new Map(props.pinnedOrder.map((id, idx) => [id, idx]));
  return filtered.slice().sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
});

const unpinnedConvs = computed(() => {
  if (!props.pinnedIds || props.pinnedIds.size === 0) return props.conversations;
  return props.conversations.filter((c) => !props.pinnedIds!.has(c.id));
});

const accountOptions = ref<{ text: string; value: string }[]>([]);
const selectedAccountId = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await api.get('/zalo-accounts');
    const accounts = Array.isArray(res.data) ? res.data : res.data.accounts || [];
    accountOptions.value = accounts.map((a: any) => ({
      text: a.displayName || a.zaloUid || a.id,
      value: a.id,
    }));
  } catch {
    // Non-critical — filter just won't show accounts
  }
});

/**
 * Feature 0024 — return the muted Zalo display name to render next to the
 * conversation row's primary name, or null to hide it. See
 * `use-contact-name.ts` for the underlying BR-0005 rule.
 */
function zaloSecondary(conv: Conversation): string | null {
  return secondaryZaloName(conv.contact);
}

function lastMessagePreview(conv: Conversation): string {
  const msg = conv.messages?.[0];
  if (!msg) return '';
  if (msg.isDeleted) return '(đã thu hồi)';
  const prefix = msg.senderType === 'self' ? 'Bạn: ' : '';

  switch (msg.contentType) {
    case 'image': return prefix + '📷 Hình ảnh';
    case 'sticker': return prefix + '🏷️ Sticker';
    case 'video': return prefix + '🎥 Video';
    case 'voice': return prefix + '🎤 Tin nhắn thoại';
    case 'gif': return prefix + 'GIF';
    case 'file': return prefix + '📎 Tệp đính kèm';
    case 'link': return prefix + '🔗 Liên kết';
  }

  // Card / structured-payload messages: Zalo sends some message types as
  // a JSON-stringified payload (reminders, banking cards, group info
  // shares, etc.) where the human-readable label lives in a `title` or
  // `text` field. Without parsing, the raw JSON leaks into the row
  // preview ("{\"title\":\"🍀 Ngân Hàng...\"}") which looks broken.
  // Feature 0049 F5 — handle the generic "JSON payload with a label"
  // case alongside the specific reminder shape.
  if (msg.content && msg.content.trimStart().startsWith('{')) {
    try {
      const p = JSON.parse(msg.content);
      if (p?.action === 'msginfo.actionlist' && p?.title) {
        return prefix + '📅 ' + String(p.title).slice(0, 50);
      }
      // Generic fallback: pull any human-readable label from common
      // fields. Tried in order of how rich the label usually is.
      const label =
        (typeof p?.title === 'string' && p.title) ||
        (typeof p?.text === 'string' && p.text) ||
        (typeof p?.description === 'string' && p.description) ||
        (typeof p?.name === 'string' && p.name) ||
        '';
      if (label) {
        return prefix + label.slice(0, 50);
      }
      // No label found — show a placeholder instead of the raw JSON.
      return prefix + '[Tin nhắn dạng đặc biệt]';
    } catch { /* not JSON after all — fall through to plain text */ }
  }

  const text = msg.content || '';
  return prefix + (text.length > 50 ? text.slice(0, 50) + '...' : text);
}

// Feature 0042 BR-0003 — clamp unread count for the avatar badge.
function formatUnreadCount(n: number): string {
  if (n <= 0) return '';
  if (n > 99) return '99+';
  return String(n);
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Vừa xong';
  if (diffMins < 60) return `${diffMins} phút`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} giờ`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Hôm qua';
  if (diffDays < 7) return `${diffDays} ngày`;

  return date.toLocaleDateString('vi-VN');
}
</script>

<style scoped>
/* Pin button only visible on row hover / focus — keeps the list calm */
.conversation-row .conv-pin-btn {
  opacity: 0;
  transition: opacity 0.15s;
}
.conversation-row:hover .conv-pin-btn,
.conversation-row:focus-within .conv-pin-btn {
  opacity: 1;
}

/* Feature 0023 — tighten the tab bar so it fits the slim Smax-light header. */
.conv-tabs :deep(.v-tab) {
  min-width: 0;
  font-size: 0.85rem;
  letter-spacing: 0;
  text-transform: none;
}

/* Feature 0024 — keep the muted Zalo name from blowing the row width. */
.zalo-secondary {
  max-width: 140px;
}

/* Feature 0042 BR-0002 — 64px compact conversation rows. */
.conversation-row {
  min-height: 64px;
  padding-top: 8px;
  padding-bottom: 8px;
}
.conversation-row :deep(.v-list-item__prepend) {
  padding-right: 12px;
}

/* Feature 0042 BR-0004 — full-row active highlight, not just border. */
.conversation-row.conversation-active {
  background: var(--smax-primary-soft, #e3f2fd);
}
.conversation-row.conversation-active :deep(.v-list-item__overlay) {
  opacity: 0;
}

/* Subtle but visible unread row background (lighter than active). */
.conversation-row.conversation-unread {
  background: rgba(41, 98, 255, 0.04);
}

/* Avatar wrapper anchors the unread red dot (BR-0003). */
.conversation-avatar-wrap {
  position: relative;
  display: inline-flex;
}

/* Feature 0042 BR-0003 — prominent red unread badge on avatar.
   Min size 20px, max content "99+" rendered inside. */
.conversation-unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: var(--smax-error, #ff3d00);
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  border: 2px solid var(--smax-bg, #ffffff);
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  pointer-events: none;
}

.conversation-preview {
  max-width: 220px;
  font-size: 12px;
}
</style>
