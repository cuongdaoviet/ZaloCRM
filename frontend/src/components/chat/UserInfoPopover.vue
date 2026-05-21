<template>
  <div
    v-if="open"
    ref="popoverRef"
    class="user-info-popover"
    role="dialog"
    aria-label="Thông tin người dùng Zalo"
    :style="positionStyle"
    @click.stop
  >
    <!-- Loading -->
    <div v-if="loading" class="popover-body d-flex flex-column align-center pa-4">
      <v-progress-circular indeterminate size="32" color="primary" />
      <div class="text-caption text-grey mt-2">Đang tải...</div>
    </div>

    <!-- Loaded -->
    <div v-else-if="info" class="popover-body">
      <div class="d-flex align-start pa-3">
        <v-avatar size="64" class="me-3" color="grey-lighten-3">
          <v-img v-if="info.avatarUrl" :src="info.avatarUrl" :alt="info.displayName" />
          <v-icon v-else icon="mdi-account" size="36" />
        </v-avatar>
        <div class="flex-grow-1 user-info-meta">
          <div class="font-weight-medium text-body-1 mb-1">
            {{ info.displayName || 'Unknown' }}
          </div>
          <div class="text-caption text-grey">
            Zalo ID: <span class="font-mono">{{ info.uid }}</span>
          </div>
          <div v-if="info.phone" class="text-caption text-grey mt-1">
            <v-icon size="12" class="me-1">mdi-phone</v-icon>{{ info.phone }}
          </div>
          <div v-if="!info.online" class="text-caption text-warning mt-1">
            <v-icon size="12" class="me-1">mdi-cloud-off-outline</v-icon>
            Tài khoản Zalo offline — dữ liệu có thể cũ
          </div>
        </div>
      </div>

      <v-divider />

      <div class="d-flex pa-2 gap-2">
        <v-btn
          v-if="info.contactId"
          size="small"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-account-arrow-right"
          @click="onOpenContact"
        >
          Xem trong CRM
        </v-btn>
        <v-btn
          v-else
          size="small"
          variant="tonal"
          color="success"
          prepend-icon="mdi-account-plus"
          @click="onCreateContact"
        >
          Tạo Contact
        </v-btn>
        <v-spacer />
        <v-btn size="small" variant="text" @click="close">Đóng</v-btn>
      </div>
    </div>

    <!-- Error -->
    <div v-else class="popover-body pa-4 text-center">
      <v-icon color="error" icon="mdi-alert-circle-outline" />
      <div class="text-caption text-grey mt-2">Không tải được thông tin người dùng.</div>
      <v-btn class="mt-2" size="small" variant="text" @click="close">Đóng</v-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Feature 0030 — Popover hiển thị thông tin user Zalo trong group chat.
 *
 * Mount khi click avatar message. Self avatar (BR-0003) bỏ qua tại
 * parent — popover này luôn fetch.
 *
 * Emits:
 *   - close              — user dismiss (outside click / Esc / Đóng).
 *   - create-contact     — payload prefill cho dialog tạo Contact mới.
 *   - open-contact       — payload contactId để parent xử lý (router push).
 */
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '@/api/index';

interface ZaloUserInfo {
  uid: string;
  displayName: string;
  avatarUrl: string | null;
  gender: string | null;
  phone: string | null;
  contactId: string | null;
  online: boolean;
  cached: boolean;
}

export interface CreateContactPayload {
  fullName: string;
  zaloUid: string;
  avatarUrl: string | null;
  phone: string | null;
}

const props = defineProps<{
  /** Whether the popover is currently mounted/visible. */
  open: boolean;
  /** UID of the Zalo user to render. */
  uid: string | null;
  /** Zalo account ID used as the lookup origin. */
  accountId: string | null;
  /**
   * Anchor element — typically the clicked avatar. Used to position the
   * popover so it appears next to its trigger. When absent, falls back to
   * centered fixed position.
   */
  anchorEl: HTMLElement | null;
}>();

const emit = defineEmits<{
  close: [];
  'create-contact': [payload: CreateContactPayload];
  'open-contact': [contactId: string];
}>();

const loading = ref(false);
const info = ref<ZaloUserInfo | null>(null);
const popoverRef = ref<HTMLElement | null>(null);
const positionStyle = ref<Record<string, string>>({});

async function load() {
  if (!props.uid || !props.accountId) return;
  loading.value = true;
  info.value = null;
  try {
    const res = await api.get<ZaloUserInfo>(`/zalo/users/${encodeURIComponent(props.uid)}`, {
      params: { accountId: props.accountId },
    });
    info.value = res.data;
  } catch (err) {
    console.error('[UserInfoPopover] fetch failed', err);
    info.value = null;
  } finally {
    loading.value = false;
  }
}

function computePosition() {
  const anchor = props.anchorEl;
  if (!anchor) {
    positionStyle.value = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    };
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const popoverWidth = 320;
  const popoverHeight = 200;
  // Default: to the right of the avatar.
  let left = rect.right + 8;
  let top = rect.top;
  // Flip left if overflow right.
  if (left + popoverWidth > window.innerWidth - 8) {
    left = Math.max(8, rect.left - popoverWidth - 8);
  }
  // Clamp bottom.
  if (top + popoverHeight > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - popoverHeight - 8);
  }
  positionStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
  };
}

function close() {
  emit('close');
}

function onCreateContact() {
  if (!info.value) return;
  emit('create-contact', {
    fullName: info.value.displayName,
    zaloUid: info.value.uid,
    avatarUrl: info.value.avatarUrl,
    phone: info.value.phone,
  });
}

function onOpenContact() {
  if (info.value?.contactId) {
    emit('open-contact', info.value.contactId);
  }
}

function onOutsideClick(e: MouseEvent) {
  if (!props.open) return;
  const target = e.target as HTMLElement | null;
  if (popoverRef.value && target && popoverRef.value.contains(target)) return;
  close();
}

function onKey(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === 'Escape') close();
}

watch(
  () => [props.open, props.uid, props.accountId] as const,
  async ([open]) => {
    if (open && props.uid && props.accountId) {
      await load();
      await nextTick();
      computePosition();
    }
  },
  { immediate: true },
);

onMounted(() => {
  // Outside-click listener attached at the window level. Capture phase so
  // we close BEFORE Vue re-renders new content under the cursor.
  window.addEventListener('mousedown', onOutsideClick, true);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', computePosition);
});

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onOutsideClick, true);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', computePosition);
});

// Re-position whenever the anchor changes.
watch(() => props.anchorEl, () => {
  if (props.open) computePosition();
});

defineExpose({ loading, info });

// Cache `computed` to silence unused-import warning while still exporting
// minimal API surface.
const _formStyle = computed(() => positionStyle.value);
void _formStyle;
</script>

<style scoped>
.user-info-popover {
  width: 320px;
  background: var(--v-theme-surface, #fff);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 2400;
  overflow: hidden;
}
.popover-body {
  display: flex;
  flex-direction: column;
}
.user-info-meta {
  min-width: 0;
  word-break: break-word;
}
.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.gap-2 {
  gap: 8px;
}
</style>
