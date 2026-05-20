# Feature 0022: Conversation filters (unread / unreplied / time / tags)

## 1. Mô tả

Hôm nay `ConversationList` chỉ có search + account filter. Sale phải scroll
toàn bộ inbox để tìm "tin chưa đọc" hoặc "khách đã hẹn hôm qua chưa được
trả lời". Tính năng này thêm một **chip-row** 4 bộ lọc nằm ngay phía trên
danh sách hội thoại (giữa thanh tìm kiếm và row đầu tiên), cho phép sale
narrow danh sách theo: chưa đọc, chưa trả lời, khoảng thời gian, tag.

Backend nhận query params theo đúng wire-shape của ZaloCRM-3.0 `FilterRail`
(`unread`, `unreplied`, `dateFrom`, `dateTo`, `tags`) cộng thêm endpoint
phụ `GET /api/v1/conversations/counts` trả về badge `{ unread, unreplied,
total }`. Filter state được persist qua KV store của Feature 0016
(key `chat.conversation_filters`).

## 2. User Stories liên quan

- **US-0022-1:** Là Sale, tôi bấm chip "Chưa đọc" → danh sách chỉ còn các
  cuộc trò chuyện có `unreadCount > 0`; badge số đỏ ngay trên chip cho tôi
  biết tổng còn lại.
- **US-0022-2:** Là Sale, tôi bấm chip "Chưa trả lời" để xem những thread
  KH gửi tin mà mình chưa rep.
- **US-0022-3:** Là Sale, tôi bấm chip "Thời gian" → mở popover, chọn
  "Hôm nay" / "Tuần này" / "Tháng này" hoặc 2 input `from` / `to`.
- **US-0022-4:** Là Sale, tôi bấm chip "Tag" → mở `TagPicker`, chọn 1-N
  nhãn → danh sách chỉ còn KH có ít nhất 1 trong các nhãn đó.
- **US-0022-5:** Là Sale, khi mở lại CRM sau 1 tiếng, các filter tôi đặt
  vẫn còn (persisted qua user preferences).
- **US-0022-6:** Là Sale, tôi bấm "Xóa bộ lọc" → toàn bộ chip reset, danh
  sách trở về mặc định.
- **US-0022-7:** Là Member chỉ có quyền `chat` trên 2/5 Zalo accounts, khi
  bấm "Chưa đọc" → chỉ thấy unread của 2 accounts mình được phép truy
  cập (ACL không bị bypass).

## 3. Business Rules

### Backend filter semantics

- **BR-0001:** Param `unread` chấp nhận `'1'` hoặc `'true'`. Khác → bỏ
  qua (treat as not-active). Filter: `unreadCount: { gt: 0 }`.
- **BR-0002:** Param `unreplied` cùng convention. Filter: `isReplied: false`.
- **BR-0003:** Param `dateFrom` / `dateTo` là chuỗi `YYYY-MM-DD`. Bind vào
  `lastMessageAt`:
  - `dateFrom` → `gte: new Date(dateFrom)` (00:00:00 UTC của ngày đó)
  - `dateTo` → `lte: new Date(dateTo + 'T23:59:59.999Z')` (cuối ngày UTC)
  - Date invalid → HTTP 400 với message tiếng Việt.
- **BR-0004:** Legacy aliases `from` / `to` cũng được nhận, ưu tiên
  `dateFrom`/`dateTo` nếu cả hai cùng có. Lý do giữ alias: tài liệu API
  cũ trong codebase đã rò rỉ tên `from`/`to`; alias cho rebroadcasted
  bookmarks vẫn work.
- **BR-0005:** Param `tags` là CSV các tag UUID. Filter:
  `contact.contactTags: { some: { tagId: { in: tagIds } } }` (OR
  semantics). **Khác 3.0:** 3.0 dùng tag NAMES qua `JSON array_contains`
  vì chưa migrate sang junction; chúng ta dùng UUIDs qua junction
  (Feature 0019 Phase C). Tham khảo Section 8.
- **BR-0006:** Mọi filter **compose AND** với nhau và với `search` /
  `accountId` hiện hữu. Không có filter param nào → behavior y như cũ
  (back-compat).
- **BR-0007:** Member ACL áp dụng SAU khi build filter where-clause. Tức
  là filters không bao giờ bypass `zaloAccountAccess` check. Nếu member
  truyền `accountId` mà không có quyền → trả về `{ in: accessibleIds }`
  (không leak existence).

### Counts endpoint

- **BR-0008:** `GET /api/v1/conversations/counts` chấp nhận `accountId`
  (giống `/conversations`). Trả `{ unread, unreplied, total }` — đếm trên
  cùng `where` của list endpoint (sau khi áp ACL), nhưng **không** apply
  `dateFrom/dateTo/tags`. Lý do: badge counts là tổng "không lọc" để FE
  hiển thị "X tin chưa đọc tổng", không phụ thuộc filter hiện hành.
- **BR-0009:** Route phải đăng ký **TRƯỚC** `/api/v1/conversations/:id`
  trong file, nếu không Fastify sẽ parse `counts` thành `:id` và 404.

### Frontend filter UI

- **BR-0010:** 4 chip nằm ngang trong row có scroll-x nhẹ ở dưới search
  bar. Active chip: `color="primary" variant="flat"`. Inactive:
  `variant="outlined"` (smax-light theme).
- **BR-0011:** Chip "Chưa đọc" và "Chưa trả lời" hiển thị badge số từ
  endpoint `/counts` (đếm tổng, không phải số bị filter). Nếu count = 0 →
  ẩn badge.
- **BR-0012:** Chip "Thời gian" mở `v-menu` chứa 3 preset buttons +
  2 date inputs + nút "Xóa". Preset:
  - "Hôm nay" → `dateFrom = dateTo = formatLocalDate(today)`
  - "Tuần này" → `dateFrom = thứ Hai tuần này`, `dateTo = today`
  - "Tháng này" → `dateFrom = ngày 1 tháng này`, `dateTo = today`
- **BR-0013:** Chip "Tag" mở `v-menu` chứa `TagPicker` (reuse). Label
  của chip hiển thị `Tag (N)` khi có N tag đã chọn.
- **BR-0014:** Có ít nhất 1 filter active → hiển thị link "Xóa bộ lọc"
  ở cuối row, click → reset toàn bộ.

### Persistence

- **BR-0015:** State filters persist qua user-preferences KV
  (`chat.conversation_filters`). Default: tất cả false / empty. Key này
  được thêm vào `ALLOWED_KEYS` ở backend.
- **BR-0016:** State shape FE-side:
  ```ts
  interface ConversationFilters {
    unread: boolean;
    unreplied: boolean;
    dateFrom: string; // YYYY-MM-DD, '' khi không set
    dateTo: string;
    tagIds: string[];
  }
  ```

## 4. Input / Output

### `GET /api/v1/conversations` — extended

**Query params (added):**

| Param | Type | Description |
|---|---|---|
| `unread` | `'1' \| 'true' \| ''` | `unreadCount > 0` filter |
| `unreplied` | `'1' \| 'true' \| ''` | `isReplied = false` filter |
| `dateFrom` | `YYYY-MM-DD` | `lastMessageAt >= dateFrom` |
| `dateTo` | `YYYY-MM-DD` | `lastMessageAt <= dateTo (end of day)` |
| `from` | `YYYY-MM-DD` | Legacy alias for `dateFrom` |
| `to` | `YYYY-MM-DD` | Legacy alias for `dateTo` |
| `tags` | `CSV of tag UUIDs` | OR-match against `ContactTag` junction |

**Response:** unchanged shape (`{ conversations, total, page, limit }`).

**Errors:**
- 400 `{ error: "dateFrom không hợp lệ" }` — `dateFrom` không parse được
- 400 `{ error: "dateTo không hợp lệ" }` — `dateTo` không parse được

### `GET /api/v1/conversations/counts` — new

**Query params:**

| Param | Type | Description |
|---|---|---|
| `accountId` | `UUID` | (Optional) scope counts to one Zalo account |

**Response 200:**
```json
{
  "unread": 12,
  "unreplied": 7,
  "total": 84
}
```

ACL: same as `/conversations` (member sees only their accessible
accounts; cross-org returns 0).

### Frontend `ConversationFilters.vue` emit

```ts
defineEmits<{
  'update:filters': [filters: Record<string, string>];   // 3.0 wire shape
  'update:state':   [filters: ConversationFilters];       // FE state object
  reset: [];
}>();
```

The wire-shape `update:filters` payload matches ZaloCRM-3.0 `FilterRail`
exactly (keys: `unread='1'`, `unreplied='1'`, `dateFrom`, `dateTo`,
`tags`). Phase 2 (full sidebar) can swap this component without changing
the contract.

## 5. Edge Cases

- **EC-0001:** Cả `dateFrom` và `from` cùng có → ưu tiên `dateFrom`,
  `from` bị ignore (BR-0004).
- **EC-0002:** `tags=` (empty CSV) → no-op, không thêm where clause.
- **EC-0003:** `tags=<id>,,<id2>` (rỗng giữa) → split + filter Boolean →
  bỏ qua entry rỗng, dùng 2 id.
- **EC-0004:** Tag UUID không tồn tại → Prisma `some: { tagId: { in:[uuid] } }`
  match 0 rows → conversation không hiện. Không lỗi.
- **EC-0005:** Account filter + member không có quyền account → ACL
  thắng, member thấy danh sách rỗng cho account đó (không leak).
- **EC-0006:** User preference `chat.conversation_filters` đã set nhưng
  JSON shape lệch (e.g. thiếu key `tagIds`) → composable bind vào ref
  với default shape, spread sẽ chỉ ghi đè key có; FE không crash.
- **EC-0007:** Preset "Tuần này" rơi vào ngày Chủ Nhật → offset = 6, lấy
  Monday tuần đó. Convention vi-VN (tuần bắt đầu thứ Hai).

## 6. Acceptance Criteria

### Backend

- [ ] **AC-0001:** `?unread=1` trả về chỉ convs có `unreadCount > 0`.
- [ ] **AC-0002:** `?unreplied=1` trả về chỉ convs có `isReplied = false`.
- [ ] **AC-0003:** `?unread=1&unreplied=1` compose AND.
- [ ] **AC-0004:** `?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD` lọc
      `lastMessageAt` inclusive. `from`/`to` aliases work.
- [ ] **AC-0005:** Date invalid → 400 với message tiếng Việt.
- [ ] **AC-0006:** `?tags=<uuid1>,<uuid2>` OR-matches ContactTag junction.
- [ ] **AC-0007:** Filters compose với `search`.
- [ ] **AC-0008:** Member ACL áp dụng — filter không bypass.
- [ ] **AC-0009:** Cross-org isolation giữ nguyên.
- [ ] **AC-0010:** No filter params → back-compat (full list).
- [ ] **AC-0011:** `GET /counts` trả `{ unread, unreplied, total }` chính
      xác, không collision với `/:id`, scope theo `accountId` nếu có.
- [ ] **AC-0012:** `/counts` respect member ACL.
- [ ] **AC-0013:** `/counts` respect cross-org isolation.

### Frontend

- [ ] **AC-0014:** Component `ConversationFilters.vue` render 4 chips.
- [ ] **AC-0015:** Toggle chip "Chưa đọc" → flat primary; bỏ chọn →
      outlined.
- [ ] **AC-0016:** Preset "Tuần này" set `dateFrom` = thứ Hai tuần này.
- [ ] **AC-0017:** Chip "Tag" hiển thị `Tag (N)` khi chọn N tags.
- [ ] **AC-0018:** "Xóa bộ lọc" reset state về default.
- [ ] **AC-0019:** State persist qua reload (KV store).
- [ ] **AC-0020:** Build pass: `vue-tsc + vite build`.

## 7. Dependencies

- **Feature 0016:** user-preferences KV store + `usePref` composable.
- **Feature 0019:** `CrmTag` model + `ContactTag` junction + `TagPicker`
  component (reuse).
- **Schema:** Không có migration mới. Đã có sẵn `unreadCount`,
  `isReplied`, `lastMessageAt` trên `Conversation`; `contactTags` quan
  hệ trên `Contact`.

## 8. Deviations từ ZaloCRM-3.0

Bản ZaloCRM-3.0 ship một **collapsible sidebar** `FilterRail.vue` 733
LOC với nhiều bộ lọc advanced. Chúng ta KHÔNG port toàn bộ rail vì phần
lớn filter của nó phụ thuộc các schema fields mà CRM hiện tại chưa có.
Scope của Feature 0022 là **"reachable port"** — UI đơn giản (chip-row
phía trên list) + 4 filter map vào schema sẵn có.

### Khác biệt cụ thể

| Aspect | ZaloCRM-3.0 | Phase 0022 |
|---|---|---|
| **UX** | Collapsible sidebar 733 LOC | Chip-row 4 chips |
| **Tag filter** | `Contact.tags JSON array_contains` với tag NAMES | `ContactTag` junction với tag UUIDs |
| **Param `tags`** | CSV of tag names | CSV of tag UUIDs |
| **State persistence** | localStorage | User-preferences KV (Feature 0016) |

### Filter của 3.0 KHÔNG implement (deferred)

| 3.0 filter | Lý do skip | Future feature |
|---|---|---|
| `tab` (Tất cả / Khác / Hidden) | Schema chưa có `archivedAt` | 0023 |
| `accountIds[]` (multi-select) | UI hiện dùng single account dropdown | future |
| `statusId` | Conversation chưa có `statusId` | future |
| `assignedUserId` | Filter on conversation chưa wire | future |
| `hasZalo` | Aggregate field chưa có | 0033 |
| `scoreMin/scoreMax` | Lead scoring chưa có | 0040 |
| `relationshipKindAny` | Friend kind chưa được surface | 0033 |
| `threadType` (user/group) | Có sẵn trên Conversation, chưa cần UI | nice-to-have |
| `groupInbox` | Schema chưa có | future |

### Wire-shape compatibility

Param names trong query string khớp **bit-by-bit** với 3.0 cho 4 filter
mình implement (`unread`, `unreplied`, `dateFrom`, `dateTo`, `tags`).
Hệ quả: khi muốn upgrade lên FilterRail đầy đủ, chỉ cần extend backend
query parser (thêm `tab`, `statusId`, …) và swap component
`ConversationFilters.vue` sang `FilterRail.vue` — `update:filters` emit
shape của ta cũng là `Record<string,string>` (subset của 3.0 emit).

### `Contact.tags` JSON column

3.0 dùng JSON column → Phase 0019-C drop column và migrate sang
junction. Hệ quả 0022: `tags` param không thể là tag names (vì junction
chỉ join bằng `tagId`). Switch sang UUIDs vẫn ổn vì FE đã dùng
`TagPicker` trả `string[]` of IDs (Feature 0019).

## 9. Implementation notes

### LOC

- Backend: ~110 LOC (route extension + new `/counts` route + 1 allowed
  key).
- Frontend: ~290 LOC (`ConversationFilters.vue` 250 + use-chat extension
  ~40 + wiring in `ConversationList.vue` / `ChatView.vue` ~10).
- Tests: ~370 LOC (19 integration test cases).
- Total: ~770 LOC, không có migration.

### Risk

- LOW — không có schema migration; không touch ACL middleware; tất cả
  filter là pure where-clause composition trên trường có sẵn.

### Files changed

- `backend/src/modules/chat/chat-routes.ts`
- `backend/src/modules/auth/user-preference-helpers.ts`
- `backend/tests/integration/conversation-filters.integration.test.ts`
  (new)
- `frontend/src/composables/use-chat.ts`
- `frontend/src/components/chat/ConversationFilters.vue` (new)
- `frontend/src/components/chat/ConversationList.vue`
- `frontend/src/views/ChatView.vue`
- `docs/design/API.md`
- `docs/features/0022-conversation-filters/SPEC.md` (this file)
- `TODOS.md`

## 10. Out of scope

- Sidebar UI (deferred to Phase 2; 0023-0040 sẽ unlock thêm filter).
- Tab "Khác" / Hidden conversations (Feature 0023).
- Conversation-level status filter (no schema).
- Multi-account-pick filter (UX simplification).
- Bộ lọc theo lead score (Feature 0040).
- Frontend unit tests cho `ConversationFilters.vue` — hành vi nhỏ, type
  check + manual smoke đủ; backend integration test đã cover wire shape.
