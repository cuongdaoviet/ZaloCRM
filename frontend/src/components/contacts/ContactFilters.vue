<template>
  <v-row dense class="mb-2 align-center">
    <!-- Search -->
    <v-col cols="12" sm="3">
      <v-text-field
        v-model="filters.search"
        prepend-inner-icon="mdi-magnify"
        label="Tìm kiếm tên / SĐT / email"
        clearable
        hide-details
        @update:model-value="emit('search')"
      />
    </v-col>

    <!-- Source filter -->
    <v-col cols="6" sm="3">
      <v-select
        v-model="filters.source"
        :items="sourceOptions"
        item-title="text"
        item-value="value"
        label="Nguồn"
        clearable
        hide-details
        @update:model-value="emit('search')"
      />
    </v-col>

    <!-- Status filter -->
    <v-col cols="6" sm="3">
      <v-select
        v-model="filters.status"
        :items="statusOptions"
        item-title="text"
        item-value="value"
        label="Trạng thái"
        clearable
        hide-details
        @update:model-value="emit('search')"
      />
    </v-col>

    <!-- Tag filter (feature 0019) -->
    <v-col cols="12" sm="3">
      <TagPicker
        :model-value="filters.tagIds ?? []"
        label="Nhãn"
        placeholder="Lọc theo nhãn"
        @update:model-value="onTagsChange"
      />
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import type { ContactFilters } from '@/composables/use-contacts';
import { SOURCE_OPTIONS, STATUS_OPTIONS } from '@/composables/use-contacts';
import TagPicker from '@/components/tags/TagPicker.vue';

const props = defineProps<{ filters: ContactFilters }>();
const emit = defineEmits<{ search: [] }>();

const sourceOptions = SOURCE_OPTIONS;
const statusOptions = STATUS_OPTIONS;

function onTagsChange(ids: string[]) {
  props.filters.tagIds = ids;
  emit('search');
}
</script>
