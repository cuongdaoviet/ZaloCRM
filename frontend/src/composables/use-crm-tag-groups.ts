/**
 * Composable for CRM tag group management — feature 0019.
 */
import { ref, reactive, computed } from 'vue';
import { api } from '@/api/index';

export interface CrmTagGroup {
  id: string;
  orgId: string;
  name: string;
  managedBy: 'zalo_sync' | null;
  zaloAccountId: string | null;
  order: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const groupsById = reactive<Map<string, CrmTagGroup>>(new Map());
const loaded = ref(false);
const loading = ref(false);
const error = ref('');

const allGroups = computed<CrmTagGroup[]>(() => Array.from(groupsById.values()));

export function useCrmTagGroups() {
  async function loadGroups(force = false): Promise<void> {
    if (loaded.value && !force) return;
    loading.value = true;
    error.value = '';
    try {
      const res = await api.get('/crm-tag-groups', { params: { includeArchived: true } });
      groupsById.clear();
      for (const g of res.data.groups as CrmTagGroup[]) groupsById.set(g.id, g);
      loaded.value = true;
    } catch (err: any) {
      error.value = err.response?.data?.error || err.message;
    } finally {
      loading.value = false;
    }
  }

  async function createGroup(
    name: string,
  ): Promise<{ ok: true; group: CrmTagGroup } | { ok: false; error: string }> {
    try {
      const res = await api.post('/crm-tag-groups', { name });
      const group = res.data as CrmTagGroup;
      groupsById.set(group.id, group);
      return { ok: true, group };
    } catch (err: any) {
      return { ok: false, error: err.response?.data?.error || err.message };
    }
  }

  function getGroupById(id: string): CrmTagGroup | undefined {
    return groupsById.get(id);
  }

  return {
    allGroups,
    loaded,
    loading,
    error,
    loadGroups,
    createGroup,
    getGroupById,
  };
}
