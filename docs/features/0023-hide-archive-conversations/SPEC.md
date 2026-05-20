# Feature 0023: Hide / archive conversations (Tab "Khác")

## 1. Mô tả

Sale thường có 50-200 hội thoại đang mở, phần lớn không quan trọng (KH cũ, KH
đã chốt xong, spam nhẹ). Tab "Khác" cho phép ẩn các hội thoại đó khỏi tab
"Chính" mà không xóa — vẫn có thể tra lại + restore. Inbox tab chính nhẹ hơn,
focus chỉ vào cái cần xử lý.

## 2. User Stories

- **US-0023-1:** Là Sale, tôi chuột phải vào hội thoại → "Ẩn vào tab Khác" →
  conversation biến khỏi danh sách chính.
- **US-0023-2:** Là Sale, tôi bấm tab "Khác" để xem các hội thoại đã ẩn,
  scroll/search trong đó, khi cần thì chuột phải → "Đưa về tab Chính".
- **US-0023-3:** Là Sale, khi KH ẩn gửi tin mới, hội thoại **tự động** đưa
  về tab Chính (re-activated). Logic: bất kỳ message inbound nào trên
  conversation ở tab `other` → set lại `tab='main'`.
- **US-0023-4:** Là Sale, tab "Chính" và "Khác" đều có badge số tin chưa
  đọc riêng để tôi biết có cần check tab kia không.

## 3. Business Rules

### Quyền

- **BR-0001:** Đổi tab yêu cầu `requireZaloAccess('chat')` trên Zalo account
  của conversation. Owner/admin bypass.
- **BR-0002:** Cross-org → 404 (không leak).

### State

- **BR-0003:** `Conversation.tab` là `String` với 2 giá trị hợp lệ:
  `"main"` (mặc định) hoặc `"other"`. KHÔNG dùng `archivedAt: DateTime?` —
  archiving là toggle-state, không phải timestamp event. Match
  ZaloCRM-3.0's design.
- **BR-0004:** Conversation mới luôn tạo với `tab='main'`. Backfill cho
  rows cũ: `DEFAULT 'main'` trong migration.

### Auto-promote

- **BR-0005:** Khi nhận inbound message (sender = contact, không phải self)
  trên conversation có `tab='other'` → tự động flip về `tab='main'`. Reason:
  KH chủ động liên hệ lại = lý do để re-surface. Self-sent messages KHÔNG
  trigger auto-promote (rep gửi tin trong tab "Khác" không kéo nó lên).
- **BR-0006:** Khi conversation auto-promote, emit Socket.IO `chat:tab` để
  FE biết cập nhật badge counts + di chuyển row giữa tabs nếu user đang
  xem tab nào đó.

### Counts

- **BR-0007:** `/conversations/counts` (đã có từ Feature 0022) thêm 2 trường:
  `mainUnread` (số conversation `tab='main' AND unreadCount > 0`) và
  `otherUnread`. Field cũ `unread` vẫn trả về (tổng) cho backward compat.

## 4. Input / Output

### Schema migration

```prisma
model Conversation {
  // ... existing fields ...
  tab String @default("main") @map("tab")  // "main" | "other"

  @@index([orgId, tab, lastMessageAt(sort: Desc)])  // ưu tiên truy vấn theo tab + thời gian
}
```

Migration: ADD COLUMN `tab` với default `'main'`. NOT NULL. Existing rows
get `'main'`. No data loss.

### Endpoints

#### `PATCH /api/v1/conversations/:id/tab`

- **Permission:** `requireZaloAccess('chat')`.
- **Body:** `{ "tab": "main" | "other" }`.
- **Behavior:** validate tab value, `updateMany({ where: { id, orgId } })`.
- **Response 200:** `{ success: true, tab }`.
- **Errors:**
  - 400 `invalid_tab` — value không phải `main`/`other`.
  - 403 — không có ACL `chat`.
  - 404 — cross-org hoặc id sai.

#### `GET /api/v1/conversations?tab=main|other` (extends existing)

- Add `tab` to the query params (alongside `unread`, `unreplied`, etc.).
- If omitted → returns ALL conversations (both tabs). Reason: backward
  compat for existing callers (campaigns, dashboard, search) that don't
  care about the tab split.
- FE sends `tab=main` by default; user clicks Khác tab → `tab=other`.

#### `GET /api/v1/conversations/counts` (extends existing)

- Add `mainUnread` and `otherUnread` to the response.
- Existing `unread` / `unreplied` / `total` unchanged (sum across both
  tabs) — backward compat with Feature 0022.

### Auto-promote integration

In the inbound message handler (`backend/src/modules/zalo/zalo-message-handler.ts`
or wherever `prisma.message.create({ senderType: 'contact' })` happens):

```typescript
// After persisting the inbound message + updating unreadCount/lastMessageAt
if (existingConversation.tab === 'other') {
  await prisma.conversation.update({
    where: { id: existingConversation.id },
    data: { tab: 'main' },
  });
  io?.emit('chat:tab', {
    accountId, conversationId: existingConversation.id, tab: 'main',
    reason: 'inbound_message',
  });
}
```

## 5. Edge Cases

- **EC-0001:** Sale ẩn conversation đang được select (currently viewing) →
  hành vi UX: thông báo "Đã ẩn" + clear selection (FE chuyển về empty
  state). Backend không can thiệp.
- **EC-0002:** 2 sale cùng ẩn cùng conversation trong 100ms → `updateMany`
  idempotent, cả 2 đều thấy success.
- **EC-0003:** Restore conversation từ "Khác" về "Chính" giữa lúc KH đang
  gửi inbound → race lành tính. Inbound vẫn auto-promote (no-op vì đã ở
  main). Cuối cùng tab='main'.
- **EC-0004:** Conversation cũ trước feature → tab='main' (default), không
  cần backfill thủ công.
- **EC-0005:** FE đang ở tab "Khác", nhận `chat:tab` socket event cho
  conversation đó (auto-promote) → row biến khỏi danh sách Khác. Có thể
  hiện toast "1 cuộc trò chuyện đã được đưa về tab Chính" (nice-to-have).

## 6. Acceptance Criteria

- [ ] **AC-0001:** PATCH `/conversations/:id/tab` với `{tab:'other'}` →
      200 + DB row tab='other'.
- [ ] **AC-0002:** PATCH với `{tab:'invalid'}` → 400.
- [ ] **AC-0003:** PATCH conversation của org khác → 404.
- [ ] **AC-0004:** Member không có ACL chat → 403.
- [ ] **AC-0005:** GET `/conversations?tab=main` chỉ trả conversations
      tab='main'.
- [ ] **AC-0006:** GET `/conversations` (không có tab param) trả cả 2 tab.
- [ ] **AC-0007:** GET `/conversations/counts` có `mainUnread` +
      `otherUnread` cộng đúng = `unread` total.
- [ ] **AC-0008:** Conversation ở tab='other'; thêm inbound message
      `senderType='contact'` → tab tự flip về 'main'.
- [ ] **AC-0009:** Conversation ở tab='other'; thêm message `senderType
      ='self'` → tab giữ nguyên 'other' (rep gửi không kéo lên).
- [ ] **AC-0010:** Migration: thêm cột tab default 'main' cho 221 contact
      cũ → không lỗi, mọi row đều có tab='main'.
- [ ] **AC-0011:** FE: ConversationList có 2 tab "Chính" / "Khác" với
      badge count. Right-click row → context menu "Ẩn vào tab Khác" / "Đưa
      về tab Chính" tuỳ tab hiện tại.
- [ ] **AC-0012:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Conversation` model — thêm 1 field `tab`, 1 index. Other features
  reading conversations đều không cần đụng (default 'main' nên existing
  queries vẫn return as expected).
- `chat-routes.ts` `GET /api/v1/conversations` — thêm tab param parsing.
- `chat-routes.ts` `GET /api/v1/conversations/counts` — thêm mainUnread/
  otherUnread fields.
- `chat-routes.ts` — thêm `PATCH /api/v1/conversations/:id/tab`.
- **Inbound message handler** — auto-promote logic (BR-0005). Xác định
  chính xác file: tra `prisma.message.create.*senderType.*contact` trong
  `backend/src/modules/zalo/`.
- **`requireZaloAccess`** middleware (đã có từ Feature 0015).
- Socket.IO `chat:tab` event — emit từ auto-promote + tab PATCH.
- **Frontend:**
  - `ConversationList.vue` — 2 tab UI ở đầu, context menu trên row.
  - `use-chat.ts` — filter state thêm `tab: 'main' | 'other'`, persist
    qua user-prefs (extend existing `chat.conversation_filters` key
    hoặc dùng separate `chat.tab` key). Recommend mở rộng existing key.
  - Socket subscriber cho `chat:tab` event.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration (1 field + 1 index) | ~5 |
| `chat-routes.ts` PATCH /:id/tab + tab param + counts extend | ~50 |
| Inbound auto-promote (zalo-message-handler) + socket emit | ~25 |
| FE ConversationList tab bar + context menu | ~120 |
| FE use-chat tab state + socket subscriber | ~50 |
| Backend tests (integration) | ~200 |
| **Tổng** | **~450 LOC** |

### Risk: LOW

Schema change is **additive with safe default** — no data migration risk.
Auto-promote logic is single-touch in one handler. UX is straightforward.

### Test strategy

- Integration tests: PATCH happy path, validation, ACL, cross-org, auto-
  promote on inbound, no-promote on outbound, counts breakdown.
- Migration test: existing conversations get default 'main' (covered by
  Prisma's default behavior).
- No new mocking needed — uses existing patterns.

### Deviations from ZaloCRM-3.0

None material. Same field name (`tab`), same values (`'main'`/`'other'`),
same `PATCH /:id/tab` endpoint, same body shape. The only addition is
auto-promote (BR-0005) which 3.0 doesn't seem to have based on the
reference scan — but it's a natural extension and shouldn't conflict if
we ever back-port to 3.0.

### Out of scope (Phase 2 candidates)

- Bulk-archive (select N → archive all).
- Auto-archive rules ("archive conversations idle > 30 days").
- Archive at the contact level (separate from conversation-level).
- "Snooze until..." — temporal archive that auto-promotes at a set time.
