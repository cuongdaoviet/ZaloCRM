<template>
  <div>
    <!-- Feature 0053 F22 — page header was just the title + a far-right CTA
         with acres of empty space between. Now uses the band as a real toolbar:
         title on the left, inline status filter + search to fill the middle,
         CTA stays right-anchored. Matches OrdersView and ContactsView. -->
    <div class="d-flex align-center mb-4 ga-3 flex-wrap">
      <h1 class="text-h5 mb-0">Tài khoản Zalo</h1>
      <v-select
        v-model="statusFilter"
        :items="STATUS_FILTER_OPTIONS"
        item-title="title" item-value="value"
        density="compact" variant="outlined" hide-details
        prepend-inner-icon="mdi-filter-variant"
        clearable
        style="max-width: 200px;"
      />
      <v-text-field
        v-model="search"
        placeholder="Tìm theo tên, UID, SĐT…"
        density="compact" variant="outlined" hide-details
        prepend-inner-icon="mdi-magnify"
        clearable
        style="max-width: 280px;"
      />
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="showAddDialog = true">Thêm Zalo</v-btn>
    </div>

    <v-card>
      <v-data-table :headers="headers" :items="filteredAccounts" :loading="loading" no-data-text="Không tìm thấy tài khoản phù hợp">
        <template #item.status="{ item }">
          <v-chip :color="statusColor(item.liveStatus || item.status)" size="small" variant="flat">
            {{ statusText(item.liveStatus || item.status) }}
          </v-chip>
        </template>
        <template #item.acceptedNicksCount="{ item }">
          <span>{{ friendStatsByAccount[item.id]?.acceptedNicksCount ?? 0 }}</span>
        </template>
        <template #item.chattingNicksCount="{ item }">
          <v-tooltip :text="`Đang chat = có tin nhắn KH gửi đến trong ${windowDays} ngày gần đây`" location="top">
            <template #activator="{ props }">
              <span v-bind="props">{{ friendStatsByAccount[item.id]?.chattingNicksCount ?? 0 }}</span>
            </template>
          </v-tooltip>
        </template>
        <!-- Feature 0053 F21 — row actions follow the F12 (Feature 0049) pattern:
             ghost icon buttons (variant="text", no color) so the row no longer
             reads as a rainbow of saturated squares. Destructive delete keeps
             color="error" so it stays distinguishable; QR-login keeps
             color="primary" because it's the active CTA when an account isn't
             yet connected. -->
        <template #item.actions="{ item }">
          <v-btn v-if="authStore.isAdmin" icon variant="text" size="small" title="Phân quyền truy cập" @click="openAccess(item)">
            <v-icon size="20">mdi-shield-account</v-icon>
          </v-btn>
          <v-btn icon variant="text" size="small" @click="syncContacts(item.id)" title="Đồng bộ danh bạ Zalo" :loading="syncing === item.id">
            <v-icon size="20">mdi-account-sync</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon variant="text" size="small"
            @click="openHistoryDialog(item)"
            title="Đồng bộ lịch sử nhóm chat"
            :disabled="item.liveStatus !== 'connected'"
            :loading="syncingHistory === item.id">
            <v-icon size="20">mdi-history</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon variant="text" size="small"
            @click="openAutoReplyDialog(item)"
            title="Cấu hình auto-reply ngoài giờ"
          >
            <v-icon size="20">mdi-message-reply-text-outline</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon variant="text" size="small"
            @click="openProxyDialog(item)"
            title="Cấu hình proxy (HTTP/SOCKS5)"
          >
            <v-icon size="20">mdi-shield-link-variant-outline</v-icon>
          </v-btn>
          <v-btn v-if="item.liveStatus !== 'connected'" icon variant="text" size="small" color="primary" @click="loginAccount(item.id)" title="Đăng nhập QR">
            <v-icon size="20">mdi-qrcode</v-icon>
          </v-btn>
          <v-btn v-if="item.liveStatus === 'disconnected' && item.sessionData" icon variant="text" size="small" @click="reconnectAccount(item.id)" title="Kết nối lại">
            <v-icon size="20">mdi-refresh</v-icon>
          </v-btn>
          <v-btn icon variant="text" size="small" color="error" @click="confirmDelete(item)" title="Xóa">
            <v-icon size="20">mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Add account dialog -->
    <v-dialog v-model="showAddDialog" max-width="400">
      <v-card>
        <v-card-title>Thêm tài khoản Zalo</v-card-title>
        <v-card-text>
          <v-text-field v-model="newAccountName" label="Tên hiển thị (VD: Zalo Sale Hương)" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showAddDialog = false">Hủy</v-btn>
          <v-btn color="primary" :loading="adding" @click="handleAddAccount">Thêm</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- QR Code dialog -->
    <v-dialog v-model="showQRDialog" max-width="400" persistent>
      <v-card class="text-center pa-4">
        <v-card-title>Quét QR để đăng nhập Zalo</v-card-title>
        <v-card-text>
          <div v-if="qrImage" class="mb-4">
            <img :src="'data:image/png;base64,' + qrImage" alt="QR Code" style="max-width: 280px;" />
          </div>
          <div v-else-if="qrScanned" class="mb-4">
            <v-icon icon="mdi-check-circle" size="64" color="success" />
            <p class="text-h6 mt-2">Đã quét! Xác nhận trên điện thoại...</p>
            <p v-if="scannedName" class="text-body-2">{{ scannedName }}</p>
          </div>
          <div v-else class="mb-4">
            <v-progress-circular indeterminate color="primary" size="64" />
            <p class="mt-2">Đang tạo QR code...</p>
          </div>
          <v-alert v-if="qrError" type="error" density="compact" class="mt-2">{{ qrError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelQR">Đóng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm dialog -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xóa</v-card-title>
        <v-card-text>Bạn có chắc muốn xóa tài khoản "{{ deleteTarget?.displayName || deleteTarget?.id }}"?</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showDeleteDialog = false">Hủy</v-btn>
          <v-btn color="error" :loading="deleting" @click="handleDeleteAccount">Xóa</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Access control dialog -->
    <ZaloAccessDialog
      v-model="showAccessDialog"
      :account-id="accessTarget?.id ?? ''"
      :account-name="accessTarget?.displayName ?? accessTarget?.id ?? ''"
    />

    <!-- Auto-reply dialog -->
    <AutoReplyDialog
      v-model="showAutoReplyDialog"
      :account-id="autoReplyTarget?.id ?? ''"
      :account-name="autoReplyTarget?.displayName ?? autoReplyTarget?.id ?? ''"
    />

    <!-- Feature 0035 — Proxy config dialog (Admin/Owner only) -->
    <v-dialog v-model="showProxyDialog" max-width="520">
      <v-card>
        <v-card-title>Cấu hình Proxy</v-card-title>
        <v-card-subtitle v-if="proxyTarget">
          Tài khoản: <strong>{{ proxyTarget.displayName || proxyTarget.id }}</strong>
        </v-card-subtitle>
        <v-card-text>
          <v-text-field
            v-model="proxyInput"
            label="Proxy URL"
            placeholder="socks5://user:pass@host:1080 (để trống = trực tiếp)"
            density="compact"
            variant="outlined"
            :error-messages="proxyError ? [proxyError] : []"
            hide-details="auto"
            class="mb-2"
          />
          <p class="text-caption text-grey">
            Hỗ trợ <code>http://</code>, <code>https://</code>, <code>socks5://</code>.
            Để trống = kết nối trực tiếp.
          </p>
          <p v-if="proxyTarget?.proxyUrl" class="text-caption mt-2">
            Hiện tại:
            <code>{{ maskProxyUrlForDisplay(proxyTarget.proxyUrl) }}</code>
          </p>

          <v-alert
            v-if="proxyRequiresReconnect"
            type="warning"
            density="compact"
            class="mt-3"
            icon="mdi-refresh-alert"
          >
            <div class="d-flex align-center justify-space-between">
              <span>Đã đổi proxy — cần reconnect để áp dụng.</span>
              <v-btn
                size="small"
                color="warning"
                variant="tonal"
                :loading="proxyReconnecting"
                @click="reconnectFromProxyDialog"
              >Reconnect</v-btn>
            </div>
          </v-alert>
          <v-alert
            v-if="proxyServerError"
            type="error"
            density="compact"
            class="mt-3"
          >{{ proxyServerError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showProxyDialog = false">Đóng</v-btn>
          <v-btn
            color="primary"
            :loading="proxySaving"
            @click="saveProxy"
          >Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Sync group history dialog -->
    <v-dialog v-model="showHistoryDialog" max-width="480">
      <v-card>
        <v-card-title>Đồng bộ lịch sử nhóm chat</v-card-title>
        <v-card-text>
          <p class="mb-3 text-body-2">
            Tải <strong>{{ historyCount }}</strong> tin nhắn gần nhất của
            <strong>{{ historyGroupId ? '1 nhóm' : 'TẤT CẢ nhóm' }}</strong>
            trên tài khoản <strong>{{ historyTarget?.displayName }}</strong>.
            Có thể mất vài chục giây nếu có nhiều nhóm.
          </p>
          <v-text-field
            v-model="historyGroupId"
            label="Group ID (bỏ trống = tất cả nhóm)"
            density="compact" variant="outlined" hide-details
            placeholder="VD: 1234567890"
            class="mb-3"
          />
          <v-text-field
            v-model.number="historyCount"
            label="Số tin nhắn / nhóm (1–200)"
            type="number" min="1" max="200"
            density="compact" variant="outlined" hide-details
          />
          <v-alert
            v-if="historyResult"
            :type="historyResult.success ? 'success' : 'error'"
            density="compact" class="mt-3" closable
            @click:close="historyResult = null"
          >
            <div v-if="historyResult.success">
              Đã insert <strong>{{ historyResult.totalInserted }}</strong> tin mới,
              skip <strong>{{ historyResult.totalSkipped }}</strong> (đã tồn tại).
              Sync qua {{ historyResult.synced?.length ?? 0 }} nhóm.
            </div>
            <div v-else>{{ historyResult.error }}</div>
          </v-alert>
          <p class="text-caption mt-3 text-grey">
            💡 Lưu ý: zca-js không hỗ trợ lịch sử chat 1-1. Endpoint này chỉ sync nhóm.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showHistoryDialog = false">Đóng</v-btn>
          <v-btn
            color="primary" :loading="syncingHistory === historyTarget?.id"
            :disabled="!historyCount || historyCount < 1 || historyCount > 200"
            @click="runSyncHistory"
          >Đồng bộ</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  useZaloAccounts,
  type ZaloAccount,
  PROXY_URL_REGEX,
  maskProxyUrlForDisplay,
} from '@/composables/use-zalo-accounts';
import { useFriendStats } from '@/composables/use-friend-stats';
import { useAuthStore } from '@/stores/auth';
import ZaloAccessDialog from '@/components/settings/ZaloAccessDialog.vue';
import AutoReplyDialog from '@/components/settings/AutoReplyDialog.vue';
import { api } from '@/api/index';

const {
  accounts, loading, adding, deleting,
  showQRDialog, qrImage, qrScanned, scannedName, qrError,
  statusColor, statusText,
  fetchAccounts, addAccount, loginAccount, reconnectAccount, deleteAccount,
  updateProxy,
  cancelQR, setupSocket,
} = useZaloAccounts();

const authStore = useAuthStore();
// Feature 0033 — friend aggregates per nick.
const {
  stats: friendStats,
  byAccount: friendStatsByAccount,
  fetchStats: fetchFriendStats,
} = useFriendStats();
const windowDays = computed(() => friendStats.value?.windowDays ?? 7);

const showAddDialog = ref(false);
const syncing = ref<string | null>(null);
const syncingHistory = ref<string | null>(null);
const showDeleteDialog = ref(false);
const showAccessDialog = ref(false);
const showAutoReplyDialog = ref(false);
const showHistoryDialog = ref(false);
const newAccountName = ref('');
const deleteTarget = ref<ZaloAccount | null>(null);
const accessTarget = ref<ZaloAccount | null>(null);
const autoReplyTarget = ref<ZaloAccount | null>(null);
const historyTarget = ref<ZaloAccount | null>(null);

// Feature 0053 F22 — toolbar filter state.
const search = ref('');
const statusFilter = ref<string | null>(null);
const STATUS_FILTER_OPTIONS = [
  { title: 'Đang kết nối', value: 'connected' },
  { title: 'Mất kết nối', value: 'disconnected' },
  { title: 'Chưa đăng nhập', value: 'pending' },
];

const filteredAccounts = computed(() => {
  const q = search.value.trim().toLowerCase();
  const status = statusFilter.value;
  return accounts.value.filter((a) => {
    if (status && (a.liveStatus || a.status) !== status) return false;
    if (!q) return true;
    return (
      (a.displayName ?? '').toLowerCase().includes(q) ||
      (a.zaloUid ?? '').toLowerCase().includes(q) ||
      (a.phone ?? '').toLowerCase().includes(q)
    );
  });
});
const historyGroupId = ref('');
const historyCount = ref(50);
const historyResult = ref<
  | { success: true; totalInserted: number; totalSkipped: number; synced: unknown[] }
  | { success: false; error: string }
  | null
>(null);

// Feature 0035 — proxy dialog state.
const showProxyDialog = ref(false);
const proxyTarget = ref<ZaloAccount | null>(null);
const proxyInput = ref('');
const proxyError = ref<string | null>(null);
const proxyServerError = ref<string | null>(null);
const proxySaving = ref(false);
const proxyRequiresReconnect = ref(false);
const proxyReconnecting = ref(false);

function openProxyDialog(account: ZaloAccount) {
  proxyTarget.value = account;
  // Plain in edit input per SPEC; masking is only for display.
  proxyInput.value = account.proxyUrl ?? '';
  proxyError.value = null;
  proxyServerError.value = null;
  proxyRequiresReconnect.value = false;
  showProxyDialog.value = true;
}

async function saveProxy() {
  if (!proxyTarget.value) return;
  proxyError.value = null;
  proxyServerError.value = null;
  const raw = proxyInput.value.trim();
  if (raw !== '' && !PROXY_URL_REGEX.test(raw)) {
    proxyError.value = 'Định dạng không hợp lệ. Ví dụ: socks5://user:pass@host:1080';
    return;
  }
  proxySaving.value = true;
  try {
    const res = await updateProxy(proxyTarget.value.id, raw === '' ? null : raw);
    proxyRequiresReconnect.value = !!res.requiresReconnect;
    // Update local copy so the dialog reflects the normalized value (eg. socks→socks5).
    proxyTarget.value = { ...proxyTarget.value, proxyUrl: res.proxyUrl };
    await fetchAccounts();
  } catch (err: any) {
    const code = err?.response?.data?.code;
    if (code === 'invalid_proxy_format') {
      proxyError.value = 'Định dạng không hợp lệ. Backend từ chối URL này.';
    } else if (err?.response?.status === 403) {
      proxyServerError.value = 'Bạn không có quyền cấu hình proxy.';
    } else {
      proxyServerError.value =
        err?.response?.data?.error || err?.message || 'Không thể lưu proxy';
    }
  } finally {
    proxySaving.value = false;
  }
}

async function reconnectFromProxyDialog() {
  if (!proxyTarget.value) return;
  proxyReconnecting.value = true;
  try {
    await reconnectAccount(proxyTarget.value.id);
    proxyRequiresReconnect.value = false;
  } finally {
    proxyReconnecting.value = false;
  }
}

const headers = [
  { title: 'Tên', key: 'displayName', sortable: true },
  { title: 'Zalo UID', key: 'zaloUid' },
  { title: 'SĐT', key: 'phone' },
  { title: 'Trạng thái', key: 'status', sortable: true },
  // Feature 0033 — friend aggregate counts (read-only).
  { title: 'Bạn đã accept', key: 'acceptedNicksCount', sortable: false, align: 'end' as const },
  { title: 'Đang chat', key: 'chattingNicksCount', sortable: false, align: 'end' as const },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const },
];

async function syncContacts(accountId: string) {
  syncing.value = accountId;
  try {
    const res = await api.post(`/zalo-accounts/${accountId}/sync-contacts`);
    alert(`Đồng bộ thành công: ${res.data.created} mới, ${res.data.updated} cập nhật`);
  } catch (err: any) {
    alert('Đồng bộ thất bại: ' + (err.response?.data?.error || err.message));
  } finally {
    syncing.value = null;
  }
}

function openHistoryDialog(account: ZaloAccount) {
  historyTarget.value = account;
  historyGroupId.value = '';
  historyCount.value = 50;
  historyResult.value = null;
  showHistoryDialog.value = true;
}

async function runSyncHistory() {
  if (!historyTarget.value) return;
  const accountId = historyTarget.value.id;
  syncingHistory.value = accountId;
  historyResult.value = null;
  try {
    const payload: { count: number; groupId?: string } = { count: historyCount.value };
    if (historyGroupId.value.trim()) payload.groupId = historyGroupId.value.trim();
    const res = await api.post(`/zalo-accounts/${accountId}/sync-group-history`, payload);
    historyResult.value = {
      success: true,
      totalInserted: res.data.totalInserted,
      totalSkipped: res.data.totalSkipped,
      synced: res.data.synced ?? [],
    };
  } catch (err: any) {
    historyResult.value = {
      success: false,
      error: err.response?.data?.error || err.message || 'Đồng bộ thất bại',
    };
  } finally {
    syncingHistory.value = null;
  }
}

async function handleAddAccount() {
  const ok = await addAccount(newAccountName.value);
  if (ok) {
    showAddDialog.value = false;
    newAccountName.value = '';
  }
}

function confirmDelete(account: ZaloAccount) {
  deleteTarget.value = account;
  showDeleteDialog.value = true;
}

function openAccess(account: ZaloAccount) {
  accessTarget.value = account;
  showAccessDialog.value = true;
}

function openAutoReplyDialog(account: ZaloAccount) {
  autoReplyTarget.value = account;
  showAutoReplyDialog.value = true;
}

async function handleDeleteAccount() {
  if (!deleteTarget.value) return;
  const ok = await deleteAccount(deleteTarget.value);
  if (ok) {
    showDeleteDialog.value = false;
    deleteTarget.value = null;
  }
}

onMounted(() => {
  fetchAccounts();
  setupSocket();
  // Friend aggregate stats — best-effort; the table renders 0 if it errors.
  fetchFriendStats();
});
</script>
