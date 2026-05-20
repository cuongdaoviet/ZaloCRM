<template>
  <div class="conversation-list d-flex flex-column" style="width: 100%; border-right: 1px solid var(--border-glow, rgba(0,242,255,0.1)); height: 100%;">
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
          class="py-2"
          :class="{ 'conversation-active': conv.id === selectedId, 'bg-blue-lighten-5': conv.unreadCount > 0 && conv.id !== selectedId }"
        >
          <template #prepend>
            <v-avatar size="40" color="grey-lighten-2">
              <v-icon v-if="conv.threadType === 'group'" icon="mdi-account-group" />
              <v-img v-else-if="conv.contact?.avatarUrl" :src="conv.contact.avatarUrl" />
              <v-icon v-else icon="mdi-account" />
            </v-avatar>
          </template>

          <v-list-item-title class="d-flex align-center">
            <span class="text-truncate" :class="{ 'font-weight-bold': conv.unreadCount > 0 }">
              {{ conv.threadType === 'group' ? (conv.contact?.fullName || 'Nhóm') : (conv.contact?.fullName || 'Unknown') }}
            </span>
            <v-chip v-if="conv.threadType === 'group'" size="x-small" color="info" variant="tonal" class="ml-1">Nhóm</v-chip>
            <v-spacer />
            <span class="text-caption text-grey ml-1">{{ formatTime(conv.lastMessageAt) }}</span>
          </v-list-item-title>

          <v-list-item-subtitle class="d-flex align-center">
            <span class="text-truncate" style="max-width: 200px;" :class="{ 'font-weight-medium': conv.unreadCount > 0 }">
              {{ lastMessagePreview(conv) }}
            </span>
            <v-spacer />
            <v-badge
              v-if="conv.unreadCount > 0"
              :content="conv.unreadCount"
              color="error"
              inline
            />
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
        @contextmenu.prevent="openContextMenu($event, conv)"
        class="py-2 conversation-row"
        :class="{ 'conversation-active': conv.id === selectedId, 'bg-blue-lighten-5': conv.unreadCount > 0 && conv.id !== selectedId }"
      >
        <template #prepend>
          <v-avatar size="40" color="grey-lighten-2">
            <v-icon v-if="conv.threadType === 'group'" icon="mdi-account-group" />
            <v-img v-else-if="conv.contact?.avatarUrl" :src="conv.contact.avatarUrl" />
            <v-icon v-else icon="mdi-account" />
          </v-avatar>
        </template>

        <v-list-item-title class="d-flex align-center">
          <span class="text-truncate" :class="{ 'font-weight-bold': conv.unreadCount > 0 }">
            {{ conv.threadType === 'group' ? (conv.contact?.fullName || 'Nhóm') : (conv.contact?.fullName || 'Unknown') }}
          </span>
          <v-chip v-if="conv.threadType === 'group'" size="x-small" color="info" variant="tonal" class="ml-1">Nhóm</v-chip>
          <v-spacer />
          <span class="text-caption text-grey ml-1">{{ formatTime(conv.lastMessageAt) }}</span>
        </v-list-item-title>

        <v-list-item-subtitle class="d-flex align-center">
          <span class="text-truncate" style="max-width: 200px;" :class="{ 'font-weight-medium': conv.unreadCount > 0 }">
            {{ lastMessagePreview(conv) }}
          </span>
          <v-spacer />
          <v-badge
            v-if="conv.unreadCount > 0"
            :content="conv.unreadCount"
            color="error"
            inline
          />
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

  // Reminder/calendar messages
  if (msg.content) {
    try {
      const p = JSON.parse(msg.content);
      if (p.action === 'msginfo.actionlist' && p.title) {
        return prefix + '📅 ' + p.title.slice(0, 50);
      }
    } catch { /* not JSON */ }
  }

  const text = msg.content || '';
  return prefix + (text.length > 50 ? text.slice(0, 50) + '...' : text);
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
</style>
