/**
 * Composable for CRM tag management — feature 0019.
 *
 * Module-level reactive cache so every consumer (TagPicker, SettingsTagsView,
 * Customer 360 chips) sees the same list and refresh-once behavior.
 */
import { ref, reactive, computed } from 'vue';
import { api } from '@/api/index';

export interface CrmTag {
  id: string;
  orgId: string;
  name: string;
  normalizedName: string;
  color: string;
  emoji: string | null;
  description: string | null;
  groupId: string | null;
  managedBy: 'zalo_sync' | null;
  sourceZaloLabelId: string | null;
  order: number;
  isActive: boolean;
  usageCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  group?: { id: string; name: string } | null;
}

export interface ListTagsParams {
  groupId?: string;
  managedBy?: 'crm' | 'zalo_sync';
  includeArchived?: boolean;
  search?: string;
}

// Module-level cache keyed by tag id.
const tagsById = reactive<Map<string, CrmTag>>(new Map());
const loaded = ref(false);
const loading = ref(false);
const error = ref('');

const allTags = computed<CrmTag[]>(() => Array.from(tagsById.values()));
const activeTags = computed<CrmTag[]>(() =>
  allTags.value.filter((t) => !t.archivedAt && t.isActive),
);

function upsertCache(tag: CrmTag) {
  tagsById.set(tag.id, tag);
}

function removeCache(id: string) {
  tagsById.delete(id);
}

export function useCrmTags() {
  async function loadTags(force = false): Promise<void> {
    if (loaded.value && !force) return;
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/crm-tags', { params: { includeArchived: true } });
      tagsById.clear();
      for (const t of res.data.tags as CrmTag[]) upsertCache(t);
      loaded.value = true;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
    } finally {
      loading.value = false;
    }
  }

  async function searchTags(params: ListTagsParams): Promise<CrmTag[]> {
    try {
      const res = await api.get('/crm-tags', { params });
      return res.data.tags as CrmTag[];
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
      return [];
    }
  }

  async function createTag(
    payload: { name: string; color?: string; emoji?: string | null; groupId?: string | null },
  ): Promise<
    | { ok: true; tag: CrmTag }
    | { ok: false; error: string; existingTagId?: string; code?: string }
  > {
    try {
      const res = await api.post('/crm-tags', payload);
      const tag = res.data as CrmTag;
      upsertCache(tag);
      return { ok: true, tag };
    } catch (err: any) {
      const data = err.response?.data ?? {};
      return {
        ok: false,
        error: data.error || err.message,
        existingTagId: data.existingTagId,
        code: data.code,
      };
    }
  }

  async function updateTag(
    id: string,
    patch: Partial<Pick<CrmTag, 'name' | 'color' | 'emoji' | 'description' | 'groupId' | 'order'>>,
  ): Promise<{ ok: true; tag: CrmTag } | { ok: false; error: string }> {
    try {
      const res = await api.put(`/crm-tags/${id}`, patch);
      const tag = res.data as CrmTag;
      upsertCache(tag);
      return { ok: true, tag };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  async function archiveTag(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await api.delete(`/crm-tags/${id}`);
      const tag = res.data as CrmTag;
      // Keep in cache so consumers can still resolve archived chips when toggled on.
      upsertCache(tag);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  function getTagById(id: string): CrmTag | undefined {
    return tagsById.get(id);
  }

  function resolveByName(name: string): CrmTag | undefined {
    const n = name.trim().toLowerCase();
    return allTags.value.find((t) => t.normalizedName === n);
  }

  return {
    // state
    allTags,
    activeTags,
    loaded,
    loading,
    error,
    // actions
    loadTags,
    searchTags,
    createTag,
    updateTag,
    archiveTag,
    // lookups
    getTagById,
    resolveByName,
    // internal
    removeCache,
  };
}
