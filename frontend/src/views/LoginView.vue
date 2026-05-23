<template>
  <!-- Feature 0061 (revised to variant B) — centered hero + form with a
       faded dashboard-skeleton peek behind. The skeleton is purely
       decorative (pointer-events: none) and uses neutral grey blocks
       instead of real screenshots so it stays brand-consistent and
       doesn't break when the actual dashboard changes. -->
  <div class="login-stage">
    <!-- Faded dashboard peek (decorative — behind the form, fades to slate
         at the bottom so the form has a clean landing area). -->
    <div class="dash-peek" aria-hidden="true">
      <div class="dash-grid">
        <div class="dash-side">
          <div class="nav-item active" />
          <div class="nav-item" />
          <div class="nav-item" />
          <div class="nav-item" />
          <div class="nav-item" />
        </div>
        <div class="dash-main">
          <div class="stat-row">
            <div class="stat-card">
              <div class="stat-num" /><div class="stat-lbl" />
            </div>
            <div class="stat-card">
              <div class="stat-num" /><div class="stat-lbl" />
            </div>
            <div class="stat-card">
              <div class="stat-num" /><div class="stat-lbl" />
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-line" />
          </div>
        </div>
      </div>
    </div>

    <!-- Center block: logo + wordmark + tagline + form. Above the peek
         via z-index. -->
    <div class="center-block">
      <div class="above-form">
        <div class="logo-mark">Z</div>
        <h1 class="brand text-h4 font-weight-bold">
          Zalo<span style="color: #4f46e5;">CRM</span>
        </h1>
        <p class="tagline text-body-1">
          Trung tâm vận hành cho đội Sales bán hàng qua Zalo.
        </p>
      </div>

      <v-card class="login-card pa-6" elevation="0">
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

      <p class="footer text-caption">
        © 2026 ZaloCRM — CRM cho đội Sales bán hàng qua Zalo
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-stage {
  position: relative;
  width: 100%;
  min-height: calc(100vh - 48px);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Dashboard peek — neutral grey skeleton, faded with a gradient overlay
   so the form sits on a clean light area at the bottom. */
.dash-peek {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.5;
  filter: blur(0.5px);
  z-index: 0;
}
.dash-peek::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(245,246,250,0) 0%, rgba(245,246,250,0.85) 55%, rgba(245,246,250,1) 100%);
  z-index: 2;
}
.dash-grid {
  position: absolute;
  top: 40px;
  left: 24px;
  right: 24px;
  bottom: 24px;
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 14px;
  z-index: 1;
}
.dash-side {
  background: #ffffff;
  border: 1px solid #ebedf0;
  border-radius: 12px;
  padding: 14px;
}
.dash-side .nav-item {
  height: 28px;
  background: #f1f5f9;
  border-radius: 6px;
  margin-bottom: 8px;
}
.dash-side .nav-item.active { background: rgba(79, 70, 229, 0.12); }
.dash-main {
  display: grid;
  grid-template-rows: 100px 1fr;
  gap: 14px;
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.stat-card {
  background: #ffffff;
  border: 1px solid #ebedf0;
  border-radius: 12px;
  padding: 16px;
}
.stat-num {
  height: 22px;
  width: 60%;
  background: #e2e8f0;
  border-radius: 4px;
  margin-bottom: 8px;
}
.stat-lbl {
  height: 10px;
  width: 80%;
  background: #f1f5f9;
  border-radius: 4px;
}
.chart-card {
  background: #ffffff;
  border: 1px solid #ebedf0;
  border-radius: 12px;
  padding: 20px;
  position: relative;
  overflow: hidden;
}
.chart-line {
  position: absolute;
  bottom: 30px;
  left: 20px;
  right: 20px;
  height: 80px;
  background: linear-gradient(180deg, rgba(79,70,229,0.22) 0%, rgba(79,70,229,0) 100%);
  clip-path: polygon(0 70%, 12% 55%, 24% 60%, 38% 35%, 52% 45%, 66% 25%, 80% 30%, 100% 10%, 100% 100%, 0 100%);
}

/* Center block: above the peek via z-index */
.center-block {
  position: relative;
  z-index: 3;
  text-align: center;
  width: 100%;
  max-width: 420px;
}
.above-form { margin-bottom: 22px; }
.logo-mark {
  width: 44px;
  height: 44px;
  border-radius: 11px;
  background: #4f46e5;
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 20px;
  letter-spacing: -0.04em;
  margin-bottom: 14px;
  box-shadow: 0 6px 16px rgba(79, 70, 229, 0.28);
}
.brand {
  color: #0b1220;
  margin: 0 0 8px 0;
  letter-spacing: -0.01em;
}
.tagline {
  color: #5c6675;
  margin: 0;
}
.login-card {
  background: #ffffff !important;
  border: 1px solid #ebedf0 !important;
  border-radius: 14px !important;
  box-shadow: 0 12px 36px rgba(13, 12, 34, 0.08), 0 2px 6px rgba(13, 12, 34, 0.04) !important;
}
.footer {
  display: block;
  margin-top: 20px;
  color: #94a3b8;
}

/* On small screens the dashboard peek can be visually noisy; hide it
   below 768px and let the form land on plain slate. */
@media (max-width: 768px) {
  .dash-peek { display: none; }
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
