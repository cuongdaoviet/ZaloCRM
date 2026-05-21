<template>
  <!-- Feature 0039 BR-0003 / AC-0001-0003 — bottom navigation surfaced on
       xs+sm viewports. Four primary tabs (Chat / Contacts / Friends / More)
       map directly to the most-trafficked sale-rep flows; "More" opens a
       v-navigation-drawer with secondary destinations (Settings / Reports
       / Analytics + Zalo accounts shortcut). We deviate from 3.0's tab list
       (it shipped Chat / Khách hàng / Lịch hẹn / Tổng quan) because our
       Friends page is a primary surface (Feature 0042). -->
  <v-bottom-navigation
    grow
    :model-value="activeTab"
    class="mobile-bottom-nav smax-safe-bottom"
    @update:model-value="onTabChange"
  >
    <v-btn
      v-for="tab in primaryTabs"
      :key="tab.value"
      :value="tab.value"
      class="mobile-bottom-nav__btn smax-touch-target"
      :aria-label="tab.title"
    >
      <v-icon size="22">{{ tab.icon }}</v-icon>
      <span class="text-caption">{{ tab.title }}</span>
    </v-btn>
  </v-bottom-navigation>

  <!-- "More" drawer — bottom-anchored sheet listing secondary destinations.
       AC-0003: lists Settings / Reports / Analytics. We add Zalo accounts +
       Appointments because those are reached via the desktop sidebar too.
       Admin-only items respect auth.isAdmin so a sale rep doesn't see KPI
       or Workflow editor surfaces they can't reach anyway. -->
  <v-navigation-drawer
    v-model="moreOpen"
    location="bottom"
    temporary
    class="mobile-more-drawer smax-safe-bottom"
  >
    <v-list density="comfortable" nav>
      <v-list-subheader>Khác</v-list-subheader>
      <v-list-item
        v-for="item in visibleMoreItems"
        :key="item.path"
        :to="item.path"
        :prepend-icon="item.icon"
        :title="item.title"
        rounded="xl"
        class="mb-1 smax-touch-target"
        @click="moreOpen = false"
      />
    </v-list>
  </v-navigation-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

interface PrimaryTab {
  /** Logical tab id used by v-bottom-navigation's model-value. */
  value: string;
  title: string;
  icon: string;
  /** Where this tab routes when tapped. */
  path: string;
  /**
   * Route paths that should highlight this tab even though they aren't
   * the exact match. Used for nested routes (e.g. /contacts/:id still
   * highlights the Contacts tab).
   */
  matchPrefixes: readonly string[];
}

interface MoreItem {
  title: string;
  icon: string;
  path: string;
  adminOnly?: boolean;
}

const primaryTabs: readonly PrimaryTab[] = [
  {
    value: 'chat',
    title: 'Chat',
    icon: 'mdi-message-text-outline',
    path: '/chat',
    matchPrefixes: ['/chat', '/search'],
  },
  {
    value: 'contacts',
    title: 'Khách',
    icon: 'mdi-account-group-outline',
    path: '/contacts',
    matchPrefixes: ['/contacts'],
  },
  {
    value: 'friends',
    title: 'Bạn bè',
    icon: 'mdi-account-multiple-outline',
    path: '/friends',
    matchPrefixes: ['/friends', '/friendship-attempts'],
  },
  {
    value: 'more',
    title: 'Khác',
    icon: 'mdi-dots-horizontal',
    // "more" doesn't navigate — it toggles the drawer below.
    path: '',
    matchPrefixes: [],
  },
];

const moreItems: readonly MoreItem[] = [
  { title: 'Tổng quan', icon: 'mdi-view-dashboard-outline', path: '/' },
  { title: 'Lịch hẹn', icon: 'mdi-calendar-clock-outline', path: '/appointments' },
  { title: 'Đơn hàng', icon: 'mdi-cart-outline', path: '/orders' },
  { title: 'Báo cáo', icon: 'mdi-chart-arc', path: '/reports' },
  {
    title: 'Phân tích nâng cao',
    icon: 'mdi-chart-timeline-variant',
    path: '/analytics',
    adminOnly: true,
  },
  { title: 'Tài khoản Zalo', icon: 'mdi-cellphone-link', path: '/zalo-accounts' },
  { title: 'Cài đặt', icon: 'mdi-cog-outline', path: '/settings' },
  {
    title: 'Quản lý nhãn',
    icon: 'mdi-tag-multiple-outline',
    path: '/settings/tags',
    adminOnly: true,
  },
  { title: 'Tin nhắn mẫu', icon: 'mdi-message-flash-outline', path: '/quick-replies' },
  { title: 'API & Webhook', icon: 'mdi-api', path: '/api-settings' },
];

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const moreOpen = ref(false);

const visibleMoreItems = computed(() =>
  moreItems.filter((m) => !m.adminOnly || auth.isAdmin),
);

// Match the active tab by checking each tab's prefix list. The "more" tab
// stays inactive on route matches — it's purely a drawer trigger — but we
// flip to "more" while the drawer is open so the icon highlights.
const activeTab = computed<string>(() => {
  if (moreOpen.value) return 'more';
  const path = route.path;
  for (const tab of primaryTabs) {
    if (tab.matchPrefixes.some((p) => path === p || path.startsWith(p + '/'))) {
      return tab.value;
    }
  }
  // Fallback when on a route not represented by any primary tab (e.g. /
  // dashboard). Keep nothing highlighted so users don't see a stale state.
  return '';
});

function onTabChange(value: string | null) {
  if (!value) return;
  if (value === 'more') {
    moreOpen.value = true;
    return;
  }
  const tab = primaryTabs.find((t) => t.value === value);
  if (!tab || tab.path === '') return;
  if (route.path !== tab.path) {
    router.push(tab.path);
  }
}
</script>

<style scoped>
.mobile-bottom-nav {
  /* Pin the bar to the bottom of the viewport on every viewport size; the
     parent v-app reserves the height so v-main content gets the bottom
     padding automatically. */
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
}

.mobile-bottom-nav__btn {
  /* AC-0008 — every tap target ≥ 44px high. v-bottom-navigation buttons
     default to 56px so we're inside the floor already; the explicit min
     keeps us safe if a future Vuetify release squeezes the height. */
  min-height: var(--smax-touch-target-min);
}

.mobile-more-drawer :deep(.v-list-item) {
  /* Same floor for the "More" drawer rows. */
  min-height: var(--smax-touch-target-min);
}
</style>
