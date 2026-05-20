<template>
  <div>
    <h1 class="text-h5 mb-4">Quản lý nhãn</h1>

    <v-card>
      <v-tabs v-model="tab" color="primary" density="comfortable">
        <v-tab value="tags">Nhãn</v-tab>
        <v-tab value="groups">Nhóm nhãn</v-tab>
        <v-tab value="zalo">Đồng bộ từ Zalo</v-tab>
      </v-tabs>

      <v-divider />

      <v-window v-model="tab">
        <!-- ── Tab: Tags ───────────────────────────────────────────────── -->
        <v-window-item value="tags">
          <div class="pa-3 d-flex flex-wrap align-center" style="gap: 12px;">
            <v-text-field
              v-model="search"
              prepend-inner-icon="mdi-magnify"
              label="Tìm theo tên"
              density="compact" variant="outlined" hide-details clearable
              style="max-width: 280px;"
            />
            <v-switch
              v-model="showArchived"
              label="Hiện cả nhãn đã lưu trữ"
              density="compact" hide-details
              color="primary"
            />
            <v-spacer />
            <v-btn color="primary" prepend-icon="mdi-plus" @click="startCreate">
              Tạo nhãn
            </v-btn>
          </div>

          <v-divider />

          <v-data-table
            :headers="tagHeaders"
            :items="filteredTags"
            :loading="tagsLoading"
            density="comfortable"
            item-value="id"
            :items-per-page="25"
          >
            <template #item.color="{ item }">
              <span
                class="color-swatch"
                :style="{ backgroundColor: item.color }"
                :title="item.color"
              />
            </template>
            <template #item.emoji="{ item }">
              <span v-if="item.emoji">{{ item.emoji }}</span>
              <span v-else class="text-grey">—</span>
            </template>
            <template #item.groupName="{ item }">
              {{ item.group?.name ?? '—' }}
            </template>
            <template #item.managedBy="{ item }">
              <v-chip
                v-if="item.managedBy === 'zalo_sync'"
                size="x-small" variant="tonal" color="info"
              >Zalo sync</v-chip>
              <v-chip v-else size="x-small" variant="tonal">CRM</v-chip>
            </template>
            <template #item.archivedAt="{ item }">
              <v-chip
                v-if="item.archivedAt" size="x-small"
                variant="tonal" color="warning"
              >Đã lưu trữ</v-chip>
              <v-chip v-else size="x-small" variant="tonal" color="success">Hoạt động</v-chip>
            </template>
            <template #item.actions="{ item }">
              <v-btn
                icon size="small" variant="text"
                :disabled="item.managedBy === 'zalo_sync'"
                @click="startEdit(item)"
              ><v-icon size="18">mdi-pencil</v-icon></v-btn>
              <v-btn
                icon size="small" variant="text" color="error"
                :disabled="item.managedBy === 'zalo_sync' || !!item.archivedAt"
                @click="onArchive(item)"
              ><v-icon size="18">mdi-archive-outline</v-icon></v-btn>
            </template>
          </v-data-table>
        </v-window-item>

        <!-- ── Tab: Groups ─────────────────────────────────────────────── -->
        <v-window-item value="groups">
          <div class="pa-3 d-flex align-center" style="gap: 12px;">
            <v-text-field
              v-model="newGroupName"
              label="Tên nhóm mới"
              density="compact" variant="outlined" hide-details
              style="max-width: 280px;"
              @keydown.enter="onCreateGroup"
            />
            <v-btn color="primary" prepend-icon="mdi-plus" :loading="creatingGroup" @click="onCreateGroup">
              Tạo nhóm
            </v-btn>
          </div>

          <v-divider />

          <v-list density="comfortable">
            <v-list-item v-for="g in allGroups" :key="g.id">
              <v-list-item-title>{{ g.name }}</v-list-item-title>
              <v-list-item-subtitle>
                {{ tagCountByGroup.get(g.id) ?? 0 }} nhãn
              </v-list-item-subtitle>
            </v-list-item>
            <v-list-item v-if="allGroups.length === 0">
              <span class="text-grey">Chưa có nhóm nào</span>
            </v-list-item>
          </v-list>
        </v-window-item>

        <!-- ── Tab: Zalo sync ───────────────────────────────────────────── -->
        <v-window-item value="zalo">
          <div class="pa-4">
            <v-alert type="info" variant="tonal" density="comfortable" class="mb-3">
              Kéo label gốc của Zalo về CRM. Mỗi tài khoản Zalo sinh ra một
              <strong>nhóm nhãn riêng</strong>; label biến mất khỏi Zalo sẽ
              được <strong>tự động lưu trữ</strong> (link với contact cũ vẫn
              giữ). Chỉ admin/owner mới chạy được đồng bộ.
            </v-alert>

            <div v-if="zaloAccounts.length === 0" class="text-grey">
              Chưa có tài khoản Zalo nào trong tổ chức.
            </div>

            <v-list v-else density="comfortable" lines="two">
              <v-list-item
                v-for="acc in zaloAccounts"
                :key="acc.id"
              >
                <template #prepend>
                  <v-icon :color="acc.status === 'connected' ? 'success' : 'grey'">
                    mdi-cellphone-link
                  </v-icon>
                </template>
                <v-list-item-title>
                  {{ acc.displayName || 'Zalo account' }}
                  <v-chip
                    size="x-small" variant="tonal" class="ml-2"
                    :color="acc.status === 'connected' ? 'success' : 'grey'"
                  >{{ acc.status }}</v-chip>
                </v-list-item-title>
                <v-list-item-subtitle v-if="syncResultByAccount.get(acc.id)">
                  <span class="text-success">
                    {{ formatSyncResult(syncResultByAccount.get(acc.id)!) }}
                  </span>
                </v-list-item-subtitle>
                <template #append>
                  <v-btn
                    color="primary" variant="outlined"
                    prepend-icon="mdi-sync"
                    :loading="syncingAccountId === acc.id"
                    :disabled="acc.status !== 'connected' || !!syncingAccountId"
                    @click="onSyncLabels(acc.id)"
                  >
                    Đồng bộ
                  </v-btn>
                </template>
              </v-list-item>
            </v-list>

            <v-alert
              v-if="syncError" type="error" variant="tonal" closable
              density="comfortable" class="mt-3"
              @click:close="syncError = ''"
            >
              {{ syncError }}
            </v-alert>
          </div>
        </v-window-item>
      </v-window>
    </v-card>

    <!-- Create / edit dialog -->
    <v-dialog v-model="dialog.show" max-width="480">
      <v-card>
        <v-card-title class="text-body-1 font-weight-medium">
          {{ dialog.mode === 'create' ? 'Tạo nhãn mới' : 'Chỉnh sửa nhãn' }}
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-text-field
            v-model="dialog.name" label="Tên nhãn" autofocus
            density="comfortable" variant="outlined"
            :rules="[(v) => !!v || 'Bắt buộc']"
          />
          <v-text-field
            v-model="dialog.color" label="Màu (#RRGGBB)"
            density="comfortable" variant="outlined"
            placeholder="#9E9E9E"
            :rules="[(v) => /^#[0-9A-Fa-f]{6}$/.test(v) || 'Sai định dạng']"
          >
            <template #append-inner>
              <span class="color-swatch-inline" :style="{ backgroundColor: dialog.color }" />
            </template>
          </v-text-field>
          <v-text-field
            v-model="dialog.emoji" label="Emoji (tuỳ chọn)"
            density="comfortable" variant="outlined" maxlength="4"
          />
          <v-select
            v-model="dialog.groupId" :items="groupOptions"
            item-title="name" item-value="id" label="Nhóm (tuỳ chọn)"
            density="comfortable" variant="outlined" clearable
          />
          <v-alert v-if="dialog.error" type="error" density="compact" class="mt-2">
            {{ dialog.error }}
          </v-alert>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog.show = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="dialog.saving" @click="onSave">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useCrmTags, type CrmTag } from '@/composables/use-crm-tags';
import { useCrmTagGroups } from '@/composables/use-crm-tag-groups';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';
import { api } from '@/api/index';

const router = useRouter();
const authStore = useAuthStore();

// Admin-only guard — same pattern as ActivityView.
if (!authStore.isAdmin) {
  router.replace('/');
}

const tab = ref<'tags' | 'groups' | 'zalo'>('tags');

// ── Tags state ─────────────────────────────────────────────────────────────
const {
  allTags, loading: tagsLoading, loadTags, createTag, updateTag, archiveTag,
} = useCrmTags();

const search = ref('');
const showArchived = ref(false);

const filteredTags = computed<CrmTag[]>(() => {
  const q = search.value.trim().toLowerCase();
  return allTags.value
    .filter((t) => showArchived.value || !t.archivedAt)
    .filter((t) => q.length === 0 || t.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });
});

const tagHeaders = [
  { title: 'Tên', key: 'name' },
  { title: 'Màu', key: 'color', sortable: false },
  { title: 'Emoji', key: 'emoji', sortable: false },
  { title: 'Nhóm', key: 'groupName', sortable: false },
  { title: 'Lượt dùng', key: 'usageCount' },
  { title: 'Nguồn', key: 'managedBy', sortable: false },
  { title: 'Trạng thái', key: 'archivedAt', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
];

// ── Groups state ───────────────────────────────────────────────────────────
const {
  allGroups, loadGroups, createGroup,
} = useCrmTagGroups();

const newGroupName = ref('');
const creatingGroup = ref(false);

const tagCountByGroup = computed(() => {
  const m = new Map<string, number>();
  for (const t of allTags.value) {
    if (t.groupId) m.set(t.groupId, (m.get(t.groupId) ?? 0) + 1);
  }
  return m;
});

const groupOptions = computed(() =>
  allGroups.value.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name })),
);

// ── Dialog state ───────────────────────────────────────────────────────────
const dialog = reactive({
  show: false,
  mode: 'create' as 'create' | 'edit',
  id: '',
  name: '',
  color: '#9E9E9E',
  emoji: '',
  groupId: null as string | null,
  error: '',
  saving: false,
});

function startCreate() {
  dialog.mode = 'create';
  dialog.id = '';
  dialog.name = '';
  dialog.color = '#9E9E9E';
  dialog.emoji = '';
  dialog.groupId = null;
  dialog.error = '';
  dialog.show = true;
}

function startEdit(tag: CrmTag) {
  dialog.mode = 'edit';
  dialog.id = tag.id;
  dialog.name = tag.name;
  dialog.color = tag.color;
  dialog.emoji = tag.emoji ?? '';
  dialog.groupId = tag.groupId;
  dialog.error = '';
  dialog.show = true;
}

async function onSave() {
  dialog.error = '';
  if (!dialog.name.trim()) {
    dialog.error = 'Tên nhãn bắt buộc';
    return;
  }
  dialog.saving = true;
  const payload = {
    name: dialog.name.trim(),
    color: dialog.color,
    emoji: dialog.emoji || null,
    groupId: dialog.groupId,
  };
  const result =
    dialog.mode === 'create'
      ? await createTag(payload)
      : await updateTag(dialog.id, payload);
  dialog.saving = false;
  if (result.ok) {
    dialog.show = false;
  } else {
    dialog.error = result.error;
  }
}

async function onArchive(tag: CrmTag) {
  if (!confirm(`Lưu trữ nhãn "${tag.name}"?`)) return;
  await archiveTag(tag.id);
}

async function onCreateGroup() {
  const name = newGroupName.value.trim();
  if (!name) return;
  creatingGroup.value = true;
  const result = await createGroup(name);
  creatingGroup.value = false;
  if (result.ok) {
    newGroupName.value = '';
  } else {
    alert(result.error);
  }
}

// ── Phase A.1: Zalo label sync ─────────────────────────────────────────────
const { accounts: zaloAccounts, fetchAccounts } = useZaloAccounts();
const syncingAccountId = ref<string | null>(null);
const syncError = ref('');

interface SyncResult {
  groupId: string;
  labelsCreated: number;
  labelsUpdated: number;
  labelsArchived: number;
  adopted: number;
}
const syncResultByAccount = ref(new Map<string, SyncResult>());

async function onSyncLabels(accountId: string) {
  syncingAccountId.value = accountId;
  syncError.value = '';
  try {
    const res = await api.post<{ synced: SyncResult }>(
      `/zalo-accounts/${accountId}/sync-labels`,
    );
    syncResultByAccount.value = new Map(syncResultByAccount.value).set(
      accountId,
      res.data.synced,
    );
    // Reload tags + groups so the new Zalo-managed entries show up in the
    // other tabs immediately.
    await loadTags(true);
    await loadGroups(true);
  } catch (err: any) {
    const code = err?.response?.data?.code;
    const message = err?.response?.data?.error || 'Đồng bộ thất bại';
    syncError.value =
      code === 'ZALO_NOT_LOGGED_IN'
        ? 'Tài khoản chưa kết nối Zalo — vui lòng đăng nhập lại.'
        : code === 'ZALO_BRIDGE_ERROR'
          ? 'Không lấy được dữ liệu từ Zalo. Thử lại sau.'
          : message;
  } finally {
    syncingAccountId.value = null;
  }
}

function formatSyncResult(r: SyncResult): string {
  const bits: string[] = [];
  if (r.labelsCreated > 0) bits.push(`tạo mới ${r.labelsCreated}`);
  if (r.labelsUpdated > 0) bits.push(`cập nhật ${r.labelsUpdated}`);
  if (r.labelsArchived > 0) bits.push(`lưu trữ ${r.labelsArchived}`);
  if (r.adopted > 0) bits.push(`adopt ${r.adopted}`);
  return bits.length === 0 ? 'Đồng bộ thành công' : `Đã ${bits.join(' · ')}`;
}

onMounted(() => {
  loadTags(true);
  loadGroups(true);
  fetchAccounts();
});
</script>

<style scoped>
.color-swatch {
  display: inline-block;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.12);
}
.color-swatch-inline {
  display: inline-block;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.12);
}
</style>
