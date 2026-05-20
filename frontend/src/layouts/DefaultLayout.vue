<template>
  <v-app :class="{ 'liquid-bg': isDark }">
    <!-- Top bar — glass effect -->
    <v-app-bar density="comfortable" flat>
      <v-app-bar-nav-icon @click="drawer = !drawer" />

      <!-- AI Core Orb + Title -->
      <div class="d-flex align-center" style="gap: 12px;">
        <div
          class="ai-core-orb d-flex align-center justify-center"
          style="width: 32px; height: 32px; background: linear-gradient(135deg, #00F2FF, #0077B6);"
        >
          <v-icon size="18" color="white">mdi-robot</v-icon>
        </div>
        <v-app-bar-title>
          <span class="font-weight-bold">Zalo</span><span class="text-primary">CRM</span>
        </v-app-bar-title>
      </div>

      <!-- Global search -->
      <GlobalSearch class="mx-2" />

      <v-spacer />

      <!-- Status indicator -->
      <div
        class="d-flex align-center mr-4 px-3 py-1 rounded-pill"
        style="background: rgba(76,175,80,0.1); border: 1px solid rgba(76,175,80,0.2);"
      >
        <span
          class="status-dot bg-success"
          style="width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px;"
        ></span>
        <span class="text-caption text-success font-weight-bold" style="letter-spacing: 1px;">ONLINE</span>
      </div>

      <span class="text-body-2 mr-3" v-if="authStore.user">{{ authStore.user.fullName }}</span>
      <NotificationBell />
      <v-btn icon variant="text" @click="toggleTheme">
        <v-icon>{{ isDark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}</v-icon>
      </v-btn>
      <v-btn icon variant="text" @click="logout">
        <v-icon>mdi-logout</v-icon>
      </v-btn>
    </v-app-bar>

    <!-- Sidebar navigation -->
    <v-navigation-drawer v-model="drawer" :rail="rail" permanent @click="rail = false">
      <v-list density="compact" nav class="mt-2">
        <v-list-item
          v-for="item in visibleMenuItems"
          :key="item.path"
          :to="item.path"
          :prepend-icon="item.icon"
          :title="item.title"
          :value="item.path"
          rounded="xl"
          class="mb-1 mx-2"
        />
      </v-list>

      <template #append>
        <v-list density="compact" nav>
          <v-list-item
            prepend-icon="mdi-chevron-left"
            title="Thu gọn"
            @click.stop="rail = !rail"
            rounded="xl"
            class="mx-2"
          />
        </v-list>
      </template>
    </v-navigation-drawer>

    <!-- Main content -->
    <v-main>
      <v-container fluid>
        <slot />
      </v-container>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useTheme } from 'vuetify';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import NotificationBell from '@/components/NotificationBell.vue';
import GlobalSearch from '@/components/GlobalSearch.vue';
import { useUserPreferences } from '@/composables/use-user-preferences';

const theme = useTheme();
const authStore = useAuthStore();
const router = useRouter();

const drawer = ref(true);
const rail = ref(false);

// Feature 0016: theme is persisted server-side as `ui.theme` (per-user).
// localStorage is kept as a fast-path read on initial load so we don't flash
// the wrong theme while the API call is in flight; we write through to both.
const { usePref } = useUserPreferences();
const initialTheme: 'dark' | 'light' =
  localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
const themePref = usePref<'dark' | 'light'>('ui.theme', initialTheme);
const isDark = computed(() => themePref.value === 'dark');

// Apply theme + mirror to localStorage on every change.
watch(
  themePref,
  (val) => {
    theme.global.name.value = val === 'dark' ? 'dark' : 'light';
    localStorage.setItem('theme', val);
  },
  { immediate: false },
);

onMounted(() => {
  theme.global.name.value = isDark.value ? 'dark' : 'light';
});

interface MenuItem {
  title: string;
  icon: string;
  path: string;
  adminOnly?: boolean;
}

const menuItems: MenuItem[] = [
  { title: 'Dashboard', icon: 'mdi-view-dashboard-outline', path: '/' },
  { title: 'Tin nhắn', icon: 'mdi-message-text-outline', path: '/chat' },
  { title: 'Tìm tin nhắn', icon: 'mdi-text-search', path: '/search' },
  { title: 'Khách hàng', icon: 'mdi-account-group-outline', path: '/contacts' },
  { title: 'Tài khoản Zalo', icon: 'mdi-cellphone-link', path: '/zalo-accounts' },
  { title: 'Lịch hẹn', icon: 'mdi-calendar-clock-outline', path: '/appointments' },
  { title: 'Đơn hàng', icon: 'mdi-cart-outline', path: '/orders' },
  { title: 'Báo cáo', icon: 'mdi-chart-arc', path: '/reports' },
  { title: 'KPI & Leaderboard', icon: 'mdi-trophy-outline', path: '/kpi', adminOnly: true },
  { title: 'Chiến dịch', icon: 'mdi-bullhorn-outline', path: '/campaigns', adminOnly: true },
  { title: 'Kết bạn', icon: 'mdi-account-multiple-plus-outline', path: '/friends' },
  { title: 'Auto-tag keyword', icon: 'mdi-tag-text-outline', path: '/keyword-rules' },
  { title: 'Hoạt động', icon: 'mdi-history', path: '/activity', adminOnly: true },
  { title: 'Khách trùng', icon: 'mdi-account-multiple-remove-outline', path: '/duplicate-groups', adminOnly: true },
  { title: 'Nhân viên', icon: 'mdi-account-cog-outline', path: '/settings' },
  { title: 'Tin nhắn mẫu', icon: 'mdi-message-flash-outline', path: '/quick-replies' },
  { title: 'API & Webhook', icon: 'mdi-api', path: '/api-settings' },
];

const visibleMenuItems = computed(() =>
  menuItems.filter((m) => !m.adminOnly || authStore.isAdmin),
);

function toggleTheme() {
  themePref.value = isDark.value ? 'light' : 'dark';
}

function logout() {
  authStore.logout();
  router.push('/login');
}
</script>
