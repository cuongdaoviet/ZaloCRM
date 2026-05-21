<template>
  <!--
    Feature 0029 — Zalo zinstant (bank/QR transfer card) renderer.
    Pure presentation. Parent owns parsing + the fullscreen QR modal
    (we just emit `preview` with the QR URL).
  -->
  <div class="zinstant-card">
    <div class="zinstant-header">
      <v-icon size="20" color="primary" class="mr-2">mdi-bank</v-icon>
      <span class="zinstant-bank-name">{{ data.bankName || data.bankCode || 'Chuyển khoản' }}</span>
    </div>

    <div v-if="data.accountNumber" class="zinstant-row">
      <div class="zinstant-label">Số tài khoản</div>
      <button
        type="button"
        class="zinstant-account"
        :title="`Copy số tài khoản ${data.accountNumber}`"
        @click="copy(data.accountNumber, 'Số tài khoản')"
      >
        <span class="zinstant-account-number">{{ data.accountNumber }}</span>
        <v-icon size="16" class="ml-2">mdi-content-copy</v-icon>
      </button>
    </div>

    <div v-if="data.accountName" class="zinstant-row">
      <div class="zinstant-label">Chủ tài khoản</div>
      <div class="zinstant-value">{{ data.accountName }}</div>
    </div>

    <div v-if="data.amount !== null" class="zinstant-row">
      <div class="zinstant-label">Số tiền</div>
      <button
        type="button"
        class="zinstant-amount-btn"
        :title="`Copy ${data.amount}`"
        @click="copy(String(data.amount), 'Số tiền')"
      >
        <span class="zinstant-amount">{{ formatVnd(data.amount) }}</span>
        <v-icon size="14" class="ml-1">mdi-content-copy</v-icon>
      </button>
    </div>

    <div v-if="data.description" class="zinstant-row">
      <div class="zinstant-label">Nội dung</div>
      <button
        type="button"
        class="zinstant-desc-btn"
        :title="`Copy ${data.description}`"
        @click="copy(data.description, 'Nội dung')"
      >
        <span class="zinstant-desc">{{ data.description }}</span>
        <v-icon size="14" class="ml-1">mdi-content-copy</v-icon>
      </button>
    </div>

    <div v-if="data.qrUrl" class="zinstant-qr-wrap">
      <!--
        QR image is click-to-zoom. If the Zalo CDN URL has expired
        (EC-0003) the browser fires `error` and we swap to a placeholder.
      -->
      <img
        v-if="!qrFailed"
        :src="data.qrUrl"
        alt="QR chuyển khoản"
        class="zinstant-qr"
        @click="$emit('preview', data.qrUrl!)"
        @error="qrFailed = true"
      />
      <div v-else class="zinstant-qr-placeholder">
        <v-icon size="32" color="grey">mdi-qrcode-remove</v-icon>
        <div class="text-caption mt-1">QR không tải được</div>
      </div>
    </div>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="2000">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { formatVnd, type ZinstantData } from '@/utils/parse-zinstant';

defineProps<{ data: ZinstantData }>();
defineEmits<{ preview: [qrUrl: string] }>();

const qrFailed = ref(false);
const toast = ref({ show: false, text: '', color: 'success' });

/**
 * Copy `value` to the clipboard and surface a toast. We avoid throwing
 * on permission failures (EC-0004) — rep can still read the value
 * straight off the card.
 */
async function copy(value: string, label: string) {
  if (!value) return;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      toast.value = { show: true, text: `Đã copy ${label}`, color: 'success' };
    } else {
      throw new Error('clipboard unavailable');
    }
  } catch {
    toast.value = {
      show: true,
      text: 'Không copy được, hãy copy thủ công',
      color: 'error',
    };
  }
}
</script>

<style scoped>
.zinstant-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(0, 242, 255, 0.06);
  border: 1px solid rgba(0, 242, 255, 0.18);
  min-width: 240px;
  max-width: 320px;
}
.zinstant-header {
  display: flex;
  align-items: center;
  font-weight: 600;
  font-size: 0.95rem;
  color: rgb(var(--v-theme-primary));
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(0, 242, 255, 0.15);
}
.zinstant-bank-name {
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.zinstant-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.zinstant-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.65;
}
.zinstant-value {
  font-size: 0.9rem;
  font-weight: 500;
}
.zinstant-account {
  display: inline-flex;
  align-items: center;
  background: none;
  border: 0;
  cursor: pointer;
  padding: 4px 0;
  text-align: left;
  color: inherit;
}
.zinstant-account-number {
  font-family: 'JetBrains Mono', 'Menlo', 'Consolas', monospace;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.zinstant-amount-btn,
.zinstant-desc-btn {
  display: inline-flex;
  align-items: center;
  background: none;
  border: 0;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
  color: inherit;
}
.zinstant-amount {
  font-size: 1rem;
  font-weight: 600;
  color: rgb(var(--v-theme-success, 76 175 80));
}
.zinstant-desc {
  font-size: 0.9rem;
  word-break: break-word;
}
.zinstant-qr-wrap {
  display: flex;
  justify-content: center;
  padding-top: 4px;
}
.zinstant-qr {
  width: 160px;
  height: 160px;
  object-fit: contain;
  border-radius: 8px;
  background: #fff;
  padding: 6px;
  cursor: zoom-in;
  transition: transform 0.15s ease;
}
.zinstant-qr:hover {
  transform: scale(1.03);
}
.zinstant-qr-placeholder {
  width: 160px;
  height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.04);
  color: rgba(0, 0, 0, 0.55);
  text-align: center;
}
</style>
