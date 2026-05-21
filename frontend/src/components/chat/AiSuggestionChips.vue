<template>
  <div
    v-if="visible"
    class="ai-suggestion-chips pa-2 d-flex flex-wrap align-center"
    data-testid="ai-suggestion-chips"
  >
    <v-icon size="16" color="primary" class="mr-1">mdi-robot-outline</v-icon>
    <span class="text-caption text-grey mr-2">Gợi ý AI:</span>

    <!-- Loading -->
    <template v-if="state.loading">
      <v-skeleton-loader
        v-for="i in 3"
        :key="`sk-${i}`"
        type="chip"
        class="mr-1 mb-1"
        style="width: 120px"
      />
    </template>

    <!-- Chips -->
    <template v-else-if="state.suggestions.length > 0">
      <v-chip
        v-for="(text, idx) in state.suggestions"
        :key="`s-${idx}`"
        size="small"
        variant="tonal"
        color="primary"
        class="mr-1 mb-1 ai-chip"
        :data-testid="`ai-chip-${idx}`"
        @click="onPick(text)"
      >
        {{ truncate(text) }}
      </v-chip>
      <v-btn
        icon="mdi-refresh"
        size="x-small"
        variant="text"
        density="compact"
        :title="state.fromCache ? 'Tạo gợi ý mới (đang dùng cache)' : 'Tạo gợi ý mới'"
        data-testid="ai-suggest-refresh"
        @click="onRefresh"
      />
    </template>

    <!-- Errors -->
    <template v-else-if="state.errorCode === 'rate_limit_org' || state.errorCode === 'rate_limit_user'">
      <span class="text-caption text-warning">
        Đã đạt giới hạn{{ retrySuffix }}, thử lại sau.
      </span>
    </template>
    <template v-else-if="state.errorCode === 'provider_unavailable'">
      <span class="text-caption text-grey">Gợi ý tạm không khả dụng</span>
      <v-btn
        size="x-small"
        variant="text"
        density="compact"
        class="ml-1"
        @click="onRefresh"
      >Thử lại</v-btn>
    </template>
    <template v-else-if="state.errorCode === 'unknown' && state.errorMessage">
      <span class="text-caption text-grey">{{ state.errorMessage }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Feature 0036 — AI reply suggestion chips.
 *
 * Renders below the composer when:
 *   - The last visible message is from the contact AND
 *   - Within the last 24h.
 *
 * The parent passes those flags through; we don't recompute them here.
 *
 * Click a chip → emit `pick(text)` so MessageThread can fill the composer.
 * Refresh button → force-refetch (skips FE cache, backend may still cache
 * for 5min from server side).
 */
import { computed, onMounted, watch } from 'vue';
import { useAiSuggestions } from '@/composables/use-ai-suggestions';

const props = defineProps<{
  /** Required to fetch + cache against. Falsy → component renders nothing. */
  conversationId: string | null;
  /** BR-0003 gate: only render when the rep should see AI chips. */
  enabled: boolean;
}>();

const emit = defineEmits<{
  (e: 'pick', text: string): void;
}>();

const { state, fetchSuggestions, clear, invalidate } = useAiSuggestions(
  () => props.conversationId,
);

const visible = computed(() => {
  if (!props.enabled || !props.conversationId) return false;
  // Hide entirely on these two states (no chips, no error message).
  if (state.value.errorCode === 'ai_disabled' || state.value.errorCode === 'no_inbound') {
    return false;
  }
  return true;
});

const retrySuffix = computed(() => {
  const s = state.value.retryAfterSec;
  if (!s) return '';
  if (s >= 3600) return ` (≈${Math.ceil(s / 3600)}h)`;
  if (s >= 60) return ` (≈${Math.ceil(s / 60)}p)`;
  return ` (${s}s)`;
});

function truncate(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function onPick(text: string): void {
  emit('pick', text);
}

async function onRefresh(): Promise<void> {
  invalidate();
  await fetchSuggestions({ force: true });
}

onMounted(() => {
  if (props.enabled && props.conversationId) {
    fetchSuggestions();
  }
});

// Re-fetch when conversation changes.
watch(
  () => props.conversationId,
  (next) => {
    clear();
    if (next && props.enabled) {
      fetchSuggestions();
    }
  },
);

// React to enable/disable toggles mid-session.
watch(
  () => props.enabled,
  (next) => {
    if (next && props.conversationId) {
      fetchSuggestions();
    } else if (!next) {
      clear();
    }
  },
);

defineExpose({ refresh: onRefresh });
</script>

<style scoped>
.ai-suggestion-chips {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity, 0.12));
  background: rgba(var(--v-theme-primary), 0.03);
}
.ai-chip {
  cursor: pointer;
}
</style>
