<template>
  <div>
    <!-- Latest attempt summary -->
    <div v-if="loading" class="d-flex align-center text-medium-emphasis">
      <v-progress-circular indeterminate size="16" width="2" class="mr-2" />
      <span class="text-caption">Đang tải lịch sử kết bạn…</span>
    </div>

    <div v-else>
      <div v-if="attempts.length === 0" class="d-flex align-center justify-space-between flex-wrap ga-2">
        <span class="text-caption text-medium-emphasis">Chưa có lời mời kết bạn</span>
        <v-btn
          v-if="contactId"
          size="small"
          color="primary"
          prepend-icon="mdi-account-plus-outline"
          variant="tonal"
          @click="openDialog"
        >Kết bạn</v-btn>
      </div>

      <div v-else>
        <div class="d-flex align-center flex-wrap ga-2 mb-2">
          <v-chip
            :color="STATE_COLORS[latest.state]"
            :prepend-icon="STATE_ICONS[latest.state]"
            size="small"
            variant="flat"
          >{{ STATE_LABELS[latest.state] }}</v-chip>
          <span class="text-caption text-medium-emphasis">
            qua {{ latest.zaloAccount?.displayName ?? 'Zalo' }}
          </span>
          <v-spacer />
          <v-btn
            v-if="canEnqueueAgain(latest.state)"
            size="small"
            color="primary"
            prepend-icon="mdi-replay"
            variant="tonal"
            @click="openDialog"
          >Gửi lại</v-btn>
        </div>

        <!-- Compact history -->
        <v-expansion-panels variant="accordion" class="mb-2">
          <v-expansion-panel>
            <v-expansion-panel-title class="text-body-2">
              Lịch sử ({{ attempts.length }})
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <v-list density="compact">
                <v-list-item v-for="a in attempts" :key="a.id">
                  <template #prepend>
                    <v-icon size="16" :color="STATE_COLORS[a.state]">{{ STATE_ICONS[a.state] }}</v-icon>
                  </template>
                  <v-list-item-title class="text-body-2">
                    {{ STATE_LABELS[a.state] }}
                    <span class="text-caption text-medium-emphasis">
                      · {{ a.zaloAccount?.displayName ?? 'Zalo' }}
                      · {{ formatDate(a.queuedAt) }}
                    </span>
                  </v-list-item-title>
                  <v-list-item-subtitle v-if="a.errorCode" class="text-caption text-error">
                    Lỗi: {{ a.errorCode }}
                  </v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <div v-if="notOnZaloMeta" class="text-caption text-warning">
          <v-icon size="14" color="warning">mdi-alert-outline</v-icon>
          Số này từng tra không có Zalo ({{ formatDate(notOnZaloMeta.checkedAt) }})
        </div>
      </div>
    </div>

    <!-- Enqueue dialog -->
    <v-dialog v-model="dialogOpen" max-width="480">
      <v-card>
        <v-card-title>Gửi lời mời kết bạn</v-card-title>
        <v-card-text>
          <v-select
            v-model="selectedAccount"
            :items="accountOptions"
            item-title="title"
            item-value="value"
            label="Tài khoản Zalo gửi từ"
            density="comfortable"
            :rules="[(v: string) => !!v || 'Chọn tài khoản']"
            class="mb-3"
          />
          <v-textarea
            v-model="message"
            label="Lời nhắn (tối đa 200 ký tự)"
            counter="200"
            :rules="[(v: string) => (v?.length ?? 0) <= 200 || '≤200 ký tự']"
            rows="2"
            auto-grow
            hint="Hỗ trợ {{contactName}} và {{firstName}}"
            persistent-hint
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialogOpen = false">Huỷ</v-btn>
          <v-btn
            color="primary"
            :loading="submitting"
            :disabled="!selectedAccount"
            @click="submit"
          >Đặt vào hàng đợi</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="toast.show" :color="toast.color" timeout="3000">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  useFriendship,
  STATE_LABELS,
  STATE_COLORS,
  STATE_ICONS,
  type FriendshipState,
} from '@/composables/use-friendship';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';

interface Props {
  contactId: string;
  /**
   * Optional contact-level metadata so we can render the "đã từng tra không
   * có Zalo" warning without an extra fetch.
   */
  notOnZalo?: { checkedAt: string; by: string } | null;
}

const props = defineProps<Props>();

const { attempts, loading, fetchAttempts, enqueueForContact } = useFriendship();
const { accounts, fetchAccounts } = useZaloAccounts();

const dialogOpen = ref(false);
const selectedAccount = ref<string | null>(null);
const message = ref('');
const submitting = ref(false);
const toast = ref({ show: false, text: '', color: 'success' });

const accountOptions = computed(() =>
  accounts.value
    .filter((a) => a.status === 'connected')
    .map((a) => ({ title: a.displayName ?? 'Không tên', value: a.id })),
);

const latest = computed(() => attempts.value[0]);

const notOnZaloMeta = computed(() => props.notOnZalo ?? null);

function canEnqueueAgain(state: FriendshipState): boolean {
  // BR-0005: re-enqueue allowed only when previous attempt is terminal
  return ['accepted', 'declined', 'timeout', 'error', 'cancelled'].includes(state);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

async function refresh() {
  if (!props.contactId) return;
  await fetchAttempts({ contactId: props.contactId, limit: 20 });
}

function openDialog() {
  if (accountOptions.value.length > 0 && !selectedAccount.value) {
    selectedAccount.value = accountOptions.value[0].value;
  }
  message.value = '';
  dialogOpen.value = true;
}

async function submit() {
  if (!selectedAccount.value) return;
  submitting.value = true;
  const r = await enqueueForContact(
    props.contactId,
    selectedAccount.value,
    message.value || undefined,
  );
  submitting.value = false;
  if (r.ok) {
    toast.value = { show: true, text: 'Đã đặt vào hàng đợi', color: 'success' };
    dialogOpen.value = false;
    await refresh();
  } else {
    toast.value = { show: true, text: r.error, color: 'error' };
  }
}

watch(() => props.contactId, refresh, { immediate: false });

onMounted(async () => {
  await Promise.all([fetchAccounts(), refresh()]);
});
</script>
