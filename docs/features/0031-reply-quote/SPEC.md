# Feature 0031: Reply / quote message

## 1. Mô tả

Reply (quote) là table-stakes của mọi chat UX. KH gửi 5 tin, rep muốn trả
lời tin thứ 2 cụ thể bằng quote. Hôm nay chúng ta không có feature này;
rep phải copy-paste content cũ kèm phản hồi. ZaloCRM-3.0 v3.0 fix existing
("Reply preview JSON") implying họ đã có; ta chưa.

Feature này:
1. **Schema**: `Message.replyToMessageId` FK self-reference.
2. **Backend send**: outbound message route nhận optional `replyToMessageId`,
   load referenced message, pass `quoted` shape vào zca-js `sendMessage`.
3. **Backend persist**: lưu replyToMessageId trong DB.
4. **Backend listing**: GET conversation messages eagerly load
   `replyToMessage` projection.
5. **Frontend send**: hover message → "Reply" action → composer hiện preview
   của message đang reply, gửi đi với replyTo.
6. **Frontend render**: child message render quote bubble nested phía trên
   text, click quote → scroll to original message.

Match ZaloCRM-3.0 v3.0 release notes (bug fix implies feature exists).

## 2. User Stories

- **US-0031-1:** Là Sale, tôi hover vào tin của KH → thấy menu "Reply" →
  click → composer hiện preview message → gõ phản hồi + gửi.
- **US-0031-2:** Là Sale, message của tôi gửi đi (reply) hiện quote bubble
  phía trên text → KH thấy mạch hội thoại.
- **US-0031-3:** Là Sale, khi đọc reply chain trong thread, tôi click vào
  quote bubble → list scroll lên message gốc, highlight 1s.
- **US-0031-4:** Là Sale, inbound message từ KH có quote (KH reply tin tôi)
  → render quote bubble tương tự.

## 3. Business Rules

### Schema

- **BR-0001:** `Message.replyToMessageId: String?` — FK soft (vì có thể
  reply message từ thread cũ chưa sync, hoặc đã bị xoá). Index trên
  `(replyToMessageId)` để efficient eager load.
- **BR-0002:** ON DELETE: keep replyToMessageId nguyên (SET NULL khi
  message gốc bị xoá nếu cần — phase 1 chấp nhận FK soft, KHÔNG cascade).

### Outbound

- **BR-0003:** POST `/api/v1/conversations/:id/messages` body chấp nhận
  thêm optional `replyToMessageId`. Backend validate:
  - Message tồn tại trong cùng conversation. Nếu khác conversation →
    400 `reply_target_invalid`.
  - Message thuộc cùng org (defensive).
- **BR-0004:** Backend load message gốc → build zca-js `quoted` object
  (shape verify với zca-js docs; thường là
  `{ msgId, content, senderId, ts }`). Pass vào `api.sendMessage(...)`.
- **BR-0005:** Persist outbound message với `replyToMessageId` set.

### Inbound

- **BR-0006:** zca-js gửi inbound message có quote → `message.data.quote`
  hoặc `message.data.quoted` (verify). Parse:
  - Lookup local Message bằng `msgId` của quote. Nếu tồn tại → set
    `replyToMessageId`.
  - Nếu KHÔNG tồn tại (quote ref đến message chưa sync hoặc Zalo native
    message ngoài CRM history) → KHÔNG set FK; lưu quote metadata vào
    `content.quotedMeta` JSON (preview text + sender uid + msgId) để FE
    vẫn render quote bubble dù không scroll-to-source được.

### Listing

- **BR-0007:** GET `/api/v1/conversations/:id/messages` projection include
  `replyToMessage`: `{ id, content, contentType, senderType, senderName }`.
  Limit content preview to 200 chars (server-side truncate, append `...`).
- **BR-0008:** Quote bubble render fallback: nếu `replyToMessageId != null`
  nhưng eager-loaded `replyToMessage = null` (message bị xoá / cross-thread)
  → render "Tin nhắn không khả dụng" muted.

## 4. Input / Output

### Schema migration

```prisma
model Message {
  // ... existing fields ...
  replyToMessageId String?  @map("reply_to_message_id")
  replyToMessage   Message? @relation("MessageReply", fields: [replyToMessageId], references: [id], onDelete: SetNull)
  replies          Message[] @relation("MessageReply")

  @@index([replyToMessageId])
}
```

Migration: `ADD COLUMN reply_to_message_id TEXT NULL` + FK SET NULL + index.

### Endpoint changes

#### `POST /api/v1/conversations/:id/messages`

- Body: existing fields + optional `replyToMessageId: string`.
- Validation per BR-0003.
- Response: existing shape + `replyToMessage` projection nếu set.

#### `GET /api/v1/conversations/:id/messages` (existing)

- Add `replyToMessage` to Prisma select (BR-0007).
- TypeScript: extend Message type to include `replyToMessage`.

### Inbound handler

In message-handler.ts: extract quote from msg payload, lookup local FK,
set replyToMessageId or content.quotedMeta.

### Frontend

#### Hover action

- `MessageThread.vue` — message wrapper has hover overlay with action
  buttons. Add "Reply" button (icon).
- Click → `useChat()` state: `replyingTo: Message | null`.

#### Composer reply preview

- `ChatInputBar.vue` — when `replyingTo` is set, render preview banner
  above input: small bubble with sender name + truncated content + ✕
  button to cancel reply.
- On send: include `replyToMessageId` in POST body. Clear state after.

#### Render

- `MessageThread.vue` — when message has `replyToMessage` (or quotedMeta),
  render quote bubble nested above message bubble. Click quote → emit
  `scroll-to-message` event with id; parent scrolls list + adds 1s
  highlight class.

## 5. Edge Cases

- **EC-0001:** Reply to own message → cùng flow.
- **EC-0002:** Reply to message ngoài conversation (rare bug attempt) →
  400.
- **EC-0003:** Reply to message đã delete → FE shows fallback "không khả
  dụng" (BR-0008).
- **EC-0004:** Self-reference loop (M1 reply M2 reply M1) → no problem;
  render only direct parent, không recurse.
- **EC-0005:** Message gốc rất dài → truncated to 200 chars trong list
  endpoint; FE render preview với ellipsis.
- **EC-0006:** Inbound quote ref đến message KHÔNG có trong DB (Zalo
  native old) → quotedMeta in content. FE render preview from metadata,
  click không scroll (no target).

## 6. Acceptance Criteria

- [ ] **AC-0001:** Migration add `reply_to_message_id TEXT NULL` + FK +
      index. Build pass.
- [ ] **AC-0002:** POST với valid `replyToMessageId` → 200, DB row có FK
      set.
- [ ] **AC-0003:** POST với `replyToMessageId` thuộc conversation khác →
      400 `reply_target_invalid`.
- [ ] **AC-0004:** POST với `replyToMessageId` không tồn tại → 400
      `reply_target_invalid`.
- [ ] **AC-0005:** zca-js sendMessage được gọi với `quoted` arg đúng shape
      (mock spy verify).
- [ ] **AC-0006:** Inbound message với quote ref tới existing local message
      → `replyToMessageId` set.
- [ ] **AC-0007:** Inbound message với quote ref ngoài DB → `quotedMeta`
      JSON in content, `replyToMessageId` null.
- [ ] **AC-0008:** GET conversation messages → response items có
      `replyToMessage` projection khi applicable.
- [ ] **AC-0009:** FE: hover message → Reply button hiện; click → composer
      preview banner.
- [ ] **AC-0010:** FE: gửi reply → message render với quote bubble; click
      quote → scroll + highlight.
- [ ] **AC-0011:** FE: inbound reply render quote bubble.
- [ ] **AC-0012:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Message` model — thêm 1 FK self-ref + 1 index.
- `backend/src/modules/chat/chat-routes.ts` — POST + GET extensions.
- `backend/src/modules/chat/message-handler.ts` — inbound quote parse.
- `backend/src/modules/zalo/zalo-message-helpers.ts` — pass quote arg to
  sendMessage if needed (verify zca-js API surface).
- `frontend/src/components/chat/MessageThread.vue` — hover action + quote
  render + scroll-to.
- `frontend/src/components/chat/ChatInputBar.vue` — reply preview banner.
- `frontend/src/composables/use-chat.ts` — `replyingTo` state.
- `frontend/src/types/chat.ts` — Message type extend.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration | ~5 |
| Backend POST validation + zca-js quoted | ~50 |
| Backend GET projection | ~10 |
| Inbound quote parse | ~40 |
| FE MessageThread hover action + quote render + scroll-to | ~120 |
| FE composer reply banner + clear | ~50 |
| FE state in use-chat | ~20 |
| FE TS types | ~10 |
| Backend integration tests | ~150 |
| FE component test (basic) | ~40 |
| **Tổng** | **~495 LOC** |

### Risk: MEDIUM

zca-js `quoted` shape verify required. FK self-reference + cascade
behavior tested in migration. FE scroll-to + highlight needs DOM ref
mgmt — moderate complexity but well-trodden pattern.

### Test strategy

- Integration: outbound POST happy path + 400 cases, inbound parse
  (mocked payload with/without quote target in DB), GET projection
  shape.
- FE: hover action triggers state, banner renders, send includes
  replyToMessageId.
- FE scroll: simulate click on quote bubble, assert parent scrollIntoView
  called.
- Manual: real-world reply chain in 1 conversation, verify cross-page
  scroll.

### Deviations from ZaloCRM-3.0

3.0 fix existing bug ("Reply preview JSON") — implies they store quote as
JSON inline. We store FK for in-DB references (cleaner, supports lookup
+ delete cascade SET NULL) + JSON fallback for out-of-DB quotes. This is
strictly better than pure JSON inline.

### Out of scope (Phase 2)

- Forward message (separate feature; reply is in-thread, forward is
  cross-thread).
- Quote thread expansion (click → render full ancestor chain).
- Group reply (reply to specific person in group with @mention auto-add).
- Search by replyTo (find all replies to message X).
