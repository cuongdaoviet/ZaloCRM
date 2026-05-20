# Feature 0021: Message reactions

## 1. Mô tả

Sale cần thả reaction (❤️ 👍 😆 😮 😭 😡) lên từng message trong chat — vừa
để KH thấy trên Zalo, vừa để xem KH đã thả gì cho message của mình. Hiện CRM
hoàn toàn không có khái niệm reaction. Tính năng này thêm model
`MessageReaction`, endpoint outbound qua `api.addReaction` (zca-js), listener
`'reaction'` cho inbound, push live qua Socket.IO, và UI picker hover trên
mỗi message trong `MessageThread.vue`.

## 2. User Stories liên quan

- **US-0021-1:** Là Sale, tôi rê chuột lên message của KH → thấy nút emoji →
  bấm vào ❤️ → KH thấy ❤️ trên Zalo của họ, đỡ phải mở app Zalo.
- **US-0021-2:** Là Sale, tôi bấm lại đúng ❤️ trên cùng message → reaction
  bỏ đi (toggle off), giống UX Zalo native.
- **US-0021-3:** Là Sale, tôi đổi từ ❤️ sang 😆 trên cùng message → ❤️ biến
  mất, 😆 thay vào (1 user / 1 message chỉ giữ 1 reaction tại 1 thời điểm).
- **US-0021-4:** Là Sale, khi KH thả 👍 vào message của tôi, tôi thấy chip
  "👍" xuất hiện ngay dưới bubble — không phải reload chat.
- **US-0021-5:** Là Sale trong nhóm 5 người, khi 3 thành viên cùng thả 👍 →
  bubble hiển thị "👍 3" (đếm).
- **US-0021-6:** Là Admin, tôi mở chat KH cũ → mọi reaction lịch sử đã được
  CRM lưu hiển thị đúng (persisted với message).
- **US-0021-7:** Là Sale không có quyền `chat` trên Zalo account → nút
  reaction bị ẩn / API trả 403; chỉ xem được, không thả được.

## 3. Business Rules

### Quyền

- **BR-0001:** Outbound reaction yêu cầu `requireZaloAccess('chat')` trên
  Zalo account của conversation chứa message. Owner/admin của org bypass ACL
  (theo convention của CRM).
- **BR-0002:** GET `/reactions` chỉ trả về reactions thuộc conversation mà
  caller có access (`read` trở lên). Member không access account → 403.
- **BR-0003:** Cross-org access → 404 (không leak existence).

### Một user, một message, một reaction (TOGGLE-OFF behavior)

- **BR-0004:** Tại 1 thời điểm, một `(messageId, reactorId)` chỉ có **tối
  đa một** row trong `MessageReaction` — emoji mới ghi đè emoji cũ. Lý do
  chọn override-not-multi: khớp với UX Zalo native (Zalo client chỉ cho
  phép 1 reaction / user / message), tránh phình DB, và đơn giản cho UI
  counter. **Override** cho cùng emoji = **toggle off** (xóa row).
- **BR-0005:** Hệ quả của BR-0004: unique constraint **PHẢI** là
  `@@unique([messageId, reactorId])` — KHÔNG phải
  `(messageId, reactorId, emoji)` như note cherry-pick gợi ý. Lý do điều
  chỉnh schema gốc: cherry-pick note giả định Slack-style (1 user thả
  nhiều emoji); Zalo thì không. Document mismatch này ở Section 8.

### Phân biệt outbound vs inbound

- **BR-0006:** Outbound (rep → Zalo): `reactorSource = 'crm'`,
  `reactorId = user.id` (CRM uuid), `reactorName = user.fullName`.
- **BR-0007:** Inbound (Zalo → us, listener): `reactorSource = 'zalo'`,
  `reactorId = reaction.data.uidFrom` (Zalo UID string),
  `reactorName = reaction.data.dName` (hoặc null nếu Zalo không gửi).
- **BR-0008:** Self-react (event với `isSelf = true`, tức là rep thả từ
  app Zalo của chính họ HOẶC từ chính CRM với `selfListen` bật) → listener
  upsert với `reactorSource = 'zalo'`, `reactorId = zaloAccount.zaloUid`.
  Không double-persist với row CRM của outbound: dùng zalo-side
  `(messageId, reactorId=zaloUid)` khác với CRM-side
  `(messageId, reactorId=user.id)` — coexist bằng compound key tự nhiên
  (zaloUid vs user-uuid không bao giờ collide).

### Mapping enum

- **BR-0009:** Outbound mapping bắt buộc (6 standard reactions). Lưu DB ở
  **emoji char** để FE render thẳng, gọi zca-js thì convert sang enum
  `Reactions`:

  | UI emoji | Reactions enum | rType | DB `emoji` value |
  |---|---|---|---|
  | ❤️ | `HEART` (`/-heart`) | 1 | `"❤️"` |
  | 👍 | `LIKE` (`/-strong`) | 2 | `"👍"` |
  | 😆 | `HAHA` (`:>`) | 3 | `"😆"` |
  | 😮 | `WOW` (`:o`) | 4 | `"😮"` |
  | 😭 | `CRY` (`:-((`) | 5 | `"😭"` |
  | 😡 | `ANGRY` (`:-h`) | 6 | `"😡"` |
  | (remove) | `NONE` (`""`) | 0 | — (row deleted) |

  **NOTE:** `rType` numeric codes (1–6) are convention-based and not
  explicitly defined in zca-js source. Implementer should log a real
  reaction event during dev to verify each code before locking the table.
  Fix if wrong is ~5 LOC.

- **BR-0010:** Inbound mapping: listener nhận `reaction.data.content.rType`
  (số) và `rIcon` (string). Convert `rType → emoji char` qua bảng trên.
  Nếu `rType = 0` hoặc `rIcon = ""` → là "unreact": xóa row tương ứng.
  Nếu `rType` ngoài 1–6 → coi như "custom", lưu `emoji = String(rType)`
  có prefix `"custom:"` để FE biết fallback render text (Phase 1 không
  hỗ trợ rendering custom — chỉ persist).

### Activity log

- **BR-0011:** **KHÔNG** log reaction vào `ActivityLog`. Lý do: reactions
  là tương tác volume cao (hàng chục/ngày/sale), audit feed sẽ bị spam và
  giá trị forensic thấp. Nếu cần audit về sau (compliance request) thì
  re-evaluate ở Phase 2 với sampling. Chỉ log `logger.debug` để debug.

### Message lifecycle

- **BR-0012:** Khi `Message.isDeleted = true` (thu hồi): các row
  `MessageReaction` còn nguyên trong DB (FK cascade chỉ áp dụng khi
  message row bị xoá thật). UI ẩn reactions cùng với bubble "đã thu hồi".
- **BR-0013:** Khi xoá conversation → cascade xoá message → cascade xoá
  reaction (`onDelete: Cascade` trên `MessageReaction.messageId`).

### Custom reactions (Phase 1 = out of scope thực thi)

- **BR-0014:** Phase 1 chỉ expose 6 standard reactions ở UI picker. Schema
  cho phép lưu string tùy ý (`emoji: String`) để tương lai support
  custom. Inbound custom được persist (BR-0010) nhưng render fallback.

## 4. Input / Output

### Schema (Prisma)

```prisma
model MessageReaction {
  id            String   @id @default(uuid())
  messageId     String   @map("message_id")
  reactorId     String   @map("reactor_id")          // user.id (crm) | zaloUid (zalo)
  reactorSource String   @default("crm") @map("reactor_source")   // "crm" | "zalo"
  reactorName   String?  @map("reactor_name")
  emoji         String                                 // "❤️" | "👍" | … | "custom:<rType>"
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  message Message @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@unique([messageId, reactorId])   // BR-0004/0005: ONE reaction per user per message
  @@index([messageId])
  @@map("message_reactions")
}
```

Back-ref trên `Message`: `reactions MessageReaction[]`.

### Endpoints

| Method | Path | Permission | Status codes |
|---|---|---|---|
| POST   | `/api/v1/messages/:id/reactions`         | `requireZaloAccess('chat')` | 201 / 200 toggled-off / 403 / 404 |
| DELETE | `/api/v1/messages/:id/reactions`         | `requireZaloAccess('chat')` | 204 idempotent / 403 / 404 |
| GET    | `/api/v1/messages/:id/reactions`         | auth + read access          | 200 |

#### POST `/api/v1/messages/:id/reactions`

- **Body:** `{ "emoji": "❤️" | "👍" | "😆" | "😮" | "😭" | "😡" }`
- **Logic:**
  1. Validate emoji ∈ 6 standard (Phase 1).
  2. Resolve `message → conversation → zaloAccount`. Check ACL.
  3. Lấy row hiện hữu `(messageId, user.id)`:
     - Không có → upsert + gọi `api.addReaction(<enum>, dest)` → **201**.
     - Có và emoji **khác** → update emoji + gọi `api.addReaction(<enum-new>, dest)` → **201**.
     - Có và emoji **trùng** → delete row + gọi `api.addReaction(Reactions.NONE, dest)` → **200** với `{ toggledOff: true }`.
  4. Wrap zca-js call trong `trackBackground(...)` HOẶC await (await preferred — FE expects ack). Nếu zca-js throw → rollback DB write trong cùng transaction, trả 502 `zalo_reaction_failed`.
- **Response 201:**
  ```json
  {
    "id": "uuid",
    "messageId": "uuid",
    "reactorId": "user-uuid",
    "reactorSource": "crm",
    "reactorName": "Nguyễn Văn A",
    "emoji": "❤️",
    "createdAt": "ISO8601"
  }
  ```
- **Response 200 (toggle off):** `{ "toggledOff": true, "messageId": "uuid", "emoji": "❤️" }`
- **Errors:**
  - 400 `invalid_emoji` (không thuộc 6 standard).
  - 400 `message_missing_zalo_msg_id` (message chưa kịp sync `zaloMsgId`).
  - 400 `message_deleted` (`isDeleted = true` → không cho react message đã thu hồi).
  - 403 `forbidden` (không có ACL `chat`).
  - 404 `message_not_found` (cross-org hoặc id sai).
  - 502 `zalo_reaction_failed` (zca-js gọi fail / account disconnected).

#### DELETE `/api/v1/messages/:id/reactions`

- **Body:** none. Implicit: xóa reaction của caller (`reactorId = req.user.id`).
- **Logic:** `deleteMany` + gọi `api.addReaction(Reactions.NONE, dest)`. Idempotent.
- **Response 204** luôn (nếu ACL pass và message tồn tại).

#### GET `/api/v1/messages/:id/reactions`

- **Response 200:**
  ```json
  {
    "reactions": [
      { "id", "reactorId", "reactorSource", "reactorName", "emoji", "createdAt" }
    ]
  }
  ```
- Note: trong main chat flow, FE KHÔNG gọi endpoint này — `MessageThread`
  nhận reactions inline qua `Message.include({ reactions: true })` trong
  GET `/conversations/:id/messages`. Endpoint này dùng cho debug / future
  reaction-detail modal.

### Listener service (không phải endpoint)

`handleReactionEvent(accountId: string, reaction: ZcaReactionPayload): Promise<void>`

- Tìm `Message` theo `(conversationId từ threadId, zaloMsgId = data.msgId)`.
- Nếu không có message tương ứng (EC-0001) → swallow, log warn.
- Resolve `reactorSource`:
  - `reaction.isSelf = true` → tra `zaloAccount.zaloUid` làm `reactorId`,
    `reactorSource = 'zalo'`, `reactorName = displayName của account`.
  - Ngược lại → `reactorId = data.uidFrom`, `reactorName = data.dName`.
- Convert `rType` → emoji char (BR-0010).
- Nếu `rType = 0` → xóa row `(messageId, reactorId)`.
- Ngược lại upsert.
- Emit Socket.IO `chat:reaction` payload:
  ```ts
  { accountId, conversationId, messageId, reaction: {...} | null /* null = removed */ }
  ```
- Toàn bộ wrap try/catch, listener không bao giờ throw (mô phỏng pattern
  `friendship-listener.ts`).

Đăng ký trong `zalo-listener-factory.ts`:
```ts
listener.on('reaction', (reactionObject: any) => {
  void handleReactionEvent(accountId, reactionObject);
});
```

### Socket.IO event

- `chat:reaction` — đẩy về tất cả client trong org đang mở chat. FE
  composable subscribe và merge vào local message state.

### Message include shape thay đổi

`Conversation.getMessages` resolver / chat-service `listMessages` thêm
`include: { reactions: true }`. Reactions được trả về kèm mỗi message →
FE không cần round-trip thêm.

## 5. Edge Cases

- **EC-0001:** Inbound reaction cho `msgId` mà ta không có local (chat
  được sync trước khi feature ship, hoặc message bị purge). → Log warn,
  drop event. KHÔNG tạo Message placeholder (rủi ro tạo bóng ma).
- **EC-0002:** Outbound nhưng `Message.zaloMsgId` chưa kịp được populate
  (race với outbound message vừa gửi, đang chờ ack từ Zalo). → 400
  `message_missing_zalo_msg_id`. FE retry sau 500ms (UX: nút disabled
  trong window đó).
- **EC-0003:** Rep cùng org cùng react vào message của KH. **Cùng emoji
  👍** → 2 rows (vì `reactorId` khác). UI counter "👍 2". Zalo native
  side chỉ thấy react gần nhất (Zalo không có concept multi-rep).
- **EC-0004:** Self-listen race: rep gọi POST từ CRM → service ghi DB row
  CRM + gọi zca-js. zca-js trả về và trigger `'reaction'` event với
  `isSelf = true` cho cùng action. Listener cố ghi 1 row Zalo-side. **Hai
  rows coexist** (BR-0008). Counter UI dedupe theo `(reactorSource,
  reactorId)` group → vẫn hiển thị "1" cho rep đó. Lý do giữ 2 rows: đơn
  giản hơn dedupe phức tạp, và row Zalo-side là source-of-truth cho
  account devices khác.
- **EC-0005:** Account disconnected khi rep bấm react → zca-js throw →
  rollback DB write trong transaction → 502. UI optimistic flip rollback.
- **EC-0006:** Group chat 30 người, 30 reactions cùng spike → 30 socket
  emit. Acceptable cho v1 (frequency low). Phase 2 có thể debounce ở FE.
- **EC-0007:** Custom reaction inbound (rType > 6 hoặc đặc biệt) → persist
  với emoji = `"custom:<rType>"`. FE render fallback "•".
- **EC-0008:** Rep react vào message của chính mình (`Message.senderType
  = 'self'`) → cho phép. Zalo native cho phép self-react.
- **EC-0009:** `'old_reactions'` event burst khi listener reconnect →
  Phase 1 **SKIP** event này (không subscribe). Lý do: complexity của
  reconciliation lớn, value ít (reactions đã có trong DB từ trước khi
  disconnect). Document ở Out of scope.
- **EC-0010:** Race 2 reps cùng react cùng emoji vào cùng message trong
  10ms. Mỗi rep có `reactorId` riêng → 2 row khác nhau, không conflict
  unique constraint. OK.

## 6. Acceptance Criteria

- [ ] **AC-0001:** POST `/messages/:id/reactions` với emoji hợp lệ, chưa
      react → 201, 1 row trong DB, zca-js `addReaction` được gọi đúng 1 lần
      với enum tương ứng.
- [ ] **AC-0002:** POST cùng emoji lần 2 → 200 `toggledOff=true`, row
      biến mất, zca-js `addReaction(NONE, dest)` được gọi.
- [ ] **AC-0003:** POST khác emoji (đang ❤️, đổi sang 👍) → 201, row
      update, zca-js gọi với `LIKE`.
- [ ] **AC-0004:** POST với emoji không thuộc 6 standard → 400
      `invalid_emoji`.
- [ ] **AC-0005:** POST trên message đã `isDeleted=true` → 400
      `message_deleted`.
- [ ] **AC-0006:** Member không có ACL `chat` → 403.
- [ ] **AC-0007:** Cross-org POST → 404.
- [ ] **AC-0008:** Listener nhận `'reaction'` từ KH với `rType=1` cho
      message ta đã sync → row `reactorSource='zalo'`, `emoji='❤️'`
      được upsert, `chat:reaction` socket fired.
- [ ] **AC-0009:** Listener nhận `rType=0` (unreact) → row tương ứng bị
      xoá, socket emit với `reaction: null`.
- [ ] **AC-0010:** Listener nhận reaction cho `msgId` không tồn tại
      local → no-op, không crash.
- [ ] **AC-0011:** GET `/messages/:id/reactions` trả về list đúng,
      respect ACL.
- [ ] **AC-0012:** Listener tự throw (mock throw) → không crash zca-js
      socket, log error.
- [ ] **AC-0013:** zca-js `addReaction` throw → DB row rollback, response
      502, UI rollback optimistic.
- [ ] **AC-0014:** Group chat: 2 reps react 👍 cùng message → 2 rows,
      counter UI "👍 2".
- [ ] **AC-0015:** Build BE (`tsc`) + FE (`vue-tsc + vite`) pass, không
      tests fail.

## 7. Dependencies

### Backend
- **`prisma/schema.prisma`** — model `MessageReaction` + back-ref
  `Message.reactions`.
- **`modules/zalo/zalo-pool.ts`** — `zaloPool.getInstance(accountId).api.addReaction`.
- **`modules/zalo/zalo-listener-factory.ts`** — thêm `listener.on('reaction', ...)`.
- **`modules/zalo/zalo-access-middleware.ts`** — `requireZaloAccess('chat')` (đã có).
- **`modules/chat/chat-service.ts`** — `listMessages` cần `include: { reactions: true }`.
- **`shared/utils/background-tasks.ts`** — `trackBackground()` nếu cần
  fire-and-forget cho socket emit.
- **Mới:**
  - `modules/reactions/reaction-service.ts` — addOrToggle / remove / list.
  - `modules/reactions/reaction-routes.ts` — 3 endpoints.
  - `modules/reactions/reaction-listener.ts` — `handleReactionEvent()`.
  - `modules/reactions/reaction-mapping.ts` — enum/rType ↔ emoji.

### Frontend
- **`composables/use-reactions.ts`** (mới) — optimistic add/remove/toggle
  + Socket.IO subscriber cho `chat:reaction`.
- **`components/chat/MessageThread.vue`** — overlay picker hiện khi
  hover message bubble; chip stack reactions ở dưới bubble.
- **`components/chat/ReactionPicker.vue`** (mới) — 6 emoji button row.
- **`components/chat/ReactionChips.vue`** (mới) — group by emoji, count,
  click để toggle.
- **`stores/chat.ts`** — message shape thêm field `reactions: Reaction[]`,
  socket handler để merge.

### zca-js (verified)
- `api.addReaction(icon: Reactions | CustomReaction, dest: AddReactionDestination)`
  — file `node_modules/zca-js/dist/apis/addReaction.d.ts`.
- `listener.on('reaction', (reaction: Reaction) => void)` — file
  `node_modules/zca-js/dist/apis/listen.js:273,280`.
- `Reactions` enum + `Reaction` class — `node_modules/zca-js/dist/models/Reaction.d.ts`.

## 8. Implementation notes

### Schema deviation từ cherry-pick note

Cherry-pick note đưa unique key `(messageId, reactorId, emoji)` (Slack
style: 1 user thả nhiều emoji distinct). Sau khi đọc UX Zalo native và
zca-js (mỗi `Reaction` event chỉ có 1 `rIcon`/`rType`, send `NONE` để
unreact), ta chốt unique key `(messageId, reactorId)` — 1 user / 1
message / 1 emoji tại 1 thời điểm. Decision logged in Section 3 BR-0005.

### LOC estimate

| Area | LOC |
|---|---|
| `schema.prisma` block | ~20 |
| `reaction-service.ts` (add/toggle/remove/list + transaction handling) | ~140 |
| `reaction-routes.ts` (3 endpoints + Zod schemas) | ~80 |
| `reaction-listener.ts` (handleReactionEvent + mapping) | ~90 |
| `reaction-mapping.ts` (enum table + helpers) | ~30 |
| `chat-service.ts` patch (include reactions) | ~5 |
| `zalo-listener-factory.ts` patch (1 listener.on) | ~5 |
| Backend tests (integration: outbound, inbound, toggle, ACL) | ~280 |
| FE `use-reactions.ts` composable | ~90 |
| FE `ReactionPicker.vue` + `ReactionChips.vue` | ~140 |
| FE `MessageThread.vue` patch (hover trigger + chip slot) | ~50 |
| FE `chat.ts` store patch (socket subscribe + merge) | ~40 |
| **Total** | **~970 LOC** |

(Cao hơn target 200–300 ban đầu vì cherry-pick note chỉ tính 1 hướng;
inbound listener + socket push + FE chiếm phần lớn.)

### Risk: MEDIUM

Lý do (1 câu): Listener event đã verified và mapping enum đã verified
trong source zca-js, nhưng đây là tích hợp zca-js live thứ hai sau 0020 —
self-listen race (EC-0004) và transaction rollback khi zca-js throw
(AC-0013) là 2 cạm bẫy thực, tương đương rủi ro của 0020.

### Test strategy

- **Unit:**
  - `reaction-mapping.ts`: bảng convert rType ↔ emoji ↔ enum (round-trip).
  - Permission check trong service.
  - Toggle decision logic (cùng emoji vs khác emoji vs no row).
- **Integration (Postgres + mocked `zaloPool.getInstance()`):**
  - Mock `api.addReaction` là `vi.fn()` resolved/rejected — assertion về
    args (enum + dest object shape).
  - POST → 201 + DB row + addReaction call.
  - POST cùng emoji 2x → 201 then 200 toggle-off + 2 calls (second với NONE).
  - POST khác emoji → 201 + update row + call với new enum.
  - addReaction reject → 502, DB rollback (assertion: 0 rows).
  - Listener: gọi `handleReactionEvent` thủ công với payload mock; assertion DB.
  - Listener với `isSelf=true` → row có `reactorId = zaloUid` (không phải user.id).
  - Cross-org / no-ACL → 403/404.
- **E2E (Playwright, smoke):**
  - Hover message, bấm ❤️, chip xuất hiện. Bấm lại, chip biến mất.
- **Test isolation:** dùng `flushBackgroundTasks()` trước `resetDb()` để
  tránh deadlock socket emit (PR #24 lesson).

### Out of scope (v1 — Phase 2 candidates)

- Custom reactions (rendering UI). Persistence đã có sẵn.
- `'old_reactions'` reconciliation event (history sync khi reconnect).
- Reaction detail modal (xem ai react gì khi click chip).
- Activity log cho reactions (BR-0011).
- Reaction trên group chat của bot/page (chỉ test trên 1-1 trước).
- Notification khi KH react message (FE chỉ render, không toast).
- Multi-emoji per user (Slack style) — đã chốt Zalo style 1-per-user.

### Deployment notes

- Schema mới — `npm run db:push` trên staging trước khi merge.
- Không có data migration cần thiết (table mới, không backfill historical).
- Feature flag không cần — UI bị ẩn nếu không có ACL `chat`, an toàn cho
  rollout dần.
- Listener `'reaction'` đăng ký trong `attachZaloListener` — tự động bật
  cho mọi Zalo account đã connect sau khi deploy. Không cần reconnect.
