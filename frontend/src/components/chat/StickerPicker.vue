<template>
  <!--
    StickerPicker — Feature 0028.
    Renders the hardcoded "Default" catalogue (Phase 1) returned by the
    backend at GET /api/v1/zalo/sticker-catalogues. Clicking a sticker
    emits `select` with the {stickerId, catId, type} triplet so the parent
    composer can POST it via the chat sticker endpoint.

    Loading + error states are tiny — picker is opened on-demand from the
    composer toolbar, so we keep the surface compact (≤ 280px wide).
  -->
  <div
    class="sticker-picker"
    role="dialog"
    aria-label="Chọn sticker"
    @click.stop
  >
    <!-- Header -->
    <div class="sticker-picker__head">
      <span class="text-caption font-weight-medium">Stickers</span>
      <button
        type="button"
        class="sticker-picker__close"
        aria-label="Đóng"
        @click="$emit('close')"
      >
        <v-icon size="14">mdi-close</v-icon>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="state === 'loading'" class="sticker-picker__empty text-caption text-grey">
      Đang tải…
    </div>

    <!-- Error -->
    <div v-else-if="state === 'error'" class="sticker-picker__empty text-caption text-error">
      Không tải được catalogue.
      <button type="button" class="sticker-picker__retry" @click="loadCatalogues">
        Thử lại
      </button>
    </div>

    <!-- Tabs (phase 1: single tab, but the layout is ready for more). -->
    <div v-else>
      <div v-if="catalogues.length > 1" class="sticker-picker__tabs">
        <button
          v-for="(cat, i) in catalogues"
          :key="cat.id"
          type="button"
          class="sticker-picker__tab"
          :class="{ 'sticker-picker__tab--active': i === activeTab }"
          @click="activeTab = i"
        >{{ cat.name }}</button>
      </div>

      <!-- Sticker grid -->
      <div class="sticker-picker__grid">
        <button
          v-for="st in activeStickers"
          :key="st.stickerId"
          type="button"
          class="sticker-picker__item"
          :title="`Sticker #${st.stickerId}`"
          :aria-label="`Sticker ${st.stickerId}`"
          @click="onPick(st)"
        >
          <img
            v-if="resolvedUrls[st.stickerId]"
            :src="resolvedUrls[st.stickerId]!"
            :alt="`Sticker ${st.stickerId}`"
            class="sticker-picker__img"
            loading="lazy"
          />
          <span v-else class="sticker-picker__placeholder">{{ st.stickerId }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '@/api/index';

/** Sticker triplet returned by the catalogue endpoint. */
export interface StickerPick {
  stickerId: number;
  catId: number;
  type: number;
}

interface Catalogue {
  id: number;
  name: string;
  stickers: StickerPick[];
}

const props = defineProps<{
  /** The Zalo account id — required by the proxy endpoints' ACL check. */
  accountId: string;
}>();

const emit = defineEmits<{
  select: [payload: StickerPick];
  close: [];
}>();

type State = 'loading' | 'ready' | 'error';
const state = ref<State>('loading');
const catalogues = ref<Catalogue[]>([]);
const activeTab = ref(0);
// stickerId -> resolved CDN url (best-effort; empty string while pending).
const resolvedUrls = ref<Record<number, string>>({});

const activeStickers = computed<StickerPick[]>(
  () => catalogues.value[activeTab.value]?.stickers ?? [],
);

async function loadCatalogues() {
  state.value = 'loading';
  try {
    const res = await api.get('/zalo/sticker-catalogues', {
      params: { accountId: props.accountId },
    });
    catalogues.value = Array.isArray(res.data?.catalogues) ? res.data.catalogues : [];
    state.value = 'ready';
    // Kick off best-effort URL resolution in parallel. Failures are silent —
    // the placeholder digit is shown until the CDN URL resolves.
    void hydrateUrls();
  } catch {
    state.value = 'error';
  }
}

async function hydrateUrls() {
  const all = activeStickers.value;
  await Promise.all(
    all.map(async (st) => {
      if (resolvedUrls.value[st.stickerId]) return;
      try {
        const res = await api.get(`/zalo/stickers/${st.stickerId}`, {
          params: { catId: st.catId, accountId: props.accountId },
        });
        if (res.data?.cdnUrl) {
          resolvedUrls.value = {
            ...resolvedUrls.value,
            [st.stickerId]: res.data.cdnUrl,
          };
        }
      } catch {
        /* leave placeholder; AC-0008 only requires the click to fire. */
      }
    }),
  );
}

function onPick(st: StickerPick) {
  emit('select', { stickerId: st.stickerId, catId: st.catId, type: st.type });
}

onMounted(loadCatalogues);
</script>

<style scoped>
.sticker-picker {
  width: 280px;
  max-height: 320px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.sticker-picker__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.sticker-picker__close {
  background: transparent;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 4px;
}
.sticker-picker__close:hover { background: rgba(0, 0, 0, 0.05); }

.sticker-picker__tabs {
  display: flex;
  gap: 4px;
  padding: 6px 8px 0;
  overflow-x: auto;
}
.sticker-picker__tab {
  font-size: 0.75rem;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
}
.sticker-picker__tab--active {
  background: rgb(var(--v-theme-primary));
  color: #fff;
  border-color: transparent;
}

.sticker-picker__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  padding: 10px;
  overflow-y: auto;
}
.sticker-picker__item {
  aspect-ratio: 1 / 1;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  transition: background-color 0.12s ease, transform 0.12s ease;
}
.sticker-picker__item:hover {
  background: rgba(0, 0, 0, 0.06);
  transform: scale(1.04);
}
.sticker-picker__item:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 1px;
}
.sticker-picker__img {
  max-width: 100%;
  max-height: 100%;
  display: block;
}
.sticker-picker__placeholder {
  font-size: 0.65rem;
  color: rgba(0, 0, 0, 0.5);
}

.sticker-picker__empty {
  padding: 16px;
  text-align: center;
}
.sticker-picker__retry {
  margin-left: 6px;
  background: transparent;
  border: none;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
  text-decoration: underline;
  font-size: inherit;
}
</style>
