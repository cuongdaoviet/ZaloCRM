<template>
  <v-card>
    <v-card-title class="d-flex align-center text-body-1">
      <v-icon class="mr-2" color="primary">mdi-filter-variant</v-icon>
      Phễu chuyển đổi
      <v-spacer />
      <span class="text-caption text-grey">{{ totalContacts }} khách</span>
    </v-card-title>
    <v-card-text>
      <div v-if="!data?.stages?.length" class="text-center pa-8 text-grey">
        Không có dữ liệu
      </div>
      <div v-else class="funnel-stack">
        <div
          v-for="(stage, idx) in data.stages"
          :key="stage.name"
          class="funnel-row"
        >
          <div class="funnel-row-header">
            <span class="funnel-row-label">{{ stageLabel(stage.name) }}</span>
            <span class="funnel-row-count">{{ formatCount(stage.count) }}</span>
            <span class="funnel-row-rate" :class="rateClass(stage.conversionRate)">
              {{ formatRate(stage.conversionRate) }}
            </span>
          </div>
          <div class="funnel-bar-wrap">
            <div
              class="funnel-bar"
              :style="{
                width: barWidth(stage.count) + '%',
                background: stageColors[idx % stageColors.length],
              }"
            />
          </div>
        </div>
        <div v-if="data.lost?.count > 0" class="funnel-lost">
          <v-icon size="14" color="error" class="mr-1">mdi-close-circle-outline</v-icon>
          <span>Khách rời: {{ formatCount(data.lost.count) }}</span>
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FunnelResponse } from '@/composables/use-analytics';

interface Props {
  data: FunnelResponse | null;
}
const props = defineProps<Props>();

// Stage labels in Vietnamese, in funnel order.
const stageLabels: Record<string, string> = {
  new: 'Mới',
  contacted: 'Đã liên hệ',
  interested: 'Quan tâm',
  converted: 'Chuyển đổi',
};
// Color gradient from grey → green to convey progression.
const stageColors = ['#9E9E9E', '#42A5F5', '#FF9800', '#66BB6A'];

const totalContacts = computed(() => props.data?.totalContacts ?? 0);

// Bar width is relative to the largest stage so the funnel "shape" is
// always visible — even when absolute counts are tiny.
const maxCount = computed(() => {
  if (!props.data?.stages?.length) return 0;
  return Math.max(...props.data.stages.map((s) => s.count), 1);
});

function stageLabel(name: string): string {
  return stageLabels[name] ?? name;
}

function barWidth(count: number): number {
  if (maxCount.value === 0) return 0;
  return Math.max(2, Math.round((count / maxCount.value) * 100));
}

function formatCount(n: number): string {
  return n.toLocaleString('vi-VN');
}

function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${rate}%`;
}

function rateClass(rate: number | null): string {
  if (rate === null) return 'text-grey';
  if (rate >= 50) return 'text-success';
  if (rate >= 25) return 'text-warning';
  return 'text-error';
}
</script>

<style scoped>
.funnel-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.funnel-row-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.875rem;
  margin-bottom: 4px;
}
.funnel-row-label {
  font-weight: 500;
  flex: 1;
}
.funnel-row-count {
  font-weight: 600;
}
.funnel-row-rate {
  font-size: 0.75rem;
  min-width: 48px;
  text-align: right;
}
.funnel-bar-wrap {
  background: rgba(127, 127, 127, 0.12);
  border-radius: 4px;
  height: 14px;
  overflow: hidden;
}
.funnel-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.25s ease;
}
.funnel-lost {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(127, 127, 127, 0.3);
  font-size: 0.875rem;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.75;
}
</style>
