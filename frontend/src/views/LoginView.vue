<template>
  <!-- Feature 0061 — variant C login.
       Hero line above a translucent (glass) form floating on the indigo
       gradient backdrop from AuthLayout. The cyan-blue orb + English
       "Liquid Silicon" tagline from the legacy version are gone — they
       were pre-Feature-0057 palette + didn't match the Vietnamese-first
       product voice. -->
  <div class="text-center mb-6 hero-block">
    <div class="logo-mark mx-auto mb-4">
      <span>Z</span>
    </div>
    <h1 class="text-h4 font-weight-bold mb-2" style="color: #ffffff; letter-spacing: -0.01em;">
      Zalo<span style="color: #c7d2fe;">CRM</span>
    </h1>
    <p class="text-body-1 mb-0" style="color: rgba(255,255,255,0.82);">
      Bán hàng qua Zalo, có hệ thống.
    </p>
  </div>

  <v-card class="login-card pa-7" elevation="0">
    <v-form @submit.prevent="handleLogin">
      <v-text-field
        v-model="email"
        label="Email"
        type="email"
        variant="outlined"
        autocomplete="email"
        required
        class="mb-3"
      />
      <v-text-field
        v-model="password"
        label="Mật khẩu"
        type="password"
        variant="outlined"
        autocomplete="current-password"
        required
        class="mb-5"
      />
      <v-btn type="submit" color="primary" block size="large" :loading="loading" rounded="lg">
        Đăng nhập
      </v-btn>
    </v-form>

    <v-alert v-if="error" type="error" class="mt-4" density="compact" closable variant="tonal">
      {{ error }}
    </v-alert>
  </v-card>

  <p class="text-center mt-5 text-caption" style="color: rgba(255,255,255,0.5);">
    © 2026 ZaloCRM — CRM cho đội Sales bán hàng qua Zalo
  </p>
</template>

<style scoped>
.hero-block {
  position: relative;
  z-index: 1;
}
.logo-mark {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4);
}
.logo-mark span {
  color: white;
  font-weight: 700;
  font-size: 28px;
  letter-spacing: -0.04em;
}
.login-card {
  background: rgba(255, 255, 255, 0.96) !important;
  border-radius: 14px !important;
  box-shadow: 0 24px 60px rgba(13, 12, 34, 0.45), 0 2px 8px rgba(13, 12, 34, 0.12) !important;
  position: relative;
  z-index: 1;
}
</style>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');
const router = useRouter();
const authStore = useAuthStore();

onMounted(async () => {
  // If already authenticated, skip login page
  if (authStore.token) {
    try {
      await authStore.fetchProfile();
      if (authStore.isAuthenticated) {
        router.replace('/');
        return;
      }
    } catch {}
  }
  // Check if first-time setup needed
  try {
    const needs = await authStore.checkSetup();
    if (needs) router.replace('/setup');
  } catch {}
});

async function handleLogin() {
  loading.value = true;
  error.value = '';
  try {
    await authStore.login(email.value, password.value);
    router.push('/');
  } catch (err: any) {
    error.value = err.response?.data?.error || 'Đăng nhập thất bại';
  } finally {
    loading.value = false;
  }
}
</script>
