# Feature 0026: Mention rendering + auto-complete

## 1. Mô tả

Group chats trên Zalo có cú pháp `@<uid>` để gọi thành viên cụ thể. Hôm nay
chúng ta lưu raw `@2347234782` trong message content và render nguyên xi —
sale đọc khó hiểu, soạn @mention thủ công khó nhớ uid. ZaloCRM-3.0 release
note v3.0 ghi "@mention không bôi lố" (fix bug rendering), implying họ đã
có feature; ta chưa có.

Feature này:
1. **Backend**: endpoint trả member list của 1 group conversation.
2. **Frontend render**: parse `@<uid>` token trong message content, thay
   bằng styled chip (displayName của member).
3. **Frontend composer**: gõ `@` mở picker dropdown filter theo
   displayName, click member → chèn `@<uid>` token và display chip.

## 2. User Stories

- **US-0026-1:** Là Sale, khi đọc tin nhóm có `@Lan Anh` thay vì chuỗi uid,
  tôi biết ngay ai đang được gọi tên.
- **US-0026-2:** Là Sale, khi gõ `@` trong composer của 1 group chat,
  dropdown hiện member list, gõ thêm chữ cái sẽ filter, Enter/click chọn
  → message tự chèn mention đúng định dạng Zalo.
- **US-0026-3:** Là Sale, khi message của tôi gửi đi có `@uid` token, tôi
  thấy chip hiển thị tên giống Zalo native app.

## 3. Business Rules

### Mention token format

- **BR-0001:** Zalo định dạng mention trong content là token chuỗi: `@<uid>`
  ngay liền số. Chúng ta dùng cùng định dạng (không escape, không bracket).
  Reason: gửi qua zca-js `sendMessage` cần content có đúng raw token này
  để Zalo nhận diện.
- **BR-0002:** Khi render trong CRM UI, regex match `@(\d{6,20})` để
  extract uid. Lookup vào member map → nếu tìm thấy → render chip
  `<span class="mention-chip">@{displayName}</span>`. Nếu không tìm thấy
  (uid không trong member list, hoặc member bỏ group) → render fallback
  `@{uid}` muted text.
- **BR-0003:** Mention chip CHỈ render trong group conversation. User-to-user
  conversation: skip parsing (rare nhưng defensive).

### Composer auto-complete

- **BR-0004:** Trigger: ký tự `@` ngay sau khoảng trắng/đầu dòng. Nếu
  trước `@` là chữ/số khác (vd email): KHÔNG trigger.
- **BR-0005:** Picker hiện top 10 members (sorted by displayName), filter
  realtime theo prefix match (case-insensitive, NFC normalized).
- **BR-0006:** ESC đóng picker. ArrowDown/Up navigate. Enter chèn highlighted
  member. Click member chèn ngay.
- **BR-0007:** Chèn format: thay query text (từ `@` đến caret) bằng
  `@<uid> ` (có trailing space). Caret position về sau space.
- **BR-0008:** Composer state lưu mentions như **tokens** internal, NHƯNG
  khi gửi đi (POST `/conversations/:id/messages`) chỉ gửi `content` string
  với raw `@<uid>` (không cần tách field riêng). Reason: zca-js
  `sendMessage` chấp nhận plain text với `@uid` inline.

### Member source

- **BR-0009:** Backend endpoint `GET /api/v1/conversations/:id/members`:
  - Chỉ hợp lệ khi conversation là group (`Contact.metadata.isGroup ===
    true`). Non-group → 400 `not_a_group`.
  - Requires `requireZaloAccess('chat')`.
  - Trả list `{ uid, displayName, avatarUrl }`. Source: gọi
    `api.getGroupInfo(groupId)` từ zca-js qua zaloPool, parse member
    array (vd `memVerList`, `extraInfo`, hoặc field tương đương zca-js
    phiên bản hiện tại — verify tại implementation time).
  - Cache 5 phút per `conversationId` để tránh hit Zalo API mọi keystroke.
    In-memory Map TTL.
- **BR-0010:** Endpoint trả `[]` (empty) nếu group không có api session
  (account offline) — UI sẽ disable auto-complete với hint
  "Đang offline, không thể tải thành viên".

### Sanitization

- **BR-0011:** Chip render bằng DOM construction trong Vue template (không
  innerHTML). Vue auto-escape attribute values; mention chip wraps each
  member name trong `<span>` text node + interpolation `{{ name }}`. KHÔNG
  dùng `v-html` cho mention content.
- **BR-0012:** Nếu displayName chứa ký tự gây nhầm regex (vd chính chữ
  `@`), không vấn đề: chip wrap toàn bộ name, không tái parse.

## 4. Input / Output

### Schema

KHÔNG thêm field DB. Mentions sống trong message content string.

### Endpoint

#### `GET /api/v1/conversations/:id/members`

- **Auth:** `requireZaloAccess('chat')` trên conversation's account.
- **Permission errors:** 403 (no ACL), 404 (cross-org or non-existent).
- **Behavior:**
  - Load conversation → kiểm tra `contact.metadata.isGroup`. Non-group →
    400 `not_a_group`.
  - Lấy `groupId` từ `contact.zaloUid`. Gọi zaloPool API:
    `api.getGroupInfo(groupId)`.
  - Parse member list. Map từng member → `{ uid, displayName, avatarUrl }`.
    DisplayName fallback chain: `member.displayName` → `member.dName` →
    member uid (defensive).
  - Cache trong Map với key `conversationId`, TTL 5 phút.
  - Return JSON.
- **Response 200:**
  ```json
  {
    "members": [
      { "uid": "2347234782", "displayName": "Lan Anh", "avatarUrl": "https://..." },
      ...
    ]
  }
  ```
- **Errors:**
  - 400 `not_a_group` — conversation không phải group.
  - 403 — không có ACL.
  - 404 — cross-org.
  - 503 `account_offline` — zalo account chưa connected → trả `members: []`
    với HTTP 200 (UI graceful) thay vì 503. Spec hoá: ALWAYS 200, members
    có thể là rỗng nếu không lấy được.

### Frontend changes

#### Render (MessageThread.vue)

Helper `parseMentions(content, memberMap)`:
```ts
function parseMentions(content: string, memberMap: Map<string, Member>): Array<TextPart | MentionPart> {
  // Split by /@(\d{6,20})/g, return alternating text + mention parts.
}
```

Template uses `<template v-for="part in parts">` switch on `part.kind`:
- text → `{{ part.text }}`
- mention → `<span class="mention-chip">@{{ part.displayName }}</span>`

Member map fetched once when conversation opens (use existing watchEffect
on selectedConversation). Cache per conversationId trong `use-chat.ts`
state.

#### Composer (chat input component)

New component `MentionPicker.vue` hoặc inline state in composer:
- Watch input + caret position. When `@` typed at word start, open picker
  positioned above caret.
- Filter members by prefix.
- Keyboard nav (↑/↓/Enter/Esc).
- On select → splice `@<uid> ` into input text at correct position.

When sending message: content string is sent as-is (no transformation —
the `@<uid>` tokens already match Zalo's wire format).

## 5. Edge Cases

- **EC-0001:** Content có chuỗi `@123456789012345` không phải uid thật →
  regex match nhưng memberMap không có → fallback text `@123456789012345`
  muted. Không crash.
- **EC-0002:** Member rời group sau khi message đã gửi → memberMap không
  có uid đó nữa → fallback muted text. Acceptable.
- **EC-0003:** Composer gõ `@a@b` (2 @ liền): chỉ trigger picker cho `@b`
  (latest @). `@a` ở giữa từ trước → ignored.
- **EC-0004:** Mention picker open, user click ra ngoài composer → picker
  đóng (click-outside listener).
- **EC-0005:** Email trong message: `user@example.com` — regex
  `@(\d{6,20})` không match `@example` (chỉ digits). An toàn.
- **EC-0006:** Group có 500+ members → endpoint trả full list (zca-js
  `getGroupInfo` returns all). Picker chỉ hiện top 10 sau filter. OK với
  groups vừa phải; > 1000 sẽ chậm — phase 2 mới optimize.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `GET /conversations/:id/members` trên group → 200 với
      members array có ≥ 1 entry (test với mocked api.getGroupInfo).
- [ ] **AC-0002:** Endpoint trên user-to-user conversation → 400
      `not_a_group`.
- [ ] **AC-0003:** Endpoint cross-org → 404.
- [ ] **AC-0004:** Endpoint member không ACL chat → 403.
- [ ] **AC-0005:** Account offline (api null) → 200 với `members: []`.
- [ ] **AC-0006:** Endpoint call lần 2 trong 5 phút → cache hit (verify
      via spy: api.getGroupInfo called only once).
- [ ] **AC-0007:** FE: message content `"Anh @2347234782 phụ trách"` trong
      group có member 2347234782 = "Lan Anh" → render chip `@Lan Anh`.
- [ ] **AC-0008:** FE: message content `@9999999999` không có trong members
      → fallback muted text `@9999999999`.
- [ ] **AC-0009:** FE: gõ `@` trong composer của group → picker open. Gõ
      `la` → filter to members có displayName bắt đầu "la" (case-insensitive).
- [ ] **AC-0010:** FE: chọn member trong picker → input thay query bằng
      `@<uid> ` ở vị trí đúng. Caret ở sau space.
- [ ] **AC-0011:** FE: gõ `@` trong user-to-user conversation → picker
      KHÔNG mở (BR-0003).
- [ ] **AC-0012:** Gửi message với mention → content string lưu DB raw
      `@<uid>`; zca-js sendMessage nhận đúng format.
- [ ] **AC-0013:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Conversation` + `Contact` models — đọc only, không alter.
- `backend/src/modules/chat/chat-routes.ts` — thêm GET members route.
- `backend/src/modules/zalo/zalo-pool.ts` (hoặc nơi expose api instance) —
  reuse existing pattern.
- `backend/src/modules/zalo/zalo-message-helpers.ts` — đã có
  `resolveGroupName` dùng `api.getGroupInfo`. Trong route handler có thể
  refactor để share parse logic, hoặc inline gọn.
- `frontend/src/components/chat/MessageThread.vue` — `parseMentions`
  helper + template loop.
- `frontend/src/components/chat/ChatInputBar.vue` (hoặc composer component
  hiện tại) — `@` trigger + MentionPicker.
- `frontend/src/components/chat/MentionPicker.vue` — new.
- `frontend/src/composables/use-chat.ts` — fetch members on conversation
  open, expose memberMap.
- `frontend/src/types/chat.ts` — types `GroupMember`, `MentionPart`.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Backend GET /members route + cache | ~80 |
| Frontend parseMentions helper + render | ~50 |
| MentionPicker component | ~120 |
| Composer @ trigger + keyboard handling | ~70 |
| use-chat memberMap state + fetch | ~30 |
| FE TS types | ~20 |
| Backend integration tests | ~120 |
| FE component tests (basic) | ~40 |
| **Tổng** | **~530 LOC** |

### Risk: MEDIUM

Two areas of risk:
1. **zca-js member shape unknown until impl** — `getGroupInfo` response
   structure varies by zca-js version. Impl agent verifies shape, picks
   correct field (`memVerList` / `extraInfo.members` / etc.), and codes
   defensively.
2. **Composer caret/selection management is finicky** — picker positioning,
   prevent default on Enter, splice without breaking undo stack. Test
   thoroughly with multi-line input + browser nav keys.

### Test strategy

- Backend: mock `api.getGroupInfo`, return canned member list. Test
  cache, permission, non-group rejection.
- FE rendering: snapshot test for chip vs fallback. Snapshot for content
  without any mentions (should render unchanged).
- FE composer: simulate keypress sequence (`@`, `l`, `a`, Enter), assert
  resulting input string.
- Manual smoke: real group conversation, test send + receive of mentions.

### Deviations from ZaloCRM-3.0

3.0 release note chỉ ghi "fix @mention bôi lố", không spec member picker
behavior. Chúng ta tự thiết kế UX (top 10, prefix filter) — based on
standard chat app conventions.

### Out of scope (Phase 2)

- Notification bell ringing khi rep được mention (badge counter).
- `@all` / `@everyone` syntax.
- Mention search across history ("show me all messages mentioning Lan Anh").
- Avatar thumbnails trong picker (Phase 1: name only).
- Group member sync into our DB (currently fetched on-demand from zca-js).
