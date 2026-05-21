<template>
  <component :is="layout">
    <router-view />
  </component>
</template>

<script setup lang="ts">
// Feature 0039 — layout switcher (ported from ZaloCRM-3.0's App.vue pattern,
// but swapping their custom `useMobile()` composable for Vuetify's reactive
// `useDisplay().smAndDown` so we get cross-component breakpoint consistency
// for free). The route-level `layout: 'auth'` flag still wins so login/setup
// pages stay full-bleed.
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useDisplay } from 'vuetify';
import DefaultLayout from '@/layouts/DefaultLayout.vue';
import AuthLayout from '@/layouts/AuthLayout.vue';
import MobileLayout from '@/layouts/MobileLayout.vue';

const route = useRoute();
const { smAndDown } = useDisplay();

const layout = computed(() => {
  if (route.meta.layout === 'auth') return AuthLayout;
  return smAndDown.value ? MobileLayout : DefaultLayout;
});
</script>
