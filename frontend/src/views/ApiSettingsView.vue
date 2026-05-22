<template>
  <div style="max-width: 700px;">
    <h1 class="text-h5 mb-4">
      <v-icon class="mr-2" color="primary">mdi-api</v-icon>
      API & Webhook
    </h1>

    <!-- API Key section -->
    <v-card class="mb-4">
      <v-card-title class="text-body-1">API Key</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="apiKey"
          label="API Key"
          readonly
          append-inner-icon="mdi-content-copy"
          @click:append-inner="copyKey"
        />
        <v-btn
          color="primary"
          variant="outlined"
          prepend-icon="mdi-refresh"
          :loading="generatingKey"
          @click="generateKey"
        >
          Tạo key mới
        </v-btn>
      </v-card-text>
    </v-card>

    <!-- Webhook section -->
    <v-card class="mb-4">
      <v-card-title class="text-body-1">Webhook</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="webhookUrl"
          label="Webhook URL"
          placeholder="https://your-server.com/webhook"
          class="mb-2"
        />
        <v-text-field
          v-model="webhookSecret"
          label="Secret (HMAC)"
          type="password"
          class="mb-3"
        />
        <div class="d-flex gap-2">
          <v-btn color="primary" :loading="saving" @click="saveWebhook">Lưu</v-btn>
          <v-btn variant="outlined" :loading="testing" @click="testWebhook">Test Webhook</v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Webhook debug panel — admin only -->
    <WebhookDebugPanel
      v-if="authStore.isAdmin"
      @notify="(text, color) => showSnack(text, color)"
    />

    <!-- API Docs -->
    <v-card>
      <v-card-title class="text-body-1">API Documentation</v-card-title>
      <v-card-text>
        <!-- Feature 0052b — moved inline font-size:12px (caption) into a
             scoped class so the API docs block is on the scale. -->
        <pre class="api-docs-pre">Header: X-API-Key: your-key

GET  /api/public/contacts
POST /api/public/contacts
GET  /api/public/conversations
POST /api/public/messages/send
GET  /api/public/appointments
POST /api/public/appointments

Webhook events:
- message.received
- message.sent
- contact.created
- zalo.connected
- zalo.disconnected</pre>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snack.show" :color="snack.color" :timeout="3000">
      {{ snack.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';
import WebhookDebugPanel from '@/components/WebhookDebugPanel.vue';

const authStore = useAuthStore();

const apiKey = ref('');
const generatingKey = ref(false);
const webhookUrl = ref('');
const webhookSecret = ref('');
const saving = ref(false);
const testing = ref(false);

const snack = ref({ show: false, text: '', color: 'success' });

function showSnack(text: string, color: string | undefined = 'success') {
  snack.value = { show: true, text, color: color ?? 'success' };
}

// Backend response shape is `{ key, url, secret }` (see
// backend/src/modules/api/webhook-settings-routes.ts). We previously read
// `res.data.apiKey / webhookUrl / webhookSecret` — those names never existed
// on the response, so every field rendered empty. User-visible symptom:
// click "Tạo key mới", server creates the key fine, but the input stays
// blank because `undefined ?? ''` = ''.
async function loadApiKey() {
  try {
    const res = await api.get('/settings/api-key');
    apiKey.value = res.data.key ?? '';
  } catch {
    apiKey.value = '';
  }
}

async function loadWebhook() {
  try {
    const res = await api.get('/settings/webhook');
    webhookUrl.value = res.data.url ?? '';
    webhookSecret.value = res.data.secret ?? '';
  } catch {
    webhookUrl.value = '';
    webhookSecret.value = '';
  }
}

async function generateKey() {
  generatingKey.value = true;
  try {
    const res = await api.post('/settings/api-key/generate');
    apiKey.value = res.data.key ?? '';
    showSnack('API key mới đã được tạo');
  } catch {
    showSnack('Tạo key thất bại', 'error');
  } finally {
    generatingKey.value = false;
  }
}

async function copyKey() {
  if (!apiKey.value) return;
  await navigator.clipboard.writeText(apiKey.value);
  showSnack('Đã sao chép API key');
}

async function saveWebhook() {
  saving.value = true;
  try {
    // Backend reads `{ url, secret }` from the body — see
    // webhook-settings-routes.ts:43. Previously sent webhookUrl/webhookSecret
    // which the backend silently ignored (Zod-free destructure), so the form
    // appeared to save but nothing changed in the DB.
    await api.put('/settings/webhook', {
      url: webhookUrl.value,
      secret: webhookSecret.value,
    });
    showSnack('Đã lưu cấu hình webhook');
  } catch {
    showSnack('Lưu thất bại', 'error');
  } finally {
    saving.value = false;
  }
}

async function testWebhook() {
  testing.value = true;
  try {
    await api.post('/settings/webhook/test');
    showSnack('Gửi test webhook thành công');
  } catch {
    showSnack('Test webhook thất bại', 'error');
  } finally {
    testing.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadApiKey(), loadWebhook()]);
});
</script>

<style scoped>
/* Feature 0052b — caption-floor (12px) for the API docs <pre>. */
.api-docs-pre {
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
}
</style>
