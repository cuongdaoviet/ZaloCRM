<template>
  <!-- Feature 0052a — canonical metric card.
       Big bold number + small muted label, optional delta line below.
       No icons baked in (use #prepend slot if a caller truly needs one),
       no colored left-border, no icon-in-circle. The 4 KPI surfaces in
       the app (Dashboard, Orders, KPI page, …) render this same pattern
       slightly differently today; this is the canonical shape.

       attentionColor exists for the "Chưa trả lời" / "Chưa đọc" use case
       on Dashboard — paint the *number* with semantic color only when the
       metric wants attention. Neutral metrics stay quiet. -->
  <v-card variant="outlined">
    <v-card-text class="pa-4">
      <slot name="prepend" />
      <div
        class="text-h4 font-weight-bold metric-value"
        :class="valueClass"
      >{{ value }}</div>
      <div class="text-caption text-medium-emphasis metric-label">{{ label }}</div>
      <div v-if="delta" class="d-flex align-center text-caption metric-delta">
        <span :class="deltaTextClass">{{ delta.text }}</span>
        <span v-if="delta.suffix" class="text-medium-emphasis ml-1">{{ delta.suffix }}</span>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface DeltaSpec {
  /** Already-formatted delta text — e.g. "+353.9%", "— —". */
  text: string;
  /** Optional Vuetify color name applied to the delta text. */
  color?: string;
  /** Optional muted suffix appended to the right of the delta — e.g. " so với kỳ trước". */
  suffix?: string;
}

const props = defineProps<{
  value: string | number;
  label: string;
  attentionColor?: string;
  delta?: DeltaSpec;
}>();

const valueClass = computed(() =>
  props.attentionColor ? `text-${props.attentionColor}` : '',
);

const deltaTextClass = computed(() =>
  props.delta?.color ? `text-${props.delta.color}` : 'text-medium-emphasis',
);
</script>

<style scoped>
.metric-value {
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.metric-label {
  margin-top: 4px;
  font-size: 0.75rem;
}
.metric-delta {
  margin-top: 6px;
}
</style>
