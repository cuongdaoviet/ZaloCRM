<template>
  <div class="friends-page">
    <div class="d-flex align-center mb-4 flex-wrap ga-2">
      <h1 class="text-h5">Bạn bè</h1>
      <v-chip
        v-if="!loading && total > 0"
        size="small"
        variant="tonal"
        color="primary"
      >{{ total }} bạn</v-chip>
      <v-spacer />
      <v-btn
        variant="text"
        prepend-icon="mdi-refresh"
        :loading="loading"
        @click="reload"
      >Làm mới</v-btn>
    </div>

    <!-- Filters -->
    <v-card class="pa-3 mb-3">
      <div class="d-flex flex-wrap ga-3">
        <v-text-field
          v-model="searchQuery"
          label="Tìm tên / SĐT"
          density="compact"
          variant="outlined"
          prepend-inner-icon="mdi-magnify"
          clearable
          hide-details
          style="min-width: 240px; flex: 1 1 240px;"
          @update:model-value="onSearchChange"
        />
        <v-select
          v-model="filterAccount"
          :items="accountOptions"
          item-title="title"
          item-value="value"
          label="Tài khoản Zalo"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 220px; flex: 0 1 220px;"
          @update:model-value="onFilterChange"
        />
      </div>
    </v-card>

    <v-alert
      v-if="error"
      type="error"
      density="compact"
      closable
      class="mb-3"
    >{{ error }}</v-alert>

    <!-- Empty state -->
    <v-card
      v-if="!loading && friends.length === 0"
      class="pa-8 text-center"
      variant="outlined"
    >
      <v-icon size="64" color="grey">mdi-account-multiple-outline</v-icon>
      <h2 class="text-h6 mt-3">Chưa có bạn bè nào</h2>
      <p class="text-body-2 text-medium-emphasis mt-2">
        Thêm tài khoản Zalo và bắt đầu kết bạn để hiển thị danh sách ở đây.
      </p>
      <v-btn
        color="primary"
        prepend-icon="mdi-plus"
        class="mt-3"
        to="/zalo-accounts"
      >Thêm tài khoản Zalo</v-btn>
    </v-card>

    <!-- Loading skeleton -->
    <v-row v-else-if="loading && friends.length === 0" dense>
      <v-col
        v-for="i in 6"
        :key="i"
        cols="12"
        sm="6"
        md="4"
      >
        <v-skeleton-loader type="card" />
      </v-col>
    </v-row>

    <!-- Grid -->
    <v-row v-else dense>
      <v-col
        v-for="friend in friends"
        :key="friend.id"
        cols="12"
        sm="6"
        md="4"
      >
        <FriendCard
          :friend="friend"
          @create-contact="onCreateContact"
        />
      </v-col>
    </v-row>

    <!-- Pagination -->
    <div v-if="pagination.totalPages > 1" class="d-flex justify-center mt-4">
      <v-pagination
        v-model="currentPage"
        :length="pagination.totalPages"
        :total-visible="7"
        @update:model-value="reload"
      />
    </div>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="3000">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import FriendCard from '@/components/friends/FriendCard.vue';
import { useFriends, type FriendListItem } from '@/composables/use-friends';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';

const router = useRouter();

const {
  friends,
  pagination,
  loading,
  error,
  total,
  fetchFriends,
} = useFriends();

const { accounts, fetchAccounts } = useZaloAccounts();

const searchQuery = ref('');
const filterAccount = ref<string | null>(null);
const currentPage = ref(1);
const toast = ref({ show: false, text: '', color: 'success' });

const accountOptions = computed(() =>
  accounts.value.map((a) => ({
    title: a.displayName ?? 'Không tên',
    value: a.id,
  })),
);

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function onSearchChange() {
  // Debounce search input → reset to page 1 then reload.
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    reload();
  }, 300);
}

function onFilterChange() {
  currentPage.value = 1;
  reload();
}

async function reload() {
  await fetchFriends({
    accountId: filterAccount.value ?? undefined,
    search: searchQuery.value,
    page: currentPage.value,
    perPage: 24,
  });
}

function onCreateContact(friend: FriendListItem) {
  // EC-0002 — friend without a CRM contact: send to Contacts page with
  // a prefill payload so the user can fill in the rest. The Contacts page
  // is in charge of handling the query string today; for now we just
  // surface a hint and route them there.
  toast.value = {
    show: true,
    text: 'Đang chuyển sang trang Khách hàng để tạo Contact mới…',
    color: 'info',
  };
  router.push({
    path: '/contacts',
    query: {
      prefillName: friend.displayName ?? '',
      prefillZaloUid: friend.zaloUid,
    },
  });
}

// Re-sync the local page ref if the server rounds it down (e.g. last page
// became empty after a search). Stays purely defensive.
watch(
  () => pagination.value.page,
  (p) => {
    currentPage.value = p;
  },
);

onMounted(async () => {
  await Promise.all([fetchAccounts(), reload()]);
});
</script>

<style scoped>
.friends-page {
  /* Keep the page comfortable on wide screens without ballooning card sizes. */
  max-width: 1400px;
  margin: 0 auto;
}
</style>
