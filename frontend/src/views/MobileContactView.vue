<template>
  <!-- Feature 0039 — mobile Contacts surface (ported from ZaloCRM-3.0's
       MobileContactView.vue). Differences from 3.0:
        - Filter chip row carries our STATUS_OPTIONS (not 3.0's hard-coded
          enum); the chip colours come from the same `statusColor()` map
          ContactsView uses so desktop ↔ mobile stay visually aligned.
        - Each card surfaces the LeadScoreBadge (Feature 0040). 3.0 didn't
          have lead scores, but tapping mobile-first without seeing them
          felt like a regression.
        - "Tạo Contact" reuses ContactDetailDialog (full-screen on mobile
          via fullscreen prop) instead of routing to a separate page.
        - Bottom-sheet filter dialog covers tag + source + name search so
          mobile users can reach every filter the desktop rail exposes
          (BR-0006 / AC-0006). -->
  <div class="mobile-contacts pa-3">
    <!-- Top search + filter affordances. Tap the funnel to open the
         bottom-sheet for source / tag / status filters. -->
    <div class="d-flex align-center mb-3" style="gap: 8px;">
      <v-text-field
        v-model="filters.search"
        placeholder="Tìm khách hàng..."
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        density="compact"
        hide-details
        clearable
        rounded="xl"
        class="flex-grow-1"
        @update:model-value="onSearch"
      />
      <v-btn
        icon
        variant="tonal"
        color="primary"
        class="smax-touch-target"
        aria-label="Bộ lọc"
        @click="showFilterSheet = true"
      >
        <v-icon>mdi-tune-variant</v-icon>
        <v-badge
          v-if="extraFilterCount > 0"
          :content="extraFilterCount"
          color="error"
          floating
          inline
        />
      </v-btn>
    </div>

    <!-- Status chip strip — horizontally scrollable so a long status list
         doesn't break to two rows on narrow phones. -->
    <div class="status-chip-row d-flex mb-3" style="gap: 6px;">
      <v-chip
        v-for="status in STATUS_OPTIONS"
        :key="status.value"
        :color="filters.status === status.value ? statusColor(status.value) : undefined"
        :variant="filters.status === status.value ? 'flat' : 'outlined'"
        size="small"
        class="status-chip-row__chip"
        @click="toggleStatus(status.value)"
      >
        {{ status.text }}
      </v-chip>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="d-flex justify-center py-8">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <!-- Empty state -->
    <div
      v-else-if="contacts.length === 0"
      class="text-center py-8 text-medium-emphasis"
    >
      Không tìm thấy khách hàng
    </div>

    <!-- Contact cards (tonal v-card per 3.0 design language). Each card
         is its own tap target so the 44px floor applies via min-height
         on the card root. -->
    <div v-else class="d-flex flex-column" style="gap: 8px;">
      <v-card
        v-for="contact in contacts"
        :key="contact.id"
        variant="tonal"
        rounded="xl"
        class="contact-card pa-3 smax-touch-target"
        @click="openContact(contact)"
      >
        <div class="d-flex align-center" style="gap: 12px;">
          <v-avatar size="44" color="grey-lighten-2">
            <v-img v-if="contact.avatarUrl" :src="contact.avatarUrl" />
            <v-icon v-else size="22">mdi-account</v-icon>
          </v-avatar>
          <div style="flex: 1; min-width: 0;">
            <div class="text-body-2 font-weight-medium text-truncate">
              {{ contact.fullName ?? 'Chưa đặt tên' }}
            </div>
            <div class="text-caption text-medium-emphasis text-truncate">
              {{ contact.phone || contact.email || 'Chưa có liên hệ' }}
            </div>
          </div>
          <div class="d-flex flex-column align-end" style="gap: 4px;">
            <LeadScoreBadge
              :score="contact.leadScore ?? 0"
              :breakdown="contact.leadScoreBreakdown ?? null"
            />
            <v-chip
              v-if="contact.status"
              :color="statusColor(contact.status)"
              size="x-small"
              variant="tonal"
            >
              {{ statusLabel(contact.status) }}
            </v-chip>
          </div>
        </div>
      </v-card>
    </div>

    <!-- FAB — "Thêm khách hàng". Sits above the bottom nav (88px = 56 nav
         + 16 breathing room + 16 indicator margin). -->
    <v-btn
      icon
      color="primary"
      size="large"
      class="contact-fab smax-touch-target"
      aria-label="Thêm khách hàng"
      @click="openCreate"
    >
      <v-icon>mdi-plus</v-icon>
    </v-btn>

    <!-- Bottom sheet — AC-0006. Hosts source / tag / status filters that
         don't fit on the chip strip. Re-uses the desktop ContactFilters
         field set verbatim where possible. -->
    <v-dialog
      v-model="showFilterSheet"
      :fullscreen="false"
      transition="dialog-bottom-transition"
      max-width="100%"
      class="mobile-filter-dialog"
    >
      <v-card rounded="t-xl">
        <v-card-title class="d-flex align-center">
          <span>Bộ lọc</span>
          <v-spacer />
          <v-btn variant="text" @click="showFilterSheet = false">Đóng</v-btn>
        </v-card-title>
        <v-card-text>
          <v-select
            v-model="filters.source"
            :items="SOURCE_OPTIONS"
            item-title="text"
            item-value="value"
            label="Nguồn"
            clearable
            hide-details
            class="mb-3"
            @update:model-value="onFilterChange"
          />
          <v-select
            v-model="filters.status"
            :items="STATUS_OPTIONS"
            item-title="text"
            item-value="value"
            label="Trạng thái"
            clearable
            hide-details
            class="mb-3"
            @update:model-value="onFilterChange"
          />
          <!-- Tag picker — only mount when the sheet is open so we don't
               pay the network round-trip to /tags on every mobile view
               mount. -->
          <TagPicker
            v-if="showFilterSheet"
            :model-value="filters.tagIds ?? []"
            label="Nhãn"
            placeholder="Lọc theo nhãn"
            @update:model-value="onTagsChange"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="resetSheetFilters">Xóa lọc</v-btn>
          <v-btn color="primary" @click="showFilterSheet = false">Áp dụng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Contact detail dialog. ContactDetailDialog uses `max-width: 680`
         which on a 360-414px phone resolves to ~the full viewport width,
         giving us an effectively full-screen modal without changing the
         dialog's prop surface. -->
    <ContactDetailDialog
      v-model="showDialog"
      :contact="selectedContact"
      @saved="onSaved"
      @deleted="onDeleted"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ContactDetailDialog from '@/components/contacts/ContactDetailDialog.vue';
import LeadScoreBadge from '@/components/contacts/LeadScoreBadge.vue';
import TagPicker from '@/components/tags/TagPicker.vue';
import {
  useContacts,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  type Contact,
} from '@/composables/use-contacts';

const { contacts, loading, filters, pagination, fetchContacts } = useContacts();

const showDialog = ref(false);
const showFilterSheet = ref(false);
const selectedContact = ref<Contact | null>(null);

// Status chip + bottom-sheet filter counts: badge the funnel button so a
// user knows filters are active even when the chip strip is scrolled out.
const extraFilterCount = computed(() => {
  let n = 0;
  if (filters.source) n++;
  if ((filters.tagIds ?? []).length > 0) n++;
  return n;
});

function statusColor(status: string): string {
  const map: Record<string, string> = {
    new: 'grey',
    contacted: 'blue',
    interested: 'orange',
    converted: 'success',
    lost: 'error',
  };
  return map[status] ?? 'grey';
}

function statusLabel(value: string): string {
  return STATUS_OPTIONS.find((o) => o.value === value)?.text ?? value;
}

function toggleStatus(value: string) {
  filters.status = filters.status === value ? '' : value;
  pagination.page = 1;
  fetchContacts();
}

// 300ms debounce mirrors the desktop ContactsView pattern so the BE search
// endpoint sees consistent traffic. setTimeout handle is module-scoped (not
// reactive) so it can be cleared cleanly on unmount.
let searchTimeout: ReturnType<typeof setTimeout> | undefined;
function onSearch() {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    pagination.page = 1;
    fetchContacts();
  }, 300);
}

function onFilterChange() {
  pagination.page = 1;
  fetchContacts();
}

function onTagsChange(ids: string[]) {
  filters.tagIds = ids;
  onFilterChange();
}

function resetSheetFilters() {
  filters.source = '';
  filters.status = '';
  filters.tagIds = [];
  pagination.page = 1;
  fetchContacts();
}

function openContact(contact: Contact) {
  selectedContact.value = contact;
  showDialog.value = true;
}

function openCreate() {
  selectedContact.value = null;
  showDialog.value = true;
}

function onSaved() {
  fetchContacts();
}

function onDeleted() {
  fetchContacts();
}

onMounted(() => fetchContacts());
onUnmounted(() => {
  if (searchTimeout) clearTimeout(searchTimeout);
});
</script>

<style scoped>
.mobile-contacts {
  /* Keep room for the FAB + bottom nav without the cards getting clipped
     when the user scrolls to the last item. */
  padding-bottom: 96px;
}

/* Horizontally scrollable chip strip — overflow-x: auto + nowrap, plus
   `-webkit-overflow-scrolling: touch` for iOS Safari momentum scroll. */
.status-chip-row {
  flex-wrap: nowrap;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 2px; /* avoid clipping bottom shadow of active chip */
}
.status-chip-row__chip {
  flex-shrink: 0;
}

.contact-card {
  cursor: pointer;
}

.contact-fab {
  /* Pinned at the bottom-right corner above the bottom nav. The 88px
     offset = 56px nav + 16px breathing room + 16px FAB padding so a
     dragged-up keyboard on iOS doesn't bury it. */
  position: fixed;
  bottom: 88px;
  right: 16px;
  z-index: 50;
}
</style>
