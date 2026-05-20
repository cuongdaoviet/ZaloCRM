# Feature 0015: Pinned conversations

## 1. Mô tả

Sale/admin cần "ghim" các cuộc trò chuyện quan trọng (vd: khách VIP, deal đang
chốt) lên đầu danh sách chat để truy cập nhanh, không bị mất hút khi có hàng
trăm thread mới. Hiện tại CRM xếp conversations đơn thuần theo `lastMessageAt
DESC` — không có cách nào pin một thread.

Feature này thêm:
1. **Model `PinnedConversation`** — 1 row / conversation, org-scoped
2. **3 API endpoints**: pin (POST), unpin (DELETE, idempotent), list (GET)
3. **UI section "Đã ghim"** ở đầu `ConversationList`
4. **Pin button** trong header `MessageThread` (next to contact-panel toggle)

## 2. User Stories liên quan

- **US-0015-1:** Là sale, tôi muốn ghim deal đang chốt lên đầu để mở lại nhanh
  mỗi sáng mà không phải scroll/tìm.
- **US-0015-2:** Là admin, tôi muốn pin team-wide — mọi member trong org đều
  thấy conversation đó được ghim (không phải pin per-user).
- **US-0015-3:** Là sale, sau khi xong việc, tôi muốn bỏ ghim bằng một click
  để conversation về xếp hạng thông thường theo `lastMessageAt`.

## 3. Business Rules

- **BR-0001:** Pin là **org-shared** — một row trong `pinned_conversations`
  per conversation (`@unique` trên `conversationId`). Mọi user trong org thấy
  cùng pin state.
- **BR-0002:** Tạo/xoá pin yêu cầu **`chat` access** trên Zalo account của
  conversation đó. Owner/admin bypass (như mọi nơi khác trong CRM).
- **BR-0003:** `POST /pin` idempotent — gọi 2 lần không tạo duplicate, không
  500. Lần thứ hai trả 200 với row hiện có (lần đầu trả 201).
- **BR-0004:** `DELETE /pin` idempotent — luôn 204, cho dù pin có tồn tại
  trước đó hay không. Dùng `deleteMany` để không throw "not found".
- **BR-0005:** `GET /pinned` filter theo `req.user.orgId`. Với role `member`,
  filter thêm theo Zalo account mà user có access. Owner/admin thấy mọi pin
  trong org.
- **BR-0006:** Cross-org access trả **404** (không leak existence của
  conversation thuộc org khác) — convention của CRM.
- **BR-0007:** FK `onDelete: Cascade` trên `conversationId`, `zaloAccountId`,
  `orgId`. Khi conversation hoặc account bị xoá, pin tự động biến mất.
- **BR-0008:** Pinned section sắp xếp theo `pinnedAt DESC` (mới ghim nhất
  hiện đầu tiên).

## 4. Schema

```prisma
model PinnedConversation {
  id             String   @id @default(uuid())
  orgId          String   @map("org_id")
  zaloAccountId  String   @map("zalo_account_id")
  conversationId String   @unique @map("conversation_id")
  pinnedAt       DateTime @default(now()) @map("pinned_at")

  org          Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  zaloAccount  ZaloAccount  @relation(fields: [zaloAccountId], references: [id], onDelete: Cascade)
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([orgId, pinnedAt(sort: Desc)])
  @@map("pinned_conversations")
}
```

Back-references added to `Organization.pinnedConversations`,
`ZaloAccount.pinnedConversations`, `Conversation.pin` (single, optional).

## 5. API

| Method | Path | Permission | Status codes |
|--------|------|------------|--------------|
| POST   | `/api/v1/conversations/:id/pin`    | requireZaloAccess('chat') | 201 created / 200 already pinned / 404 cross-org / 403 no access |
| DELETE | `/api/v1/conversations/:id/pin`    | requireZaloAccess('chat') | 204 (idempotent) / 404 cross-org / 403 |
| GET    | `/api/v1/conversations/pinned`     | auth only (org-scoped + ACL filter for members) | 200 |

### POST `/api/v1/conversations/:id/pin`

- **Body:** none
- **Response 201:** `{ id, orgId, zaloAccountId, conversationId, pinnedAt }`
- **Response 200:** same shape — already pinned (idempotent path).

### DELETE `/api/v1/conversations/:id/pin`

- **Body:** none
- **Response 204:** no content — always returned if conversation exists in org.

### GET `/api/v1/conversations/pinned`

- **Response 200:**
  ```json
  {
    "conversations": [
      {
        "id": "uuid",
        "orgId": "uuid",
        "zaloAccountId": "uuid",
        "contactId": "uuid | null",
        "threadType": "user | group",
        "externalThreadId": "string | null",
        "lastMessageAt": "ISO8601 | null",
        "unreadCount": 0,
        "isReplied": true,
        "createdAt": "ISO8601",
        "contact": { "id", "fullName", "phone", "avatarUrl", "zaloUid" },
        "zaloAccount": { "id", "displayName", "zaloUid" },
        "messages": [ /* last 1 message preview */ ],
        "pinnedAt": "ISO8601"
      }
    ]
  }
  ```
- Sorted by `pinnedAt DESC`.

## 6. Frontend

### Composable: `frontend/src/composables/use-pinned-conversations.ts`

- Module-level singleton state (`pinnedIds: Set<string>`) — shared across
  components so `ChatView`, `ConversationList` and `MessageThread` see the
  same set.
- `pin / unpin / togglePin` — **optimistic** (flip local state first, call
  API, rollback on error).
- `fetchPinned()` — called once on `ChatView` mount.

### ConversationList

- Splits incoming `conversations` into pinned (matching `pinnedIds`) vs.
  unpinned via two computed lists.
- Renders **"Đã ghim"** section (with `mdi-pin` icon) at top when there is at
  least one pin in the visible list.
- Each row has a small pin button (`mdi-pin` for pinned, `mdi-pin-outline`
  for not pinned) revealed on hover for unpinned rows; always visible on
  pinned rows.
- Existing search + account filter logic untouched.

### MessageThread

- New header button (`mdi-pin` / `mdi-pin-outline`) next to the existing
  contact-panel toggle. Tooltip "Ghim cuộc trò chuyện" / "Bỏ ghim".

## 7. Edge Cases

- **Conversation deleted** → FK cascade removes the pin row automatically.
- **Member loses ACL on account** → they still cannot pin/unpin (`requireZaloAccess('chat')`
  fails with 403). Existing pins remain in DB, just hidden from their `/pinned`
  response by the ACL filter on GET.
- **Race condition on optimistic pin** → if the server call fails after the UI
  flipped, the local Set rolls back. The user sees the row briefly bounce.
- **`/pinned` path collision** with `/:id` — Fastify's radix tree prefers
  static segments, so `/conversations/pinned` always matches the dedicated
  handler, never the `:id` parser in `chat-routes.ts`.

## 8. Acceptance Criteria

- [ ] **AC-0001:** Owner gọi `POST /pin` 1 lần → 201, 1 row trong DB
- [ ] **AC-0002:** Gọi `POST /pin` 2 lần → 201 rồi 200, vẫn 1 row (idempotent)
- [ ] **AC-0003:** Unpin xong re-pin lại → OK, row mới được tạo
- [ ] **AC-0004:** `DELETE /pin` trên conv chưa pin → 204 (không 404)
- [ ] **AC-0005:** Cross-org: owner org B pin conv của org A → 404
- [ ] **AC-0006:** Member không access → 403 trên POST và DELETE
- [ ] **AC-0007:** Member có `read` (không có `chat`) → 403 trên POST
- [ ] **AC-0008:** Member có `chat` → 201 trên POST
- [ ] **AC-0009:** `GET /pinned` trả về theo `pinnedAt DESC`, lọc đúng org
- [ ] **AC-0010:** `GET /pinned` cho member chỉ trả pin trên account user có
      ACL; conv ngoài access scope bị ẩn
- [ ] **AC-0011:** Xoá conversation → pin tự động bị xoá (FK cascade)
- [ ] **AC-0012:** FE: pin button trong list + header MessageThread hoạt
      động (toggle optimistic, rollback nếu API fail)
- [ ] **AC-0013:** FE: section "Đã ghim" hiển thị ở đầu list, có icon
      `mdi-pin`, các pinned rows tách biệt khỏi unpinned bằng `v-divider`
- [ ] **AC-0014:** Build pass (backend `tsc` + frontend `vue-tsc + vite`)

## 9. Test Plan

- **Integration** (`backend/tests/integration/pin-conversation.integration.test.ts`):
  - Pin idempotency
  - Unpin then re-pin
  - Unpin idempotency
  - Cross-org isolation (POST + DELETE)
  - Member without ACL → 403
  - Member with read-only → 403
  - Member with chat → 201
  - GET `/pinned` org isolation + ordering
  - GET `/pinned` member ACL filter
  - FK cascade on conversation delete
- **Build** test: `npm run build` (backend + frontend)

## 10. Out of Scope

- Per-user pinning (each user's own pinned set) — pins are org-shared by design
- Pin ordering / drag-to-reorder (always `pinnedAt DESC`)
- Bulk pin / unpin
- Pin search highlight
- Pin notification when teammate pins a conv (out of scope, could be Phase 2)
- Activity log entry for pin/unpin (current: only `logger.info`; can be added
  if audit needs grow)
