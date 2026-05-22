<template>
  <!-- Feature 0049 F13 — dropped the icon-in-colored-circle decoration.
       The pattern was AI-slop ("colored icon + bold number + label,
       repeated 6 times in identical cards"). Number is the focal point;
       semantic color attaches to the number itself only when the metric
       wants attention (alert / warning), keeping neutral metrics quiet.

       Feature 0052a — extracted to <MetricCard>. Visual identical;
       attentionColor prop replaces the local class swap. -->
  <v-row>
    <v-col v-for="card in cards" :key="card.title" cols="6" sm="4" md="2">
      <MetricCard
        :value="card.value"
        :label="card.title"
        :attention-color="card.attentionColor"
      />
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MetricCard from '@/components/shared/MetricCard.vue';

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

// `attentionColor` keeps neutral metrics quiet (default text color) and
// only paints the number with semantic color when the metric is one that
// should pull the eye. Tin nhắn hôm nay / Tổng khách hàng are just
// information; Chưa trả lời + Chưa đọc are calls to act.
const cards = computed<Array<{
  title: string;
  value: string | number;
  attentionColor: string | undefined;
}>>(() => [
  { title: 'Tin nhắn hôm nay', value: props.kpi?.messagesToday ?? '—', attentionColor: undefined },
  { title: 'Chưa trả lời', value: props.kpi?.messagesUnreplied ?? '—', attentionColor: (props.kpi?.messagesUnreplied ?? 0) > 0 ? 'warning' : undefined },
  { title: 'Chưa đọc', value: props.kpi?.messagesUnread ?? '—', attentionColor: (props.kpi?.messagesUnread ?? 0) > 0 ? 'warning' : undefined },
  { title: 'Lịch hẹn hôm nay', value: props.kpi?.appointmentsToday ?? '—', attentionColor: undefined },
  { title: 'KH mới tuần này', value: props.kpi?.newContactsThisWeek ?? '—', attentionColor: undefined },
  { title: 'Tổng khách hàng', value: props.kpi?.totalContacts ?? '—', attentionColor: undefined },
]);
</script>
