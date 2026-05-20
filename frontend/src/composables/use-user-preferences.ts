/**
 * Feature 0016 — frontend composable for the per-user preferences KV store.
 *
 * Usage:
 *   const { ready, usePref, flushPreferences, reloadPreferences } = useUserPreferences();
 *   const theme = usePref<'dark' | 'light'>('ui.theme', 'dark');
 *   theme.value = 'light'; // PUT is debounced 300ms then sent to the server
 *
 * Design notes:
 *  - Module-level state is intentionally shared across all callers so that two
 *    components binding the same key see the same ref.
 *  - Fetch happens once on first call. Other tabs/devices do NOT auto-refresh;
 *    callers can opt in via `reloadPreferences()` (e.g. on app focus).
 *  - Writes are best-effort: errors are logged but never propagated, so a
 *    failed preference write can't break the UI.
 */
import { ref, watch, type Ref } from 'vue';
import { api } from '@/api/index';

type PrefMap = Record<string, unknown>;

const ready = ref(false);
const loading = ref(false);
const cache = ref<PrefMap>({});
// Per-key debounce handles so rapid changes coalesce into a single PUT.
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingValues = new Map<string, unknown>();
let fetchPromise: Promise<void> | null = null;
const DEBOUNCE_MS = 300;

async function ensureLoaded(): Promise<void> {
  if (ready.value) return;
  if (fetchPromise) return fetchPromise;
  fetchPromise = (async () => {
    loading.value = true;
    try {
      const res = await api.get<PrefMap>('/me/preferences');
      cache.value = res.data ?? {};
      ready.value = true;
    } catch (err) {
      // Network error: leave cache empty + ready=false so the next usePref()
      // call will retry. Subsequent usePref()s still work against defaults.
      // eslint-disable-next-line no-console
      console.warn('[user-preferences] failed to load preferences:', err);
    } finally {
      loading.value = false;
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

async function writeNow(key: string, value: unknown): Promise<void> {
  try {
    await api.put(`/me/preferences/${encodeURIComponent(key)}`, { value });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[user-preferences] failed to save ${key}:`, err);
  }
}

function scheduleWrite(key: string, value: unknown): void {
  pendingValues.set(key, value);
  const existing = pendingTimers.get(key);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(async () => {
    pendingTimers.delete(key);
    const v = pendingValues.get(key);
    pendingValues.delete(key);
    await writeNow(key, v);
  }, DEBOUNCE_MS);
  pendingTimers.set(key, handle);
}

/**
 * Flush all pending debounced writes immediately. Useful before unload or
 * when the caller needs server-side consistency right away.
 */
export async function flushPreferences(): Promise<void> {
  const keys = Array.from(pendingTimers.keys());
  for (const key of keys) {
    const handle = pendingTimers.get(key);
    if (handle) clearTimeout(handle);
    pendingTimers.delete(key);
  }
  const writes: Promise<void>[] = [];
  for (const [key, value] of pendingValues.entries()) {
    writes.push(writeNow(key, value));
  }
  pendingValues.clear();
  await Promise.all(writes);
}

/**
 * Force a re-fetch of the preferences map from the server. Existing refs
 * returned by `usePref` will see new values via the underlying cache.
 */
export async function reloadPreferences(): Promise<void> {
  ready.value = false;
  fetchPromise = null;
  await ensureLoaded();
}

export function useUserPreferences() {
  // Kick off initial fetch lazily — callers don't have to await.
  void ensureLoaded();

  /**
   * Two-way ref bound to a preference key.
   *
   * The ref's initial value is `defaultValue`. Once the server-side fetch
   * completes, the ref is reassigned to the persisted value (if any).
   * Subsequent assignments to the ref are debounced (300ms) and PUT to the
   * server.
   *
   * @typeParam T - the value type stored at this key (caller's responsibility)
   */
  function usePref<T>(key: string, defaultValue: T): Ref<T> {
    const local = ref(defaultValue) as Ref<T>;

    // Once the server fetch completes (or if it's already done), seed from cache.
    const applyFromCache = () => {
      if (Object.prototype.hasOwnProperty.call(cache.value, key)) {
        local.value = cache.value[key] as T;
      }
    };

    if (ready.value) {
      applyFromCache();
    } else {
      const stop = watch(ready, (r) => {
        if (r) {
          applyFromCache();
          stop();
        }
      });
    }

    // Write-through with debounce. We skip the first set (when the watcher
    // above seeds the value from cache) by comparing against the cached value.
    watch(local, (newVal) => {
      const cached = cache.value[key];
      // Cheap structural equality via JSON to avoid an extra PUT when the
      // cache sync writes the same value back.
      if (ready.value && JSON.stringify(cached) === JSON.stringify(newVal)) {
        return;
      }
      cache.value = { ...cache.value, [key]: newVal };
      scheduleWrite(key, newVal);
    }, { deep: true });

    return local;
  }

  return {
    ready,
    loading,
    usePref,
    flushPreferences,
    reloadPreferences,
  };
}
