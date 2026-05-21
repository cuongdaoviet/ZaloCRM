<template>
  <!--
    Feature 0043 — placeholder bubbles shown during initial cache-miss load.
    Stagger sides so the skeleton looks like a real thread instead of a wall
    of identical strips. Pure CSS shimmer (no JS) so it stays cheap.
  -->
  <div class="skeleton-thread" data-testid="message-skeleton">
    <div
      v-for="i in count"
      :key="i"
      class="skeleton-row d-flex mb-2"
      :class="i % 2 === 0 ? 'justify-end' : 'justify-start'"
    >
      <div
        class="skeleton-bubble shimmer"
        :style="{ width: bubbleWidth(i) + 'px' }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Feature 0043 — Strategy 3 (optimistic state). Renders N greyed-out
 * bubble placeholders so the message pane never goes blank during the
 * first network fetch. Width varies row-to-row so the eye doesn't lock
 * onto a uniform grid.
 */
withDefaults(
  defineProps<{
    /** Number of placeholder bubbles to render. */
    count?: number;
  }>(),
  { count: 6 },
);

function bubbleWidth(seed: number): number {
  // Deterministic widths driven off the row index so SSR / hydration
  // doesn't see a flicker. Range 120–280 covers short / long bubble looks.
  const widths = [180, 240, 140, 220, 160, 280, 200, 120];
  return widths[(seed - 1) % widths.length];
}
</script>

<style scoped>
.skeleton-thread {
  padding: 8px 4px;
}
.skeleton-bubble {
  height: 32px;
  border-radius: 14px;
  background: linear-gradient(
    90deg,
    rgba(0, 0, 0, 0.06) 0%,
    rgba(0, 0, 0, 0.12) 50%,
    rgba(0, 0, 0, 0.06) 100%
  );
  background-size: 200% 100%;
}
.shimmer {
  animation: skeleton-shimmer 1.4s ease-in-out infinite;
}
@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .shimmer { animation: none; }
}
</style>
