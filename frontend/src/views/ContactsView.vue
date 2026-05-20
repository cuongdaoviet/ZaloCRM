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

    <!-- Data table -->
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

    <!-- Contact detail/edit dialog -->
    <ContactDetailDialog
      v-model="showDialog"
      :contact="selectedContact"
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
import ContactFilters from '@/components/contacts/ContactFilters.vue';
import ContactDetailDialog from '@/components/contacts/ContactDetailDialog.vue';
import { useContacts, SOURCE_OPTIONS, STATUS_OPTIONS } from '@/composables/use-contacts';
import type { Contact } from '@/composables/use-contacts';
import { useFriendship, type BulkResult } from '@/composables/use-friendship';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';

const { contacts, total, loading, filters, pagination, fetchContacts } = useContacts();
const { bulkEnqueue } = useFriendship();
const { accounts, fetchAccounts } = useZaloAccounts();

const showDialog = ref(false);
const selectedContact = ref<Contact | null>(null);
const selected = ref<string[]>([]);

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
  showDialog.value = true;
}

function onRowClick(_event: Event, row: { item: Contact }) {
  selectedContact.value = row.item;
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

onMounted(() => {
  fetchContacts();
  fetchAccounts();
});
</script>
