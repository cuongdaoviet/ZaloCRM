<template>
  <div class="conversation-filters d-flex flex-wrap align-center ga-2 px-2 pb-2">
    <!-- Chưa đọc -->
    <v-chip
      :color="filters.unread ? 'primary' : undefined"
      :variant="filters.unread ? 'flat' : 'outlined'"
      size="small"
      class="conv-filter-chip"
      @click="toggleUnread"
    >
      <v-icon start size="14">mdi-email-mark-as-unread</v-icon>
      Chưa đọc
      <v-badge
        v-if="unreadTotal > 0"
        :content="unreadTotal"
        color="error"
        inline
        class="ml-1"
      />
    </v-chip>

    <!-- Chưa trả lời -->
    <v-chip
      :color="filters.unreplied ? 'primary' : undefined"
      :variant="filters.unreplied ? 'flat' : 'outlined'"
      size="small"
      class="conv-filter-chip"
      @click="toggleUnreplied"
    >
      <v-icon start size="14">mdi-reply-outline</v-icon>
      Chưa trả lời
      <v-badge
        v-if="unrepliedTotal > 0"
        :content="unrepliedTotal"
        color="warning"
        inline
        class="ml-1"
      />
    </v-chip>

    <!-- Thời gian -->
    <v-menu :close-on-content-click="false" location="bottom start">
      <template #activator="{ props: menuProps }">
        <v-chip
          v-bind="menuProps"
          :color="hasDateFilter ? 'primary' : undefined"
          :variant="hasDateFilter ? 'flat' : 'outlined'"
          size="small"
          class="conv-filter-chip"
        >
          <v-icon start size="14">mdi-calendar</v-icon>
          {{ dateChipLabel }}
        </v-chip>
      </template>
      <v-card min-width="280" class="pa-3">
        <div class="text-caption font-weight-medium mb-2">Khoảng thời gian</div>
        <div class="d-flex flex-wrap ga-1 mb-3">
          <v-btn size="x-small" variant="tonal" @click="applyPresetToday">
            Hôm nay
          </v-btn>
          <v-btn size="x-small" variant="tonal" @click="applyPresetThisWeek">
            Tuần này
          </v-btn>
          <v-btn size="x-small" variant="tonal" @click="applyPresetThisMonth">
            Tháng này
          </v-btn>
        </div>
        <v-text-field
          :model-value="filters.dateFrom"
          @update:model-value="onDateFromChange"
          type="date"
          label="Từ ngày"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-2"
        />
        <v-text-field
          :model-value="filters.dateTo"
          @update:model-value="onDateToChange"
          type="date"
          label="Đến ngày"
          density="compact"
          variant="outlined"
          hide-details
          class="mb-2"
        />
        <v-btn
          v-if="hasDateFilter"
          size="x-small"
          variant="text"
          color="error"
          block
          @click="clearDate"
        >Xóa</v-btn>
      </v-card>
    </v-menu>

    <!-- Tag -->
    <v-menu :close-on-content-click="false" location="bottom start">
      <template #activator="{ props: menuProps }">
        <v-chip
          v-bind="menuProps"
          :color="hasTagFilter ? 'primary' : undefined"
          :variant="hasTagFilter ? 'flat' : 'outlined'"
          size="small"
          class="conv-filter-chip"
        >
          <v-icon start size="14">mdi-tag-multiple</v-icon>
          {{ tagChipLabel }}
        </v-chip>
      </template>
      <v-card min-width="280" class="pa-3">
        <div class="text-caption font-weight-medium mb-2">Lọc theo nhãn</div>
        <TagPicker
          :model-value="filters.tagIds"
          @update:model-value="onTagsChange"
          label="Chọn nhãn"
          placeholder="Chọn nhãn để lọc"
        />
        <v-btn
          v-if="hasTagFilter"
          size="x-small"
          variant="text"
          color="error"
          block
          class="mt-2"
          @click="clearTags"
        >Xóa</v-btn>
      </v-card>
    </v-menu>

    <!-- Clear-all link -->
    <v-btn
      v-if="hasActiveFilters"
      size="x-small"
      variant="text"
      color="error"
      class="ms-auto"
      @click="onReset"
    >
      <v-icon start size="14">mdi-close</v-icon>
      Xóa bộ lọc
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import TagPicker from '@/components/tags/TagPicker.vue';
import type { ConversationFilters } from '@/composables/use-chat';

const props = defineProps<{
  filters: ConversationFilters;
  hasActiveFilters: boolean;
  unreadTotal: number;
  unrepliedTotal: number;
}>();

const emit = defineEmits<{
  /**
   * Match ZaloCRM-3.0's FilterRail emit shape so a future Phase 2 (full
   * sidebar) can drop in without breaking the contract. Payload keys are
   * the wire-format param names: unread, unreplied, dateFrom, dateTo, tags.
   */
  'update:filters': [filters: Record<string, string>];
  /**
   * Internal: emit a new ConversationFilters object so the parent can
   * round-trip the reactive state back into the composable's `filters` ref.
   */
  'update:state': [filters: ConversationFilters];
  reset: [];
}>();

const hasDateFilter = computed<boolean>(
  () => props.filters.dateFrom !== '' || props.filters.dateTo !== '',
);
const hasTagFilter = computed<boolean>(() => props.filters.tagIds.length > 0);

const dateChipLabel = computed<string>(() => {
  if (props.filters.dateFrom && props.filters.dateTo) {
    return `${props.filters.dateFrom} → ${props.filters.dateTo}`;
  }
  if (props.filters.dateFrom) return `Từ ${props.filters.dateFrom}`;
  if (props.filters.dateTo) return `Đến ${props.filters.dateTo}`;
  return 'Thời gian';
});

const tagChipLabel = computed<string>(() => {
  if (props.filters.tagIds.length === 0) return 'Tag';
  return `Tag (${props.filters.tagIds.length})`;
});

/** Emit the 3.0-shape wire payload alongside the reactive state update. */
function emitFilters(next: ConversationFilters): void {
  emit('update:state', next);
  const out: Record<string, string> = {};
  if (next.unread) out.unread = '1';
  if (next.unreplied) out.unreplied = '1';
  if (next.dateFrom) out.dateFrom = next.dateFrom;
  if (next.dateTo) out.dateTo = next.dateTo;
  if (next.tagIds.length > 0) out.tags = next.tagIds.join(',');
  emit('update:filters', out);
}

function toggleUnread(): void {
  emitFilters({ ...props.filters, unread: !props.filters.unread });
}

function toggleUnreplied(): void {
  emitFilters({ ...props.filters, unreplied: !props.filters.unreplied });
}

function onDateFromChange(value: string): void {
  emitFilters({ ...props.filters, dateFrom: value || '' });
}

function onDateToChange(value: string): void {
  emitFilters({ ...props.filters, dateTo: value || '' });
}

function clearDate(): void {
  emitFilters({ ...props.filters, dateFrom: '', dateTo: '' });
}

function onTagsChange(ids: string[]): void {
  emitFilters({ ...props.filters, tagIds: ids });
}

function clearTags(): void {
  emitFilters({ ...props.filters, tagIds: [] });
}

function onReset(): void {
  emit('reset');
}

/** Format a Date as YYYY-MM-DD in local time (matches v-text-field type="date"). */
function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function applyPresetToday(): void {
  const today = formatLocalDate(new Date());
  emitFilters({ ...props.filters, dateFrom: today, dateTo: today });
}

function applyPresetThisWeek(): void {
  const now = new Date();
  // Treat Monday as the start of the week (vi-VN convention).
  const day = now.getDay(); // 0=Sun..6=Sat
  const offset = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - offset);
  emitFilters({
    ...props.filters,
    dateFrom: formatLocalDate(monday),
    dateTo: formatLocalDate(now),
  });
}

function applyPresetThisMonth(): void {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  emitFilters({
    ...props.filters,
    dateFrom: formatLocalDate(first),
    dateTo: formatLocalDate(now),
  });
}
</script>

<style scoped>
.conversation-filters {
  border-bottom: 1px solid var(--border-glow, rgba(0, 0, 0, 0.06));
}
.conv-filter-chip {
  cursor: pointer;
  user-select: none;
}
</style>
