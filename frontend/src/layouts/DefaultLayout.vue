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
      <v-list
        v-model:opened="openedGroups"
        density="compact"
        nav
        class="mt-2"
      >
        <template v-for="group in visibleMenuGroups" :key="group.id">
          <!-- Ungrouped row (e.g. Dashboard) — no header, render flat. -->
          <template v-if="!group.label">
            <v-list-item
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              :prepend-icon="item.icon"
              :title="item.title"
              :value="item.path"
              rounded="xl"
              class="mb-1 mx-2"
            />
          </template>

          <!-- Grouped rows — collapsible v-list-group, single-expand. -->
          <v-list-group v-else :value="group.id">
            <template #activator="{ props: activatorProps }">
              <v-list-item
                v-bind="activatorProps"
                :prepend-icon="group.icon"
                :title="group.label"
                rounded="xl"
                class="mb-1 mx-2 sidebar-group-activator"
              />
            </template>
            <v-list-item
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              :prepend-icon="item.icon"
              :title="item.title"
              :value="item.path"
              rounded="xl"
              class="mb-1 mx-2"
            />
          </v-list-group>
        </template>
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
import { useRoute, useRouter } from 'vue-router';
import NotificationBell from '@/components/NotificationBell.vue';
import GlobalSearch from '@/components/GlobalSearch.vue';
import { useUserPreferences } from '@/composables/use-user-preferences';

const theme = useTheme();
const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();

const drawer = ref(true);
const rail = ref(false);

// Feature 0016: theme is persisted server-side as `ui.theme` (per-user).
// localStorage is kept as a fast-path read on initial load so we don't flash
// the wrong theme while the API call is in flight; we write through to both.
// Stored value is the user-facing key 'light' | 'dark'; it maps to the
// Vuetify theme names 'smax-light' | 'legacy-dark' when applied.
const { usePref } = useUserPreferences();
const initialTheme: 'dark' | 'light' =
  localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
const themePref = usePref<'dark' | 'light'>('ui.theme', initialTheme);
const isDark = computed(() => themePref.value === 'dark');

function applyTheme(val: 'dark' | 'light') {
  theme.global.name.value = val === 'dark' ? 'legacy-dark' : 'smax-light';
}

// Apply theme + mirror to localStorage on every change.
watch(
  themePref,
  (val) => {
    applyTheme(val);
    localStorage.setItem('theme', val);
  },
  { immediate: false },
);

onMounted(() => {
  applyTheme(themePref.value);
});

interface MenuItem {
  title: string;
  icon: string;
  path: string;
  adminOnly?: boolean;
}

interface MenuGroup {
  id: string;
  label: string | null; // null = ungrouped row (e.g. Dashboard anchor)
  icon?: string;        // header icon (required when label is non-null)
  items: MenuItem[];
}

// Feature 0047 — sidebar grouped by functional domain.
// Order: Dashboard anchor → Chat (most-used) → CRM → Marketing/Automation →
// Reports → System. Each labelled group renders as a collapsible
// v-list-group; only one is open at a time, and the group containing the
// active route auto-opens on mount + route change.
const menuGroups: MenuGroup[] = [
  {
    id: 'home',
    label: null,
    items: [
      { title: 'Dashboard', icon: 'mdi-view-dashboard-outline', path: '/' },
    ],
  },
  {
    id: 'chat',
    label: 'Trò chuyện',
    icon: 'mdi-chat-outline',
    items: [
      { title: 'Tin nhắn', icon: 'mdi-message-text-outline', path: '/chat' },
      { title: 'Tìm tin nhắn', icon: 'mdi-text-search', path: '/search' },
      { title: 'Tin nhắn mẫu', icon: 'mdi-message-flash-outline', path: '/quick-replies' },
    ],
  },
  {
    id: 'crm',
    label: 'Khách hàng',
    icon: 'mdi-account-group-outline',
    items: [
      { title: 'Khách hàng', icon: 'mdi-account-group-outline', path: '/contacts' },
      { title: 'Bạn bè', icon: 'mdi-account-multiple-outline', path: '/friends' },
      { title: 'Kết bạn', icon: 'mdi-account-multiple-plus-outline', path: '/friendship-attempts' },
      { title: 'Khách trùng', icon: 'mdi-account-multiple-remove-outline', path: '/duplicate-groups', adminOnly: true },
      { title: 'Lịch hẹn', icon: 'mdi-calendar-clock-outline', path: '/appointments' },
      { title: 'Đơn hàng', icon: 'mdi-cart-outline', path: '/orders' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing & Automation',
    icon: 'mdi-bullhorn-outline',
    items: [
      { title: 'Chiến dịch', icon: 'mdi-bullhorn-outline', path: '/campaigns', adminOnly: true },
      { title: 'Auto-tag keyword', icon: 'mdi-tag-text-outline', path: '/keyword-rules' },
      // Feature 0037 — Workflow automation engine (phase 1).
      { title: 'Workflow tự động', icon: 'mdi-pipe', path: '/settings/workflows', adminOnly: true },
      // Feature 0036 — AI reply suggestions (BYOK).
      { title: 'Gợi ý AI', icon: 'mdi-robot-outline', path: '/settings/ai-config', adminOnly: true },
      // Feature 0038 — Integration Hub (Sheets + Telegram).
      { title: 'Integrations', icon: 'mdi-puzzle', path: '/settings/integrations', adminOnly: true },
    ],
  },
  {
    id: 'reports',
    label: 'Báo cáo',
    icon: 'mdi-chart-arc',
    items: [
      { title: 'Báo cáo', icon: 'mdi-chart-arc', path: '/reports' },
      { title: 'KPI & Leaderboard', icon: 'mdi-trophy-outline', path: '/kpi', adminOnly: true },
      { title: 'Phân tích nâng cao', icon: 'mdi-chart-timeline-variant', path: '/analytics', adminOnly: true },
      { title: 'Hoạt động', icon: 'mdi-history', path: '/activity', adminOnly: true },
    ],
  },
  {
    id: 'system',
    label: 'Hệ thống',
    icon: 'mdi-cog-outline',
    items: [
      { title: 'Tài khoản Zalo', icon: 'mdi-cellphone-link', path: '/zalo-accounts' },
      { title: 'Nhân viên', icon: 'mdi-account-cog-outline', path: '/settings' },
      { title: 'Quản lý nhãn', icon: 'mdi-tag-multiple-outline', path: '/settings/tags', adminOnly: true },
      // Feature 0040 — Lead score admin config.
      { title: 'Lead score', icon: 'mdi-fire', path: '/settings/lead-score', adminOnly: true },
      { title: 'API & Webhook', icon: 'mdi-api', path: '/api-settings' },
    ],
  },
];

// Filter admin-only items, then drop any group that ends up empty so the
// header doesn't orphan above zero rows.
const visibleMenuGroups = computed(() =>
  menuGroups
    .map((g) => ({
      ...g,
      items: g.items.filter((m) => !m.adminOnly || authStore.isAdmin),
    }))
    .filter((g) => g.items.length > 0),
);

// Single-expand accordion: at most one group open at a time. Vuetify's
// v-list `opened` prop is an array — we enforce length ≤ 1 in the watcher
// that fires when the user clicks a different header.
const openedGroups = ref<string[]>([]);

// Find which group owns a given path. Falls back to '' (no group) for
// ungrouped rows like Dashboard. Longest-prefix wins so '/settings/tags'
// matches the System group's '/settings' entry correctly — but since we
// match exact paths from the menu config first, prefix matching is only
// needed for child routes (e.g. '/contacts/:id' → CRM group).
function groupIdForPath(path: string): string {
  for (const g of menuGroups) {
    if (!g.label) continue; // ungrouped
    const hit = g.items.find(
      (i) => path === i.path || path.startsWith(i.path + '/'),
    );
    if (hit) return g.id;
  }
  return '';
}

// Sync opened group to the active route. Runs on mount + every navigation.
// We only auto-open; we don't auto-close, so the user's manual expansion
// stays put until they navigate into a different group.
watch(
  () => route.path,
  (path) => {
    const gid = groupIdForPath(path);
    if (gid && !openedGroups.value.includes(gid)) {
      openedGroups.value = [gid];
    }
  },
  { immediate: true },
);

// Enforce single-expand: when the user clicks a second header, drop the
// previously-open group. Vuetify normally allows multi-open; we cap to 1.
watch(openedGroups, (val) => {
  if (val.length > 1) {
    openedGroups.value = [val[val.length - 1]];
  }
});

function toggleTheme() {
  themePref.value = isDark.value ? 'light' : 'dark';
}

function logout() {
  authStore.logout();
  router.push('/login');
}
</script>

<style scoped>
/* Group activator (header row of each v-list-group) — slightly heavier
   than nested items so the hierarchy reads at a glance, but not so heavy
   that it competes with the active route highlight. */
.sidebar-group-activator :deep(.v-list-item-title) {
  font-weight: 600;
}
</style>
