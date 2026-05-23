<template>
  <div style="max-width: 700px;">
    <h1 class="text-h5 mb-4">
      <v-icon class="mr-2" color="primary">mdi-api</v-icon>
      API & Webhook
    </h1>

    <!-- API Key section — Feature 0059.
         Three visual states driven by `keyState`:
         - 'none':  no key exists yet → empty-state card + primary CTA
         - 'fresh': plaintext just returned from POST /generate → show in
                    full with a copy icon + a warning that this is the
                    only time the key will be visible
         - 'exists': masked indicator returned from GET → no copy icon
                    (the mask is a hash fragment, useless to copy), no
                    field value rendered, regenerate requires confirmation
     -->
    <v-card class="mb-4">
      <v-card-title class="text-body-1">API Key</v-card-title>
      <v-card-text>
        <!-- State: no key yet -->
        <div v-if="keyState === 'none'" class="d-flex flex-column align-start" style="gap: 12px;">
          <p class="text-body-2 text-medium-emphasis mb-0">
            Chưa có API key nào cho tổ chức này.
          </p>
          <v-btn
            color="primary"
            prepend-icon="mdi-key-plus"
            :loading="generatingKey"
            @click="generateKey"
          >
            Tạo API key
          </v-btn>
        </div>

        <!-- State: fresh plaintext just generated -->
        <div v-else-if="keyState === 'fresh'" class="d-flex flex-column" style="gap: 12px;">
          <v-alert type="warning" variant="tonal" density="comfortable" icon="mdi-alert-circle-outline">
            <div class="font-weight-medium">Sao chép key ngay — đây là lần duy nhất bạn nhìn thấy.</div>
            <div class="text-body-2 mt-1">
              Sau khi rời trang, key sẽ bị ẩn vĩnh viễn vì chỉ hash được lưu trong DB.
            </div>
          </v-alert>
          <v-text-field
            v-model="apiKey"
            label="API Key (plaintext)"
            readonly
            variant="outlined"
            density="compact"
            hide-details
            append-inner-icon="mdi-content-copy"
            @click:append-inner="copyKey"
          />
        </div>

        <!-- State: key exists (masked indicator from GET) -->
        <div v-else class="d-flex flex-column" style="gap: 12px;">
          <p class="text-body-2 text-medium-emphasis mb-0">
            Đã có 1 API key cho tổ chức này.
            <span class="text-grey">Plaintext không thể hiển thị lại.</span>
          </p>
          <v-btn
            color="primary"
            variant="outlined"
            prepend-icon="mdi-key-change"
            :loading="generatingKey"
            @click="confirmRegenerate = true"
          >
            Tạo key mới (vô hiệu hoá key cũ)
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Regenerate confirm dialog — destructive, so guard with a stop -->
    <v-dialog v-model="confirmRegenerate" max-width="440">
      <v-card>
        <v-card-title>Tạo API key mới?</v-card-title>
        <v-card-text>
          Hành động này sẽ <strong>vô hiệu hoá ngay lập tức</strong> API key
          hiện tại. Mọi tích hợp đang dùng key cũ sẽ trả về 401 Unauthorized
          cho đến khi cập nhật key mới.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmRegenerate = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="generatingKey" @click="confirmAndRegenerate">
            Tạo key mới
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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

// keyState drives the API Key card UI:
// 'none'   — no key in DB, show empty state + create CTA
// 'fresh'  — plaintext just returned from POST /generate; show + copy + warn
// 'exists' — masked indicator from GET; show "key exists" + regenerate CTA
//
// The distinction matters because the backend mask is a hash fragment
// (not the real key), so copying it would give the user something useless.
// 'fresh' is the only state where the displayed value is actually usable.
type KeyState = 'none' | 'fresh' | 'exists';
const keyState = ref<KeyState>('none');
const confirmRegenerate = ref(false);

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
    // Backend returns { key: null } when no key exists, or { key: '<masked>' }
    // when one exists. The mask is a hash fragment — not a usable key — so
    // we never put it into the bound input; just flip keyState.
    if (res.data.key) {
      keyState.value = 'exists';
      apiKey.value = '';
    } else {
      keyState.value = 'none';
      apiKey.value = '';
    }
  } catch {
    keyState.value = 'none';
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
    keyState.value = apiKey.value ? 'fresh' : 'none';
    showSnack('API key mới đã được tạo');
  } catch {
    showSnack('Tạo key thất bại', 'error');
  } finally {
    generatingKey.value = false;
  }
}

async function confirmAndRegenerate() {
  confirmRegenerate.value = false;
  await generateKey();
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
