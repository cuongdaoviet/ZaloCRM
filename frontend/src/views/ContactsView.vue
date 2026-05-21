<template>
  <div>
    <!-- Toolbar -->
    <div class="d-flex align-center mb-4 flex-wrap gap-2">
      <h1 class="text-h5 mr-4">Khách hàng</h1>
      <v-spacer />
      <!-- Feature 0020: bulk "queue friend request" -->
      <v-btn
        v-if="selected.length > 0"
        color="primary"
        variant="tonal"
        prepend-icon="mdi-account-multiple-plus-outline"
        class="mr-2"
        @click="bulkFriendDialogOpen = true"
      >
        Đặt vào hàng đợi kết bạn ({{ selected.length }})
      </v-btn>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openCreate">Thêm KH</v-btn>
    </div>

    <!-- Filters -->
    <ContactFilters :filters="filters" @search="onFilterChange" />

    <!-- Data table — Feature 0042 BR-0005 / AC-0003: compact 40px rows so
         we fit ~6 columns on a 1280px viewport without horizontal scroll. -->
    <v-data-table
      v-model="selected"
      :headers="headers"
      :items="contacts"
      :loading="loading"
      :items-per-page="pagination.limit"
      :items-length="total"
      item-value="id"
      show-select
      hover
      density="compact"
      class="contacts-dense-table"
      @click:row="onRowClick"
      @update:page="onPageChange"
    >
      <!-- Avatar -->
      <template #item.avatarUrl="{ item }">
        <div class="d-flex align-center" style="gap: 4px;">
          <v-avatar size="32" color="grey-lighten-2">
            <v-img v-if="item.avatarUrl" :src="item.avatarUrl" />
            <v-icon v-else size="18">mdi-account</v-icon>
          </v-avatar>
          <v-btn
            icon size="x-small" variant="text"
            :to="`/contacts/${item.id}`"
            @click.stop
            title="Xem 360°"
          >
            <v-icon size="16">mdi-account-eye</v-icon>
          </v-btn>
        </div>
      </template>

      <!-- Lead score badge (Feature 0040) -->
      <template #item.leadScore="{ item }">
        <LeadScoreBadge
          :score="item.leadScore ?? 0"
          :breakdown="item.leadScoreBreakdown ?? null"
        />
      </template>

      <!-- Source chip -->
      <template #item.source="{ item }">
        <v-chip v-if="item.source" size="small" variant="tonal">
          {{ sourceLabel(item.source) }}
        </v-chip>
        <span v-else class="text-grey">—</span>
      </template>

      <!-- Email -->
      <template #item.email="{ item }">
        <span v-if="item.email" class="text-body-2">{{ item.email }}</span>
        <span v-else class="text-grey">—</span>
      </template>

      <!-- Status chip -->
      <template #item.status="{ item }">
        <v-chip
          v-if="item.status"
          :color="statusColor(item.status)"
          size="small"
          variant="tonal"
        >
          {{ statusLabel(item.status) }}
        </v-chip>
        <span v-else class="text-grey">—</span>
      </template>

      <!-- Next appointment date -->
      <template #item.nextAppointment="{ item }">
        <span v-if="item.nextAppointment" class="text-body-2">
          {{ formatDate(item.nextAppointment) }}
        </span>
        <span v-else class="text-grey">—</span>
      </template>

      <!-- First contact date -->
      <template #item.firstContactDate="{ item }">
        {{ item.firstContactDate ? new Date(item.firstContactDate).toLocaleDateString('vi-VN') : '—' }}
      </template>

      <!-- Assigned user -->
      <template #item.assignedUser="{ item }">
        <span class="text-body-2">{{ item.assignedUser?.fullName ?? '—' }}</span>
      </template>
    </v-data-table>

    <!-- Contact detail/edit dialog. Feature 0042 EC-0002: the Friends page
         deeplinks here with ?prefillName=…&prefillZaloUid=… so a user can
         turn a Zalo friend into a CRM Contact in one click. -->
    <ContactDetailDialog
      v-model="showDialog"
      :contact="selectedContact"
      :prefill="contactPrefill"
      @saved="onSaved"
      @deleted="onDeleted"
    />

    <!-- Feature 0020: bulk friendship enqueue dialog -->
    <v-dialog v-model="bulkFriendDialogOpen" max-width="520">
      <v-card>
        <v-card-title>Đặt {{ selected.length }} khách vào hàng đợi kết bạn</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-3 text-medium-emphasis">
            Hệ thống sẽ tra Zalo UID từ số điện thoại rồi gửi lời mời kết bạn cho mỗi khách,
            tôn trọng giới hạn 200 tin/ngày. Khách thiếu số điện thoại hoặc đã có lời mời
            đang chờ sẽ bị bỏ qua.
          </p>
          <v-select
            v-model="bulkAccount"
            :items="bulkAccountOptions"
            item-title="title"
            item-value="value"
            label="Gửi từ tài khoản Zalo"
            density="comfortable"
            class="mb-3"
          />
          <v-textarea
            v-model="bulkMessage"
            label="Lời nhắn (tối đa 200 ký tự, không bắt buộc)"
            counter="200"
            :rules="[(v: string) => (v?.length ?? 0) <= 200 || '≤200 ký tự']"
            rows="2"
            auto-grow
            hint="Hỗ trợ {{contactName}} và {{firstName}}"
            persistent-hint
          />
          <v-alert v-if="bulkResult" type="info" density="compact" class="mt-3">
            Đã đặt {{ bulkResult.totalQueued }} khách vào hàng đợi,
            bỏ qua {{ bulkResult.totalSkipped }}.
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closeBulkDialog">Đóng</v-btn>
          <v-btn
            color="primary"
            :loading="bulkSubmitting"
            :disabled="!bulkAccount"
            @click="submitBulkFriendship"
          >
            Đặt vào hàng đợi
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="3000">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import ContactFilters from '@/components/contacts/ContactFilters.vue';
import ContactDetailDialog, {
  type ContactPrefill,
} from '@/components/contacts/ContactDetailDialog.vue';
import LeadScoreBadge from '@/components/contacts/LeadScoreBadge.vue';
import { useContacts, SOURCE_OPTIONS, STATUS_OPTIONS } from '@/composables/use-contacts';
import type { Contact } from '@/composables/use-contacts';
import { useFriendship, type BulkResult } from '@/composables/use-friendship';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';

const route = useRoute();

const { contacts, total, loading, filters, pagination, fetchContacts } = useContacts();
const { bulkEnqueue } = useFriendship();
const { accounts, fetchAccounts } = useZaloAccounts();

const showDialog = ref(false);
const selectedContact = ref<Contact | null>(null);
const selected = ref<string[]>([]);
// Feature 0042 EC-0002 — payload set when the Friends page deeplinks in to
// create a new Contact from a Zalo friend. Cleared once the dialog closes.
const contactPrefill = ref<ContactPrefill | null>(null);

// Bulk friendship dialog
const bulkFriendDialogOpen = ref(false);
const bulkAccount = ref<string | null>(null);
const bulkMessage = ref('');
const bulkSubmitting = ref(false);
const bulkResult = ref<BulkResult | null>(null);
const toast = ref({ show: false, text: '', color: 'success' });

const bulkAccountOptions = computed(() =>
  accounts.value
    .filter((a) => a.status === 'connected')
    .map((a) => ({ title: a.displayName ?? 'Không tên', value: a.id })),
);

const headers = [
  { title: '', key: 'avatarUrl', sortable: false, width: '48px' },
  { title: 'Tên', key: 'fullName', sortable: true },
  // Feature 0040 — Lead score column. Sortable; we proxy sort clicks
  // through the BE which knows to re-rank the page (?sort=leadScore).
  { title: 'Lead', key: 'leadScore', sortable: true, width: '90px' },
  { title: 'SĐT', key: 'phone', sortable: false },
  { title: 'Email', key: 'email', sortable: false },
  { title: 'Nguồn', key: 'source', sortable: false },
  { title: 'Trạng thái', key: 'status', sortable: false },
  { title: 'Tái khám', key: 'nextAppointment', sortable: true },
  { title: 'Ngày tiếp nhận', key: 'firstContactDate', sortable: true },
  { title: 'Sale', key: 'assignedUser', sortable: false },
];

function sourceLabel(value: string) {
  return SOURCE_OPTIONS.find(o => o.value === value)?.text ?? value;
}

function statusLabel(value: string) {
  return STATUS_OPTIONS.find(o => o.value === value)?.text ?? value;
}

function statusColor(status: string) {
  const map: Record<string, string> = {
    new: 'grey',
    contacted: 'blue',
    interested: 'orange',
    converted: 'success',
    lost: 'error',
  };
  return map[status] ?? 'grey';
}

function formatDate(date: string) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('vi-VN');
}

function onFilterChange() {
  pagination.page = 1;
  fetchContacts();
}

function onPageChange(page: number) {
  pagination.page = page;
  fetchContacts();
}

function openCreate() {
  selectedContact.value = null;
  contactPrefill.value = null;
  showDialog.value = true;
}

function onRowClick(_event: Event, row: { item: Contact }) {
  selectedContact.value = row.item;
  contactPrefill.value = null;
  showDialog.value = true;
}

function onSaved() {
  fetchContacts();
}

function onDeleted() {
  fetchContacts();
}

function closeBulkDialog() {
  bulkFriendDialogOpen.value = false;
  bulkResult.value = null;
  bulkMessage.value = '';
}

async function submitBulkFriendship() {
  if (!bulkAccount.value || selected.value.length === 0) return;
  bulkSubmitting.value = true;
  const r = await bulkEnqueue(
    bulkAccount.value,
    [...selected.value],
    bulkMessage.value || undefined,
  );
  bulkSubmitting.value = false;
  if (r.ok) {
    bulkResult.value = r.result;
    toast.value = {
      show: true,
      text: `Đã đặt ${r.result.totalQueued} KH vào hàng đợi`,
      color: 'success',
    };
    selected.value = [];
  } else {
    toast.value = { show: true, text: r.error, color: 'error' };
  }
}

// Feature 0019: pre-seed tag filter from ?tagIds=A,B query (Customer 360 click).
function applyQueryFilters() {
  const raw = route.query.tagIds;
  let ids: string[] = [];
  if (Array.isArray(raw)) {
    ids = raw.filter((v): v is string => typeof v === 'string');
  } else if (typeof raw === 'string' && raw.length > 0) {
    ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (ids.length > 0) filters.tagIds = ids;
}

// Feature 0042 EC-0002 — pop the create dialog with a prefilled contact when
// the Friends page deeplinks in. We read `prefillName`, `prefillZaloUid`, and
// `prefillAvatarUrl`; any subset works and the dialog handles missing fields.
function applyContactPrefillFromQuery() {
  const q = route.query;
  const name = typeof q.prefillName === 'string' ? q.prefillName : '';
  const zaloUid = typeof q.prefillZaloUid === 'string' ? q.prefillZaloUid : '';
  const avatarUrl = typeof q.prefillAvatarUrl === 'string' ? q.prefillAvatarUrl : '';
  if (!name && !zaloUid) return;
  contactPrefill.value = {
    fullName: name || null,
    zaloUid: zaloUid || null,
    avatarUrl: avatarUrl || null,
    phone: null,
  };
  selectedContact.value = null;
  showDialog.value = true;
}

onMounted(() => {
  applyQueryFilters();
  fetchContacts();
  fetchAccounts();
  applyContactPrefillFromQuery();
});
</script>

<style scoped>
/* Feature 0042 BR-0005 — dense 40px row table.
   Vuetify's `density="compact"` lands ~36-44px depending on contents; we pin
   it to var(--smax-row-height-dense) so the page stays aligned with the
   Friends grid + chat list metrics defined in `tokens.css`. */
.contacts-dense-table :deep(tbody tr) {
  height: var(--smax-row-height-dense, 40px);
}
.contacts-dense-table :deep(tbody td) {
  padding-top: 0;
  padding-bottom: 0;
  font-size: 13px;
}
.contacts-dense-table :deep(thead th) {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}
</style>
