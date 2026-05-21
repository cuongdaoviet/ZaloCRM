<template>
  <div v-if="open && members.length > 0" class="mention-picker">
    <div class="picker-header text-caption text-grey">
      Thành viên — ↑↓ chọn, Enter chèn, Esc đóng
    </div>
    <div
      v-for="(member, idx) in members"
      :key="member.uid"
      class="picker-item"
      :class="{ active: idx === highlightedIndex }"
      @click="$emit('select', member)"
      @mouseenter="$emit('hover', idx)"
    >
      <div class="d-flex align-center" style="gap: 8px;">
        <v-avatar size="24" color="grey-lighten-2">
          <v-img v-if="member.avatarUrl" :src="member.avatarUrl" />
          <v-icon v-else size="14" icon="mdi-account" />
        </v-avatar>
        <span class="member-name">{{ member.displayName }}</span>
      </div>
    </div>
  </div>
  <div
    v-else-if="open && query.length > 0"
    class="mention-picker mention-picker--empty"
  >
    <div class="picker-empty text-caption text-grey">
      Không tìm thấy thành viên khớp "@{{ query }}"
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Feature 0026 — MentionPicker dropdown for the chat composer.
 *
 * Pure presentational component: the parent (MessageThread) owns the
 * filtered member list, query string, and highlighted index. The picker
 * emits `select` when the user clicks a row and `hover` when the mouse
 * moves over a row. Keyboard navigation lives in the parent so it shares
 * state with the textarea.
 */
import type { GroupMember } from '@/composables/use-mentions';

defineProps<{
  /** Whether the picker is open. False → render nothing. */
  open: boolean;
  /** Filtered, capped list of members (parent does filterMembers). */
  members: GroupMember[];
  /** Index in `members` that should render as active (keyboard-highlighted). */
  highlightedIndex: number;
  /** Current query (text after the "@"). Used for empty-state copy. */
  query: string;
}>();

defineEmits<{
  select: [member: GroupMember];
  hover: [index: number];
}>();
</script>

<style scoped>
.mention-picker {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 4px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--v-theme-surface, #fff);
  border: 1px solid rgba(0, 242, 255, 0.25);
  border-radius: 8px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.15);
  z-index: 20;
}
.picker-header {
  padding: 6px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  font-style: italic;
}
.picker-empty {
  padding: 12px;
  text-align: center;
}
.picker-item {
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
  transition: background 0.1s;
}
.picker-item:last-child {
  border-bottom: none;
}
.picker-item:hover,
.picker-item.active {
  background: rgba(0, 242, 255, 0.08);
}
.member-name {
  font-weight: 500;
}
</style>
