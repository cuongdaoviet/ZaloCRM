# Feature 0028: Sticker support (proxy `getStickersDetail` + picker)

## 1. Mô tả

Stickers (animated GIF/PNG sequence) là phần lớn UX vui vẻ trong chat Zalo.
Hôm nay sticker từ KH gửi đến render dưới dạng placeholder text "🎁 Sticker"
hoặc tương tự — rep không thấy nội dung. Outbound: rep không có sticker
picker nên không gửi được sticker.

Feature này:
1. **Inbound render**: parse sticker payload trong Message content, hiện
   inline sticker image (animated GIF or PNG sprite tuỳ Zalo CDN).
2. **Picker outbound**: button "Sticker" trong composer, mở picker với
   set sticker phổ biến (Zalo system stickers). Gửi qua zca-js
   `sendSticker` hoặc tương đương.
3. **Proxy endpoint**: tránh CORS — backend proxy gọi
   `api.getStickersDetail` từ zca-js để FE không phải fetch trực tiếp.

Match ZaloCRM-3.0 v3.0: "Sticker animated".

## 2. User Stories

- **US-0028-1:** Là Sale, khi KH gửi sticker, tôi thấy sticker animation
  trong message thread thay vì placeholder text.
- **US-0028-2:** Là Sale, tôi bấm icon sticker trong composer → picker
  hiện grid stickers phổ biến → click → gửi sticker.
- **US-0028-3:** Là Sale, sticker tôi vừa gửi hiện trong message thread
  như inbound stickers.

## 3. Business Rules

### Inbound rendering

- **BR-0001:** Zalo gửi sticker với `msgType` riêng (verify zca-js field —
  thường là `chat.sticker` hoặc số). Message content (JSON) có:
  - `id` / `stickerId`: numeric ID của sticker.
  - `catId`: catalogue / pack ID.
  - `type`: animation type (static / animated).
  - URL fields: có thể có `cdnUrl`, hoặc cần lookup qua `getStickersDetail`.
- **BR-0002:** Detection: nếu `Message.contentType === 'sticker'` (cần
  thêm content type mới), render `<img src={stickerCdnUrl}>` inline với
  max-height 120px.
- **BR-0003:** Nếu URL không có trong content JSON (Zalo gửi chỉ stickerId
  + catId), gọi proxy endpoint lookup. Cache theo `stickerId`.

### Outbound

- **BR-0004:** Composer button "Sticker" (icon: mdi-sticker-emoji hoặc
  tương đương). Click → open picker drawer/popover.
- **BR-0005:** Picker hiện stickers từ catalogue mặc định + recent used
  (phase 1: hardcode 1-2 system catalogues; phase 2: user-customizable).
- **BR-0006:** Click sticker → gửi qua endpoint
  `POST /api/v1/conversations/:id/stickers` với body
  `{ stickerId, catId, type }`. Backend gọi zca-js `api.sendSticker(...)`.
- **BR-0007:** Persist Message với `contentType='sticker'`, content =
  stringified `{ stickerId, catId, type, cdnUrl }`.

### Proxy endpoint

- **BR-0008:** `GET /api/v1/zalo/stickers/:stickerId?catId=X`:
  - Auth: `requireZaloAccess('chat')` trên zalo account của caller's
    org (chấp nhận accountId từ query để identify pool).
  - Backend gọi `api.getStickersDetail({ stickerId, catId })`.
  - Parse response → trả `{ stickerId, catId, cdnUrl, animationType }`.
  - Cache 24h (sticker URLs are stable enough).

- **BR-0009:** `GET /api/v1/zalo/sticker-catalogues?accountId=X`:
  - Trả list stickers catalogues default + recent.
  - Phase 1: hardcode 1 catalogue ID = "system_default" với sample 20
    stickers. Phase 2: fetch full catalogue from Zalo.

## 4. Input / Output

### Schema migration

KHÔNG schema change. `Message.contentType` đã là VARCHAR (chấp nhận giá trị
mới 'sticker').

Implementer kiểm tra `detectContentType` trong `zalo-message-helpers.ts`
để thêm logic detect 'sticker'.

### Endpoints

#### `POST /api/v1/conversations/:id/stickers`

- Body: `{ stickerId: number, catId: number, type: number }`.
- Auth: `requireZaloAccess('chat')`.
- Behavior: gọi zca-js sendSticker; persist Message; emit Socket.IO
  `chat:message`.
- Response 200: `{ messageId, sticker: { stickerId, catId, type, cdnUrl } }`.
- Errors:
  - 400 `invalid_body`.
  - 403 ACL.
  - 502 `zalo_send_failed`.

#### `GET /api/v1/zalo/stickers/:stickerId?catId=X&accountId=Y`

- Per BR-0008.
- Response: sticker detail.

#### `GET /api/v1/zalo/sticker-catalogues?accountId=X`

- Phase 1: hardcode response.

### Frontend

- `MessageThread.vue` adds sticker branch in template render switch:
  ```vue
  <template v-else-if="msg.contentType === 'sticker'">
    <img :src="getStickerUrl(msg)" class="chat-sticker" />
  </template>
  ```
- New component `StickerPicker.vue`:
  - Tabbed pack list (phase 1: 1 tab "Default").
  - Grid of stickers (use catalogues endpoint).
  - On click: emit `select` with stickerId+catId+type → composer triggers POST.
- ChatInputBar adds sticker button toggle showing picker.

## 5. Edge Cases

- **EC-0001:** Sticker URL hết hạn (Zalo CDN) → broken image; fallback alt
  text "Sticker".
- **EC-0002:** zca-js `getStickersDetail` fail → 502 + fallback FE shows
  generic sticker placeholder.
- **EC-0003:** Account offline → 503 hoặc graceful empty catalogue.
- **EC-0004:** User send sticker liên tục (spam) → existing rate limit
  trên POST conversations/:id (nếu có) áp dụng. KHÔNG thêm rate limit
  riêng phase 1.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Inbound sticker: Message persisted với
      `contentType='sticker'`, content JSON đầy đủ stickerId+catId.
- [ ] **AC-0002:** FE: message với contentType='sticker' render `<img>`,
      KHÔNG fallback text placeholder.
- [ ] **AC-0003:** POST `/conversations/:id/stickers` với valid body →
      200, Message DB row, zca-js called.
- [ ] **AC-0004:** GET `/zalo/stickers/:id` với valid params → 200 trả
      cdnUrl.
- [ ] **AC-0005:** GET `/zalo/sticker-catalogues` → 200 với at least 1
      catalogue (phase 1 hardcoded).
- [ ] **AC-0006:** Cache: 2 calls same stickerId trong 24h → spy 
      api.getStickersDetail called once.
- [ ] **AC-0007:** Member không ACL chat → 403 trên cả 3 endpoints.
- [ ] **AC-0008:** FE: composer sticker button mở picker, click sticker
      → message gửi + render trong thread.
- [ ] **AC-0009:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Message` table — content type 'sticker', no schema change.
- `backend/src/modules/chat/chat-routes.ts` — POST stickers endpoint.
- `backend/src/modules/zalo/zalo-routes.ts` (or new
  `zalo-sticker-routes.ts`) — GET stickers + catalogues.
- `backend/src/modules/zalo/zalo-message-helpers.ts` — detect sticker
  contentType in inbound.
- `backend/src/modules/zalo/zalo-pool.ts` — expose `api.sendSticker`,
  `api.getStickersDetail`.
- `frontend/src/components/chat/MessageThread.vue` — render branch.
- `frontend/src/components/chat/StickerPicker.vue` — new.
- `frontend/src/components/chat/ChatInputBar.vue` — button + picker open.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema/contentType detection | ~15 |
| Backend POST sticker + zca-js wiring | ~60 |
| Proxy GET sticker detail + cache | ~50 |
| Proxy GET catalogues (phase 1 hardcoded) | ~30 |
| FE MessageThread render branch | ~25 |
| FE StickerPicker component | ~150 |
| FE ChatInputBar button | ~30 |
| Backend tests | ~120 |
| **Tổng** | **~480 LOC** |

### Risk: MEDIUM

zca-js sticker API surface chưa được dùng trong codebase — needs
verification. Animated sticker rendering có thể là PNG sequence (Lottie?)
hoặc GIF — verify Zalo CDN response Content-Type khi impl. Fallback to
static frame an toàn phase 1.

### Test strategy

- Backend: mock zca-js sendSticker + getStickersDetail. Assert correct
  args, cache behavior.
- FE: mount MessageThread with stub sticker message → assert `<img>`
  rendered.
- FE: mount picker → click → assert emit.
- Manual smoke: real sticker from Zalo, verify animation plays.

### Deviations from ZaloCRM-3.0

3.0 release note ngắn. Chúng ta hardcode catalogue phase 1 để giảm scope;
phase 2 implement full catalogue browser.

### Out of scope (Phase 2)

- Full catalogue browser (browse all packs).
- User upload custom stickers.
- Sticker history / favorites.
- Sticker search.
- Send sticker reactions (different from regular reactions Feature 0021).
