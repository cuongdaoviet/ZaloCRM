<template>
  <!-- Feature 0049 F13 — dropped the icon-in-colored-circle decoration.
       The pattern was AI-slop ("colored icon + bold number + label,
       repeated 6 times in identical cards"). Number is the focal point;
       semantic color attaches to the number itself only when the metric
       wants attention (alert / warning), keeping neutral metrics quiet. -->
  <v-row>
    <v-col v-for="card in cards" :key="card.title" cols="6" sm="4" md="2">
      <v-card variant="outlined">
        <v-card-text class="pa-4">
          <div
            class="text-h4 font-weight-bold kpi-value"
            :class="card.attentionClass"
          >{{ card.value }}</div>
          <div class="text-caption text-medium-emphasis kpi-label">{{ card.title }}</div>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface KpiData {
  messagesToday: number;
  messagesUnreplied: number;
  messagesUnread: number;
  appointmentsToday: number;
  newContactsThisWeek: number;
  totalContacts: number;
}

const props = defineProps<{
  kpi: KpiData | null;
}>();

// `attentionClass` keeps neutral metrics quiet (default text color) and
// only paints the number with semantic color when the metric is one that
// should pull the eye. Tin nhắn hôm nay / Tổng khách hàng are just
// information; Chưa trả lời + Chưa đọc are calls to act.
const cards = computed(() => [
  { title: 'Tin nhắn hôm nay', value: props.kpi?.messagesToday ?? '—', attentionClass: '' },
  { title: 'Chưa trả lời', value: props.kpi?.messagesUnreplied ?? '—', attentionClass: (props.kpi?.messagesUnreplied ?? 0) > 0 ? 'text-warning' : '' },
  { title: 'Chưa đọc', value: props.kpi?.messagesUnread ?? '—', attentionClass: (props.kpi?.messagesUnread ?? 0) > 0 ? 'text-warning' : '' },
  { title: 'Lịch hẹn hôm nay', value: props.kpi?.appointmentsToday ?? '—', attentionClass: '' },
  { title: 'KH mới tuần này', value: props.kpi?.newContactsThisWeek ?? '—', attentionClass: '' },
  { title: 'Tổng khách hàng', value: props.kpi?.totalContacts ?? '—', attentionClass: '' },
]);
</script>

<style scoped>
.kpi-value {
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.kpi-label {
  margin-top: 4px;
  font-size: 0.75rem;
}
</style>
