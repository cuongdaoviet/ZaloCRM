<template>
  <v-tooltip location="top">
    <template #activator="{ props: tooltipProps }">
      <v-chip
        v-bind="tooltipProps"
        :color="meta.color"
        size="small"
        variant="flat"
        class="font-weight-medium lead-score-badge"
        :data-band="band"
      >
        {{ score }}
      </v-chip>
    </template>
    <div class="text-caption">
      <div class="font-weight-bold mb-1">
        Lead score: {{ score }} ({{ meta.label }})
      </div>
      <div v-if="breakdown">
        <div>Tin nhắn mới: +{{ breakdown.recency }}</div>
        <div>Tương tác 30 ngày: +{{ breakdown.engagement }}</div>
        <div>Trạng thái: +{{ breakdown.status }}</div>
        <div>Lịch hẹn: +{{ breakdown.appointment }}</div>
      </div>
    </div>
  </v-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { bandForScore, bandMeta, type LeadScoreBreakdown } from '@/composables/use-lead-score';

interface Props {
  score: number;
  breakdown?: LeadScoreBreakdown | null;
}

const props = withDefaults(defineProps<Props>(), {
  breakdown: null,
});

const band = computed(() => bandForScore(props.score));
const meta = computed(() => bandMeta[band.value]);
</script>

<style scoped>
.lead-score-badge {
  min-width: 38px;
  justify-content: center;
}
</style>
