<template>
  <v-autocomplete
    :model-value="modelValue"
    :items="visibleTags"
    item-value="id"
    item-title="name"
    multiple
    chips
    closable-chips
    clearable
    :label="label"
    :placeholder="placeholder"
    :density="density"
    :variant="variant"
    :hide-details="hideDetails"
    :loading="loading || creating"
    :no-data-text="noDataText"
    @update:model-value="onUpdate"
    @update:search="onSearch"
    @keydown="onKeyDown"
  >
    <!-- selected chip slot — render with tinted background -->
    <template #chip="slot">
      <v-chip
        v-bind="slot.props"
        size="small"
        class="tag-picker-chip"
        :style="chipStyle(asTag(slot.item).color)"
      >
        <span v-if="asTag(slot.item).emoji" class="me-1">{{ asTag(slot.item).emoji }}</span>
        {{ asTag(slot.item).name }}
      </v-chip>
    </template>

    <!-- dropdown item slot — show emoji + color + group + zalo-sync badge -->
    <template #item="slot">
      <v-list-item v-bind="slot.props">
        <template #prepend>
          <span
            class="color-swatch"
            :style="{ backgroundColor: asTag(slot.item).color || '#9E9E9E' }"
          />
        </template>
        <template #title>
          <span v-if="asTag(slot.item).emoji" class="me-1">{{ asTag(slot.item).emoji }}</span>
          {{ asTag(slot.item).name }}
          <v-chip
            v-if="asTag(slot.item).managedBy === 'zalo_sync'"
            size="x-small"
            variant="tonal"
            color="info"
            class="ms-2"
          >Zalo</v-chip>
        </template>
        <template v-if="asTag(slot.item).group" #subtitle>
          {{ asTag(slot.item).group?.name }}
        </template>
      </v-list-item>
    </template>
  </v-autocomplete>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useCrmTags, type CrmTag } from '@/composables/use-crm-tags';

/**
 * Reusable multi-select tag picker. `modelValue` is `string[]` of tag IDs.
 *
 * User types a name + presses Enter on an empty match -> calls `createTag()`
 * inline and appends the new tag to the selection. Archived tags are hidden
 * unless `showArchived` is true.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[];
    label?: string;
    placeholder?: string;
    density?: 'default' | 'comfortable' | 'compact';
    variant?: 'filled' | 'outlined' | 'plain' | 'underlined' | 'solo' | 'solo-inverted' | 'solo-filled';
    hideDetails?: boolean | 'auto';
    showArchived?: boolean;
  }>(),
  {
    label: 'Nhãn',
    placeholder: 'Chọn hoặc tạo nhãn mới',
    density: 'compact',
    variant: 'outlined',
    hideDetails: true,
    showArchived: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string[]];
}>();

const { allTags, activeTags, loading, loadTags, createTag } = useCrmTags();

const search = ref('');
const creating = ref(false);

const noDataText = computed(() => {
  const q = search.value.trim();
  return q.length > 0 ? `Nhấn Enter để tạo nhãn "${q}"` : 'Chưa có nhãn';
});

/** Coerce a Vuetify autocomplete item slot value to our CrmTag shape. */
function asTag(item: unknown): CrmTag {
  if (item && typeof item === 'object' && 'raw' in (item as Record<string, unknown>)) {
    return (item as { raw: CrmTag }).raw;
  }
  return item as CrmTag;
}

onMounted(() => {
  loadTags();
});

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

const visibleTags = computed<CrmTag[]>(() => {
  const base = props.showArchived ? allTags.value : activeTags.value;
  // Always include currently-selected tags so the chip can render even if
  // archived was toggled off after selection.
  const selectedIds = new Set(props.modelValue);
  const selectedTags = allTags.value.filter((t) => selectedIds.has(t.id));
  const map = new Map<string, CrmTag>();
  for (const t of base) map.set(t.id, t);
  for (const t of selectedTags) map.set(t.id, t);
  return Array.from(map.values()).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
});

function onUpdate(value: string[]) {
  emit('update:modelValue', value);
}

function onSearch(value: string) {
  search.value = value ?? '';
}

async function onKeyDown(ev: KeyboardEvent) {
  if (ev.key !== 'Enter') return;
  const name = search.value.trim();
  if (name.length === 0) return;

  // If a tag with this exact name (case-folded) already exists, the
  // autocomplete handles selection — do nothing extra.
  const normalized = name.toLowerCase();
  const existing = allTags.value.find((t) => t.normalizedName === normalized);
  if (existing) return;

  ev.preventDefault();
  creating.value = true;
  const result = await createTag({ name });
  creating.value = false;
  if (result.ok) {
    emit('update:modelValue', [...props.modelValue, result.tag.id]);
    search.value = '';
  } else if (result.code === 'TAG_DUPLICATE' && result.existingTagId) {
    // Race: another tab created it. Just add the existing id.
    emit('update:modelValue', [...props.modelValue, result.existingTagId]);
    search.value = '';
  }
}

function hexToRgba(hex: string | null | undefined, alpha: number): string {
  const value = hex ?? '';
  if (!HEX_RE.test(value)) return `rgba(158, 158, 158, ${alpha})`;
  const r = parseInt(value.slice(1, 3), 16);
  const g = parseInt(value.slice(3, 5), 16);
  const b = parseInt(value.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function chipStyle(color: string | null | undefined) {
  return {
    backgroundColor: hexToRgba(color, 0.15),
    color: 'inherit',
    border: `1px solid ${hexToRgba(color, 0.55)}`,
  };
}
</script>

<style scoped>
.color-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.12);
}
.tag-picker-chip {
  font-weight: 500;
}
</style>
