<template>
  <span
    class="tag-chip"
    :style="chipStyle"
    :title="titleText"
  >
    <span v-if="emoji" class="emoji">{{ emoji }}</span>
    <span class="name">{{ name }}</span>
    <button
      v-if="closable"
      type="button"
      class="close-btn"
      :aria-label="`Bỏ nhãn ${name}`"
      @click.stop="emit('close')"
    >
      <span aria-hidden="true">×</span>
    </button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

/**
 * Compact pill displaying one tag with its color + optional emoji.
 *
 * Smax-light theme renders tags against a light surface, so we use a
 * 15%-alpha tint of the tag color for the fill and the full color for the
 * border + text. Keeps tags readable without overwhelming the page.
 */
const props = withDefaults(
  defineProps<{
    name: string;
    color?: string | null;
    emoji?: string | null;
    closable?: boolean;
    title?: string;
  }>(),
  { color: '#9E9E9E', closable: false },
);

const emit = defineEmits<{ close: [] }>();

const titleText = computed(() => props.title ?? props.name);

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function hexToRgba(hex: string | null | undefined, alpha: number): string {
  const value = hex ?? '';
  if (!HEX_RE.test(value)) return `rgba(158, 158, 158, ${alpha})`;
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darkenForText(hex: string | null | undefined): string {
  const value = hex ?? '';
  if (!HEX_RE.test(value)) return '#5a6478';
  const r = Math.max(0, parseInt(value.slice(1, 3), 16) - 60);
  const g = Math.max(0, parseInt(value.slice(3, 5), 16) - 60);
  const b = Math.max(0, parseInt(value.slice(5, 7), 16) - 60);
  return `rgb(${r}, ${g}, ${b})`;
}

const chipStyle = computed(() => ({
  backgroundColor: hexToRgba(props.color, 0.15),
  borderColor: hexToRgba(props.color, 0.55),
  color: darkenForText(props.color),
}));
</script>

<style scoped>
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.4;
  font-weight: 500;
  border: 1px solid;
  white-space: nowrap;
  max-width: 100%;
}
.emoji {
  font-size: 13px;
  line-height: 1;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  color: inherit;
  font-size: 14px;
  line-height: 1;
  opacity: 0.7;
}
.close-btn:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.08);
}
</style>
