# Feature 0043: Performance — faster conversation switching

## 1. Mô tả

ZaloCRM-3.0 v3.0 release notes mention "Cải thiện độ trễ khi đổi hội thoại"
(improve conversation switching latency). Hôm nay khi sale click conversation
mới trong list, có "snap" delay ~500ms-1s khi message thread loads
(network fetch + reactive render). Goal: tối ưu xuống ≤ 200ms perceived.

## 2. User Stories

- **US-0043-1:** Là Sale, khi tôi click conversation khác, message thread
  hiện ngay (≤ 200ms perceived) thay vì spinner 1s.
- **US-0043-2:** Là Sale, scroll trong message thread (1000+ messages)
  smooth, không stutter.

## 3. Business Rules

### Strategy 1: Prefetch on hover

- **BR-0001:** Khi mouse hover conversation row trong list ≥ 200ms,
  trigger `GET /conversations/:id/messages?limit=50` in background. Cache
  result trong frontend state (Map keyed by conversationId, TTL 5 phút).
- **BR-0002:** Khi user click → load from cache nếu có (instant render).
  Background: fetch fresh batch để overwrite cache (silent revalidate).

### Strategy 2: Virtualized message list

- **BR-0003:** Message thread render dùng virtual scroll (chỉ render
  messages visible + buffer). Thresh: chỉ kick in khi conversation có
  > 100 messages (avoid overhead for short threads).
- **BR-0004:** Use `vue-virtual-scroller` hoặc Vuetify's `v-virtual-scroll`
  nếu version 4 có (verify).

### Strategy 3: Optimistic state

- **BR-0005:** Khi user click conversation, IMMEDIATELY swap header +
  contact info (from cached conversation list data), hiện skeleton cho
  message body, fade-in messages khi load done.

## 4. Input / Output

### Schema

NO change.

### Backend

NO change. All work là FE. Existing endpoints `GET /conversations/:id/
messages` đã đủ.

### Frontend

#### Prefetch hook

`frontend/src/composables/use-conversation-prefetch.ts`:

```typescript
export function useConversationPrefetch() {
  const cache = new Map<string, { messages: Message[]; ts: number }>();
  let hoverTimer: number | null = null;

  function onHover(conversationId: string) {
    hoverTimer = setTimeout(() => prefetch(conversationId), 200);
  }
  function onHoverLeave() {
    if (hoverTimer) clearTimeout(hoverTimer);
  }
  function getCached(conversationId: string) {
    const entry = cache.get(conversationId);
    if (!entry || Date.now() - entry.ts > 5 * 60_000) return null;
    return entry.messages;
  }
  async function prefetch(conversationId: string) {
    // GET messages limit=50, store in cache.
  }
  // ... expose
}
```

#### Virtual scroll integration

`MessageThread.vue`:

```vue
<template>
  <virtual-scroll
    v-if="messages.length > 100"
    :items="messages"
    :item-height="estimatedHeight"
  >
    <template #default="{ item }">
      <MessageBubble :msg="item" />
    </template>
  </virtual-scroll>
  <div v-else>
    <MessageBubble v-for="msg in messages" :key="msg.id" :msg="msg" />
  </div>
</template>
```

#### Skeleton

Display skeleton placeholder bubbles during initial load (cache miss case).

## 5. Edge Cases

- **EC-0001:** Cache stale (TTL expired) khi user click → background fetch,
  silent revalidate.
- **EC-0002:** Virtual scroll + reactive insert (new inbound message
  arrive) — verify scroll position preserved.
- **EC-0003:** Image messages in virtual list: dynamic height. Use
  estimated height + observe actual.
- **EC-0004:** Hover trigger spam (mouse over 20 rows in 2s) → only most
  recent prefetch fires due to clearTimeout.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Hover conversation 200ms+ → network request fires
      (verify via Network panel or spy).
- [ ] **AC-0002:** Click cached conversation → message thread render in
      ≤ 200ms (verify via performance.mark / DevTools).
- [ ] **AC-0003:** Conversation với 500 messages → virtual scroll active,
      DOM nodes ≤ 50 visible at any time (verify via querySelectorAll).
- [ ] **AC-0004:** Scroll smooth, no stutter (manual).
- [ ] **AC-0005:** New inbound message arrive while viewing → list updates
      correctly, scroll position preserved or auto-scrolled to bottom
      based on user's current scroll.
- [ ] **AC-0006:** Build pass: vue-tsc + vite.

## 7. Dependencies

- `frontend/src/components/chat/MessageThread.vue` — virtual scroll
  integration.
- `frontend/src/composables/use-conversation-prefetch.ts` — new.
- `frontend/src/composables/use-chat.ts` — integrate cache for initial
  load.
- `frontend/src/components/chat/ConversationList.vue` — hover handlers.
- Package: `vue-virtual-scroller` (verify if already installed).

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Prefetch hook + cache | ~80 |
| ConversationList hover wiring | ~30 |
| MessageThread virtual scroll | ~60 |
| Skeleton component | ~30 |
| use-chat cache integration | ~30 |
| FE tests (basic) | ~40 |
| **Tổng** | **~270 LOC** |

### Risk: MEDIUM

Virtual scroll often interacts unexpectedly with auto-scroll-to-bottom +
reactive insertions + image lazy-load. Test thoroughly.

### Measurement

Before/after with `performance.mark`:
- `mark('conv-click')` on click handler.
- `mark('thread-rendered')` on `nextTick(() => ...)` after messages
  reactive update.
- Measure delta → log to console (dev mode only).

Target: cached cases ≤ 200ms, uncached ≤ 500ms (network).

### Test strategy

- Manual: switch between 10 conversations rapidly, observe perceived
  latency.
- Automated: Playwright test that clicks 5 conversations + measures time.

### Deviations from ZaloCRM-3.0

3.0 release note doesn't specify approach. We pick conservative wins
(prefetch + virtual scroll) without rewriting state mgmt.

### Out of scope (Phase 2)

- Service-worker offline caching.
- Persistent prefetch across page reload.
- Predictive prefetch (ML model picks likely-next conversations).
- Backend response streaming (NDJSON / SSE).
- Image lazy-load optimization (`loading="lazy"` already in HTML5).
