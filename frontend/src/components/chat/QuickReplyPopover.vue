<template>
  <div v-if="open && filtered.length > 0" class="quick-reply-popover">
    <div class="popover-header text-caption text-grey">
      Tin mẫu — ↑↓ chọn, Enter chèn, Esc đóng
    </div>
    <div
      v-for="(reply, idx) in filtered"
      :key="reply.id"
      class="popover-item"
      :class="{ active: idx === highlightedIndex }"
      @click="$emit('select', reply)"
      @mouseenter="$emit('hover', idx)"
    >
      <div class="d-flex align-center">
        <span class="shortcut">/{{ reply.shortcut }}</span>
        <v-chip
          v-if="reply.scope === 'org'"
          size="x-small" variant="tonal" color="info" class="ml-2"
        >Toàn org</v-chip>
      </div>
      <div class="text-caption text-truncate content-preview">{{ reply.content }}</div>
    </div>
  </div>
  <div v-else-if="open && query.length > 0" class="quick-reply-popover">
    <div class="popover-empty text-caption text-grey">
      Không tìm thấy tin mẫu khớp "/{{ query }}"
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { QuickReply } from '@/composables/use-quick-replies';

const props = defineProps<{
  open: boolean;
  query: string;
  replies: QuickReply[];
  highlightedIndex: number;
}>();

defineEmits<{ select: [reply: QuickReply]; hover: [index: number] }>();

const filtered = computed(() => {
  const q = props.query.toLowerCase();
  if (!q) return props.replies.slice(0, 8);
  return props.replies.filter((r) => r.shortcut.startsWith(q)).slice(0, 8);
});

defineExpose({ filtered });
</script>

<style scoped>
.quick-reply-popover {
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
.popover-header {
  padding: 6px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  font-style: italic;
}
.popover-empty {
  padding: 12px;
  text-align: center;
}
.popover-item {
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
  transition: background 0.1s;
}
.popover-item:last-child {
  border-bottom: none;
}
.popover-item:hover,
.popover-item.active {
  background: rgba(0, 242, 255, 0.08);
}
.shortcut {
  font-family: ui-monospace, monospace;
  font-weight: 600;
  color: #00B8D4;
}
.content-preview {
  margin-top: 2px;
  opacity: 0.75;
}
</style>
