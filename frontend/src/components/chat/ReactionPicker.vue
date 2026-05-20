<template>
  <!--
    Reaction picker — feature 0021.
    A row of 6 emoji buttons. Emits `pick` with the selected emoji.
    Used in two contexts:
      - Inline next to a message bubble on hover (MessageThread.vue).
      - Standalone reusable picker (could be shown in a menu).
  -->
  <div class="reaction-picker d-flex align-center pa-1 rounded-pill" role="menu" aria-label="Chọn cảm xúc">
    <button
      v-for="emoji in STANDARD_EMOJIS"
      :key="emoji"
      class="reaction-btn"
      type="button"
      :aria-label="`Thả cảm xúc ${emoji}`"
      :title="emojiTitle(emoji)"
      @click.stop="onPick(emoji)"
    >
      {{ emoji }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { STANDARD_EMOJIS } from '@/composables/use-reactions';

const emit = defineEmits<{ pick: [emoji: string] }>();

function onPick(emoji: string) {
  emit('pick', emoji);
}

// Vietnamese tooltip per emoji — matches Zalo native wording.
const TITLES: Record<string, string> = {
  '❤️': 'Yêu thích',
  '👍': 'Thích',
  '😆': 'Haha',
  '😮': 'Wow',
  '😭': 'Buồn',
  '😡': 'Giận',
};
function emojiTitle(emoji: string): string {
  return TITLES[emoji] ?? emoji;
}
</script>

<style scoped>
/* Smax-light theme: subtle surface, no glow effects. */
.reaction-picker {
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  gap: 2px;
  width: max-content;
}
.reaction-btn {
  font-size: 18px;
  line-height: 1;
  padding: 6px 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 999px;
  transition: transform 0.12s ease, background-color 0.12s ease;
}
.reaction-btn:hover {
  transform: scale(1.18);
  background: rgba(0, 0, 0, 0.04);
}
.reaction-btn:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}
</style>
