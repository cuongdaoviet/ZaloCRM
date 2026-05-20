<template>
  <!--
    Reaction chips — feature 0021.
    Groups reactions by emoji and shows count. Clicking a chip toggles the
    caller's own reaction for that emoji (re-uses the parent's addOrToggle).
    Counter dedupes by (reactorSource, reactorId) so the rep's self-listen
    Zalo row does not double-count (EC-0004).
  -->
  <div v-if="groups.length > 0" class="reaction-chips d-flex flex-wrap align-center" :class="alignClass">
    <button
      v-for="g in groups"
      :key="g.emoji"
      type="button"
      class="reaction-chip"
      :class="{ 'reaction-chip--mine': g.mine }"
      :title="g.mine ? `Bạn đã thả ${g.emoji}` : `${g.count} người thả ${g.emoji}`"
      :aria-pressed="g.mine ? 'true' : 'false'"
      @click.stop="$emit('toggle', g.emoji)"
    >
      <span class="reaction-chip__emoji">{{ displayEmoji(g.emoji) }}</span>
      <span v-if="g.count > 1" class="reaction-chip__count">{{ g.count }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  groupReactionsForDisplay,
  type MessageReaction,
} from '@/composables/use-reactions';

const props = defineProps<{
  reactions: MessageReaction[];
  selfUserId: string | null;
  zaloAccountUid: string | null;
  /** Affects chip alignment under the bubble. */
  align?: 'left' | 'right';
}>();

defineEmits<{ toggle: [emoji: string] }>();

const groups = computed(() =>
  groupReactionsForDisplay(props.reactions, props.selfUserId, props.zaloAccountUid),
);

const alignClass = computed(() => (props.align === 'right' ? 'justify-end' : 'justify-start'));

/** "custom:7" → "•" fallback (BR-0014 — Phase 1 doesn't render custom emojis). */
function displayEmoji(emoji: string): string {
  if (emoji.startsWith('custom:')) return '•';
  return emoji;
}
</script>

<style scoped>
.reaction-chips {
  gap: 4px;
  margin-top: 4px;
}
.reaction-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 999px;
  /* Smax-light: ~15% opacity surface, no glow. */
  background: rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 13px;
  line-height: 1.2;
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.reaction-chip:hover {
  background: rgba(0, 0, 0, 0.08);
}
.reaction-chip--mine {
  background: rgba(var(--v-theme-primary), 0.15);
  border-color: rgba(var(--v-theme-primary), 0.4);
  color: rgb(var(--v-theme-primary));
}
.reaction-chip__count {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
}
</style>
