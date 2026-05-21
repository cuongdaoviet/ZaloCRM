<template>
  <div>
    <h1 class="text-h5 mb-2">
      <v-icon class="mr-2" color="primary">mdi-robot-outline</v-icon>
      Gợi ý AI (BYOK)
    </h1>
    <p class="text-body-2 text-grey mb-4">
      Cấu hình provider AI (Anthropic, OpenAI, Gemini, Qwen, Kimi, Ollama).
      ZaloCRM không lưu API key dạng plaintext — mọi key đều được mã hoá AES-256-GCM
      với key suy ra theo từng org. Nội dung gợi ý KHÔNG bao giờ được lưu trong DB.
    </p>

    <v-alert v-if="topError" type="error" closable density="compact" class="mb-3" @click:close="topError = ''">
      {{ topError }}
    </v-alert>
    <v-alert v-if="topInfo" type="info" closable density="compact" class="mb-3" @click:close="topInfo = ''">
      {{ topInfo }}
    </v-alert>

    <v-row>
      <v-col cols="12" md="7">
        <v-card>
          <v-card-title class="text-subtitle-1">Cấu hình</v-card-title>
          <v-card-text>
            <v-select
              v-model="form.provider"
              label="Nhà cung cấp"
              :items="providerOptions"
              item-title="label"
              item-value="value"
              density="comfortable"
              class="mb-2"
            />
            <v-select
              v-model="form.model"
              label="Mô hình"
              :items="modelOptions"
              item-title="title"
              item-value="value"
              :disabled="modelOptions.length === 0"
              density="comfortable"
              class="mb-2"
            />
            <v-text-field
              v-if="needsApiKey"
              v-model="form.apiKey"
              :label="apiKeyLabel"
              :type="showApiKey ? 'text' : 'password'"
              :placeholder="config.apiKeyConfigured ? 'Đã cấu hình — để trống nếu không đổi' : 'Nhập API key'"
              :hint="config.apiKeyConfigured ? 'Để trống = giữ nguyên key cũ. Nhập null để xoá.' : ''"
              persistent-hint
              density="comfortable"
              class="mb-2"
            >
              <template #append-inner>
                <v-btn icon size="x-small" variant="text" @click="showApiKey = !showApiKey">
                  <v-icon>{{ showApiKey ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
                </v-btn>
              </template>
            </v-text-field>
            <v-text-field
              v-model="form.apiEndpoint"
              label="Endpoint tuỳ chỉnh (tuỳ chọn)"
              :placeholder="endpointPlaceholder"
              density="comfortable"
              class="mb-2"
              clearable
            />
            <v-textarea
              v-model="form.systemPrompt"
              label="System prompt của tổ chức (giọng văn, brand)"
              rows="3"
              auto-grow
              counter="2000"
              maxlength="2000"
              density="comfortable"
              class="mb-2"
            />
            <v-text-field
              v-model.number="form.maxSuggestionsPerDay"
              label="Giới hạn gợi ý mỗi ngày (cho cả org)"
              type="number"
              :min="1"
              :max="1_000_000"
              density="comfortable"
              class="mb-2"
            />
            <v-switch
              v-model="form.enabled"
              label="Bật gợi ý AI cho org"
              color="primary"
              density="comfortable"
              hide-details
            />
          </v-card-text>
          <v-card-actions>
            <v-btn
              color="primary"
              variant="elevated"
              :loading="saving"
              :disabled="!canSave"
              data-testid="ai-config-save"
              @click="onSave"
            >
              <v-icon start>mdi-content-save</v-icon>
              Lưu &amp; kiểm tra kết nối
            </v-btn>
            <v-btn
              variant="text"
              color="error"
              :disabled="!config.apiKeyConfigured"
              @click="onClear"
            >
              Xoá key + tắt
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>

      <v-col cols="12" md="5">
        <v-card>
          <v-card-title class="text-subtitle-1">Sử dụng</v-card-title>
          <v-card-text v-if="usage">
            <div class="d-flex justify-space-between mb-2">
              <span class="text-caption text-grey">Tổng gợi ý</span>
              <span class="text-body-2 font-weight-medium">{{ usage.total }}</span>
            </div>
            <div class="d-flex justify-space-between mb-2">
              <span class="text-caption text-grey">Tokens in/out</span>
              <span class="text-body-2 font-weight-medium">
                {{ usage.totalTokensIn }} / {{ usage.totalTokensOut }}
              </span>
            </div>
            <div class="d-flex justify-space-between mb-2">
              <span class="text-caption text-grey">Lỗi</span>
              <span class="text-body-2 font-weight-medium">{{ usage.errorCount }}</span>
            </div>
            <div class="d-flex justify-space-between mb-2">
              <span class="text-caption text-grey">Ước chi phí (USD)</span>
              <span class="text-body-2 font-weight-medium">${{ usage.totalCost.toFixed(4) }}</span>
            </div>

            <v-divider class="my-3" />
            <p class="text-caption text-grey mb-1">Top người dùng</p>
            <div
              v-for="row in usage.topUsers"
              :key="row.userId"
              class="d-flex justify-space-between text-body-2"
            >
              <span class="text-truncate" style="max-width: 200px">{{ row.userId }}</span>
              <span>{{ row.count }}</span>
            </div>
            <p v-if="usage.topUsers.length === 0" class="text-caption text-grey">
              Chưa có dữ liệu trong khoảng này.
            </p>
          </v-card-text>
          <v-card-text v-else>
            <v-progress-circular indeterminate size="20" />
            <span class="ml-2 text-caption text-grey">Đang tải...</span>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
/**
 * Feature 0036 — AI config + usage admin page.
 *
 * BR-0011: GET never returns the API key. We show "Đã cấu hình" instead. PUT
 * only sends `apiKey` when the user typed a new value; leaving it blank
 * preserves the existing cipher.
 */
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '@/api/index';

interface ProviderModel {
  title: string;
  value: string;
}
interface ProviderDef {
  id: string;
  name: string;
  requiresApiKey: boolean;
  models: ProviderModel[];
}
interface AiConfig {
  id: string | null;
  provider: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  apiEndpoint: string | null;
  model: string;
  systemPrompt: string | null;
  enabled: boolean;
  maxSuggestionsPerDay: number;
  updatedAt: string | null;
}
interface AiUsage {
  total: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  errorCount: number;
  topUsers: Array<{ userId: string; count: number }>;
  byProvider: Array<{ provider: string; count: number }>;
}

const providers = ref<ProviderDef[]>([]);
const config = ref<AiConfig>({
  id: null,
  provider: 'anthropic',
  apiKeyConfigured: false,
  apiKeyHint: null,
  apiEndpoint: null,
  model: '',
  systemPrompt: null,
  enabled: false,
  maxSuggestionsPerDay: 1000,
  updatedAt: null,
});
const usage = ref<AiUsage | null>(null);

const form = ref({
  provider: 'anthropic',
  model: '',
  apiKey: '',
  apiEndpoint: '',
  systemPrompt: '',
  enabled: false,
  maxSuggestionsPerDay: 1000,
});

const saving = ref(false);
const showApiKey = ref(false);
const topError = ref('');
const topInfo = ref('');

const providerOptions = computed(() =>
  providers.value.map((p) => ({ label: p.name, value: p.id })),
);

const currentProvider = computed<ProviderDef | undefined>(() =>
  providers.value.find((p) => p.id === form.value.provider),
);

const modelOptions = computed<ProviderModel[]>(
  () => currentProvider.value?.models ?? [],
);

const needsApiKey = computed<boolean>(() => currentProvider.value?.requiresApiKey ?? true);

const apiKeyLabel = computed(() =>
  config.value.apiKeyConfigured ? 'API key (đã cấu hình — để trống nếu không đổi)' : 'API key',
);

const endpointPlaceholder = computed(() => {
  if (form.value.provider === 'ollama') return 'http://localhost:11434';
  return 'Mặc định endpoint của provider';
});

const canSave = computed<boolean>(() => {
  if (!form.value.provider || !form.value.model) return false;
  if (
    needsApiKey.value &&
    !config.value.apiKeyConfigured &&
    !form.value.apiKey.trim()
  ) return false;
  return true;
});

watch(
  () => form.value.provider,
  (next, prev) => {
    if (next === prev) return;
    // Reset model to first available; reset api key field (entered key is
    // provider-specific).
    const def = providers.value.find((p) => p.id === next);
    if (def && def.models.length > 0) {
      form.value.model = def.models[0].value;
    } else {
      form.value.model = '';
    }
  },
);

async function loadProviders(): Promise<void> {
  const res = await api.get<{ providers: ProviderDef[] }>('/settings/ai-providers');
  providers.value = res.data.providers;
}

async function loadConfig(): Promise<void> {
  const res = await api.get<AiConfig>('/settings/ai-config');
  config.value = res.data;
  form.value = {
    provider: res.data.provider,
    model: res.data.model,
    apiKey: '',
    apiEndpoint: res.data.apiEndpoint ?? '',
    systemPrompt: res.data.systemPrompt ?? '',
    enabled: res.data.enabled,
    maxSuggestionsPerDay: res.data.maxSuggestionsPerDay,
  };
}

async function loadUsage(): Promise<void> {
  const res = await api.get<AiUsage>('/settings/ai-usage');
  usage.value = res.data;
}

async function onSave(): Promise<void> {
  saving.value = true;
  topError.value = '';
  topInfo.value = '';
  try {
    const payload: Record<string, unknown> = {
      provider: form.value.provider,
      model: form.value.model,
      apiEndpoint: form.value.apiEndpoint || null,
      systemPrompt: form.value.systemPrompt || null,
      enabled: form.value.enabled,
      maxSuggestionsPerDay: form.value.maxSuggestionsPerDay,
    };
    if (form.value.apiKey.trim()) {
      payload.apiKey = form.value.apiKey.trim();
    }
    const res = await api.put<AiConfig>('/settings/ai-config', payload);
    config.value = res.data;
    form.value.apiKey = '';
    topInfo.value = 'Lưu thành công — provider đã kiểm tra kết nối OK.';
    await loadUsage();
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    topError.value = e.response?.data?.error ?? e.message ?? 'Lưu thất bại';
  } finally {
    saving.value = false;
  }
}

async function onClear(): Promise<void> {
  if (!confirm('Xoá API key và tắt AI? Tất cả gợi ý sẽ ngừng cho đến khi cấu hình lại.')) return;
  try {
    await api.delete('/settings/ai-config');
    topInfo.value = 'Đã xoá key và tắt AI.';
    await loadConfig();
  } catch (err: unknown) {
    const e = err as { message?: string };
    topError.value = e.message ?? 'Xoá thất bại';
  }
}

onMounted(async () => {
  try {
    await loadProviders();
    await loadConfig();
    await loadUsage();
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    topError.value = e.response?.data?.error ?? e.message ?? 'Lỗi tải cấu hình';
  }
});
</script>
