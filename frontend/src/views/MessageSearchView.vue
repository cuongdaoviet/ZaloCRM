<template>
  <div>
    <h1 class="text-h4 mb-4">Tìm kiếm tin nhắn</h1>

    <v-card class="pa-4 mb-4">
      <div class="d-flex flex-wrap" style="gap: 12px;">
        <v-text-field
          v-model="q"
          label="Từ khoá (tối thiểu 2 ký tự)"
          density="compact" variant="outlined" hide-details
          prepend-inner-icon="mdi-magnify"
          clearable
          style="min-width: 280px; flex: 2;"
          @keyup.enter="runSearch(1)"
        />
        <v-text-field
          v-model="from"
          label="Từ ngày" type="date"
          density="compact" variant="outlined" hide-details
          style="min-width: 160px;"
        />
        <v-text-field
          v-model="to"
          label="Đến ngày" type="date"
          density="compact" variant="outlined" hide-details
          style="min-width: 160px;"
        />
        <v-select
          v-model="senderType"
          :items="SENDER_OPTIONS"
          item-title="title" item-value="value"
          label="Người gửi"
          density="compact" variant="outlined" hide-details
          clearable
          style="min-width: 140px;"
        />
        <v-select
          v-model="contentType"
          :items="CONTENT_TYPE_OPTIONS"
          item-title="title" item-value="value"
          label="Loại tin"
          density="compact" variant="outlined" hide-details
          clearable
          style="min-width: 140px;"
        />
        <v-btn color="primary" :loading="loading" @click="runSearch(1)" prepend-icon="mdi-magnify">
          Tìm
        </v-btn>
      </div>
    </v-card>

    <v-alert v-if="error" type="error" density="compact" closable class="mb-3" @click:close="error = ''">
      {{ error }}
    </v-alert>

    <v-card>
      <div class="d-flex align-center pa-3 text-body-2 text-grey">
        <span v-if="total > 0">
          Tìm thấy <strong>{{ total }}</strong> tin nhắn
          {{ totalPages > 1 ? `— trang ${page}/${totalPages}` : '' }}
        </span>
        <span v-else-if="hasSearched && !loading">Không tìm thấy kết quả</span>
        <v-spacer />
        <v-btn
          v-if="totalPages > 1"
          icon size="small" variant="text"
          :disabled="page <= 1 || loading"
          @click="runSearch(page - 1)"
        ><v-icon>mdi-chevron-left</v-icon></v-btn>
        <v-btn
          v-if="totalPages > 1"
          icon size="small" variant="text"
          :disabled="page >= totalPages || loading"
          @click="runSearch(page + 1)"
        ><v-icon>mdi-chevron-right</v-icon></v-btn>
      </div>

      <v-divider v-if="messages.length > 0" />

      <v-list v-if="messages.length > 0" density="comfortable">
        <v-list-item
          v-for="msg in messages"
          :key="msg.id"
          @click="openConversation(msg)"
          class="search-row"
        >
          <template #prepend>
            <v-avatar size="40" color="grey-lighten-2">
              <v-img v-if="msg.conversation.contact?.avatarUrl" :src="msg.conversation.contact.avatarUrl" />
              <v-icon v-else icon="mdi-account" />
            </v-avatar>
          </template>

          <v-list-item-title class="d-flex align-center">
            <span class="font-weight-medium">
              {{ msg.conversation.contact?.fullName || 'Khách chưa lưu' }}
            </span>
            <v-chip
              v-if="msg.senderType === 'self'"
              size="x-small" variant="tonal" color="primary" class="ml-2"
            >Bạn gửi</v-chip>
            <v-chip
              v-if="msg.contentType !== 'text'"
              size="x-small" variant="tonal" color="info" class="ml-2"
            >{{ msg.contentType }}</v-chip>
            <v-spacer />
            <span class="text-caption text-grey">{{ formatDate(msg.sentAt) }}</span>
          </v-list-item-title>

          <v-list-item-subtitle class="snippet" v-html="renderSnippet(msg.snippet)" />

          <template #append>
            <span class="text-caption text-grey-darken-1 ml-3">
              {{ msg.conversation.zaloAccount?.displayName || '' }}
            </span>
          </template>
        </v-list-item>
      </v-list>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import {
  useMessageSearch,
  snippetToHtml,
  type MessageSearchResult,
} from '@/composables/use-message-search';

const router = useRouter();
const { messages, total, page, totalPages, loading, error, search } = useMessageSearch();

const q = ref('');
const from = ref('');
const to = ref('');
const senderType = ref<'self' | 'contact' | null>(null);
const contentType = ref<string | null>(null);
const hasSearched = ref(false);

const SENDER_OPTIONS = [
  { title: 'Từ khách', value: 'contact' },
  { title: 'Bạn gửi', value: 'self' },
];
const CONTENT_TYPE_OPTIONS = [
  { title: 'Văn bản', value: 'text' },
  { title: 'Ảnh', value: 'image' },
  { title: 'File', value: 'file' },
  { title: 'Sticker', value: 'sticker' },
  { title: 'Link', value: 'link' },
];

const canSearch = computed(() => q.value.trim().length >= 2);

async function runSearch(targetPage: number) {
  if (!canSearch.value) {
    error.value = 'Cần ít nhất 2 ký tự';
    return;
  }
  hasSearched.value = true;
  await search({
    q: q.value.trim(),
    from: from.value ? new Date(from.value).toISOString() : null,
    to: to.value ? new Date(to.value + 'T23:59:59').toISOString() : null,
    senderType: senderType.value,
    contentType: contentType.value,
    page: targetPage,
    limit: 30,
  });
}

function renderSnippet(snippet: string): string {
  return snippetToHtml(snippet);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function openConversation(msg: MessageSearchResult) {
  router.push({
    path: '/chat',
    query: { conversationId: msg.conversation.id },
  });
}
</script>

<style scoped>
.search-row {
  cursor: pointer;
  transition: background 0.1s;
}
.search-row:hover {
  background: rgba(0, 242, 255, 0.06);
}
.snippet :deep(mark) {
  background: rgba(255, 235, 59, 0.4);
  font-weight: 600;
  padding: 0 2px;
  border-radius: 2px;
}
</style>
