<template>
  <!-- Feature 0039 — slim mobile chrome (ported from ZaloCRM-3.0's
       MobileLayout.vue, 30-line wrapper pattern). The desktop sidebar
       (DefaultLayout's v-navigation-drawer) is gone here; navigation is
       driven entirely by MobileBottomNav. We keep the same theme +
       logout actions in the top bar so users have parity with desktop
       chrome on small screens. -->
  <v-app :class="{ 'liquid-bg': isDark }">
    <v-app-bar density="compact" flat>
      <!-- Brand mark — kept small (28px) to leave room for the user menu. -->
      <div class="d-flex align-center ml-3" style="gap: 8px;">
        <div
          class="d-flex align-center justify-center"
          style="width: 28px; height: 28px;
                 background: linear-gradient(135deg, #00F2FF, #0077B6);
                 border-radius: 8px;"
        >
          <v-icon size="16" color="white">mdi-robot</v-icon>
        </div>
        <span class="font-weight-bold text-body-1">
          Zalo<span style="color: #00F2FF;">CRM</span>
        </span>
      </div>

      <v-spacer />

      <NotificationBell />
      <v-btn icon size="small" variant="text" @click="toggleTheme" aria-label="Đổi giao diện">
        <v-icon size="20">{{ isDark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}</v-icon>
        <v-tooltip activator="parent" location="bottom" :text="isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'" />
      </v-btn>
      <v-btn icon size="small" variant="text" @click="logout" aria-label="Đăng xuất">
        <v-icon size="20">mdi-logout</v-icon>
        <v-tooltip activator="parent" location="bottom" text="Đăng xuất" />
      </v-btn>
    </v-app-bar>

    <!-- Page content + clearance for the bottom nav. The padding-bottom
         math uses `calc(56px + env(safe-area-inset-bottom))` so the iOS
         home indicator can't eat the last row. We add an extra 16px buffer
         so FABs sitting at bottom:88px don't bump the nav. -->
    <v-main>
      <div class="mobile-main">
        <slot />
      </div>
    </v-main>

    <MobileBottomNav />
  </v-app>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useTheme } from 'vuetify';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useUserPreferences } from '@/composables/use-user-preferences';
import NotificationBell from '@/components/NotificationBell.vue';
import MobileBottomNav from '@/components/layout/MobileBottomNav.vue';

const theme = useTheme();
const router = useRouter();
const authStore = useAuthStore();

// Share the theme preference logic with DefaultLayout — see DefaultLayout's
// header comment for the rationale (server-persisted, localStorage fast path).
const { usePref } = useUserPreferences();
const initialTheme: 'dark' | 'light' =
  localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
const themePref = usePref<'dark' | 'light'>('ui.theme', initialTheme);
const isDark = computed(() => themePref.value === 'dark');

function applyTheme(val: 'dark' | 'light') {
  theme.global.name.value = val === 'dark' ? 'legacy-dark' : 'smax-light';
}

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

function toggleTheme() {
  themePref.value = isDark.value ? 'light' : 'dark';
}

function logout() {
  authStore.logout();
  router.push('/login');
}
</script>

<style scoped>
.mobile-main {
  /* Bottom padding clears the fixed nav (56px) plus the iOS home
     indicator (env() = 0 on Android/web). The +16px breathing room keeps
     FABs from kissing the nav when they sit at the bottom of a view. */
  padding-bottom: calc(var(--smax-bottom-nav-h, 56px) + env(safe-area-inset-bottom) + 16px);
  min-height: 100%;
}
</style>
