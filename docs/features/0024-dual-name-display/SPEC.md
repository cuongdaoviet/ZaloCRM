# Feature 0024: Dual name display (CRM Name + Zalo Name)

## 1. Mô tả

Hôm nay `Contact.fullName` là single field. Khi rep sửa tên thành "Anh Tuấn
CFO XYZ" để dễ nhớ, họ mất luôn tên gốc trên Zalo ("Nguyễn Văn T.") — tên này
quan trọng để disambiguate cold-leads (KH cùng nickname rep đã đặt, hoặc khi
cần đối chiếu với người Zalo gửi inbound).

Feature này tách 2 trường:
- `fullName` — CRM name, do rep tự đặt và sửa. Ưu tiên hiển thị.
- `zaloDisplayName` — tên Zalo gốc, **auto-sync** từ inbound message handler,
  rep không edit. Hiển thị muted bên cạnh CRM name nếu khác.

Match ZaloCRM-3.0 field name (`zalo_display_name`).

## 2. User Stories

- **US-0024-1:** Là Sale, khi nhìn vào contact list/chat header, tôi thấy
  tên CRM (do tôi tự đặt) ở primary và tên Zalo gốc ở secondary nếu 2 cái
  khác nhau → biết ngay đây là KH nào trên Zalo.
- **US-0024-2:** Là Sale, khi tôi sửa CRM name, tên Zalo gốc vẫn được giữ
  nguyên — không bị overwrite.
- **US-0024-3:** Là Sale, khi KH đổi tên hiển thị trên Zalo, inbound message
  handler tự cập nhật `zaloDisplayName` để tôi thấy thay đổi mà không phải
  làm gì.

## 3. Business Rules

### Sync rule (inbound)

- **BR-0001:** Inbound message handler:
  - Contact **mới tạo** từ inbound (zaloUid lần đầu xuất hiện): set cả
    `fullName` VÀ `zaloDisplayName` = `msg.senderName`. Reason: rep chưa
    đặt CRM name → dùng Zalo name làm placeholder ban đầu.
  - Contact **đã tồn tại**: chỉ cập nhật `zaloDisplayName` khi
    `msg.senderName` thay đổi (và non-empty). KHÔNG đụng `fullName` —
    đó là field rep tự quản.
- **BR-0002:** Group contact (msg.isGroup): `zaloDisplayName` cũng được set
  từ `msg.groupName` (cùng logic): mới tạo → set cả 2, có rồi → chỉ update
  zaloDisplayName.
- **BR-0003:** `msg.isSelf` (self message) KHÔNG trigger update (đã có
  guard ở line 196).

### Display rule (frontend)

- **BR-0004:** Primary text = `fullName` (fallback `zaloDisplayName` nếu
  fullName empty/null).
- **BR-0005:** Secondary muted text = `zaloDisplayName` CHỈ khi:
  - `zaloDisplayName` non-empty, AND
  - `zaloDisplayName !== fullName` (trim + lowercase compare để bỏ qua
    case differences).
  Ngược lại → ẩn (không render).
- **BR-0006:** Vị trí hiển thị: ConversationList row, ChatHeader, Contact
  detail page header. Format: `<primary> · <muted>(<zaloDisplayName>)</muted>`
  hoặc dạng 2 dòng tuỳ component.

### Edit rule

- **BR-0007:** `PUT /api/v1/contacts/:id` body chấp nhận `fullName` thường,
  KHÔNG chấp nhận `zaloDisplayName` (read-only từ FE). Nếu body có
  `zaloDisplayName` → ignore (silently strip), không 400 (graceful).
- **BR-0008:** Khi rep tạo manual contact (POST `/contacts` từ form):
  `zaloDisplayName` không set (null). Sẽ được điền tự động lần đầu KH gửi
  inbound message (BR-0001 nhánh "đã tồn tại" cập nhật zalo name).

## 4. Input / Output

### Schema migration

```prisma
model Contact {
  // ... existing fields ...
  fullName          String?  @map("full_name")          // CRM name, rep edits
  zaloDisplayName   String?  @map("zalo_display_name")  // Zalo name, auto-synced
}
```

Migration: `ADD COLUMN zalo_display_name TEXT NULL`. Backfill cũ: NULL ok
(BR-0008 sẽ điền dần khi inbound đến). Không cần backfill thủ công.

### Inbound handler change

In `backend/src/modules/chat/message-handler.ts`:

- Around line 175 (group contact create): add `zaloDisplayName: msg.groupName`.
- Around line 186 (group contact update): change to update **only**
  `zaloDisplayName` (NOT `fullName` — that becomes rep-owned now).
- Around line 204 (user contact create): add `zaloDisplayName: msg.senderName`.
- Around line 215 (user contact update): change condition to compare
  `zaloDisplayName !== msg.senderName` (not fullName), and update
  `zaloDisplayName` only.

**Migration concern:** Existing rows have `fullName` set to whatever inbound
last wrote. After this feature, that value stays as fullName — but rep can
now edit it freely. `zaloDisplayName` stays NULL until next inbound updates
it. That's correct behavior (no surprise overwrites).

### API response shape

`GET /api/v1/contacts/:id` and list endpoints add `zaloDisplayName` to the
returned shape:

```json
{
  "id": "uuid",
  "fullName": "Anh Tuấn CFO XYZ",
  "zaloDisplayName": "Nguyễn Văn T.",
  ...
}
```

Conversation list (`GET /api/v1/conversations`) `contact` projection adds
`zaloDisplayName` to the `select` block (line 127, 590, 609 of chat-routes.ts).

### Frontend changes

- `ConversationList.vue` row template: show primary + small muted
  `(zaloDisplayName)` if BR-0005 triggers.
- `ChatHeader.vue`: same pattern in the header title area.
- `ContactDetailPage.vue` (or wherever contact name is displayed): same.
- TypeScript type `Contact` / `ContactSummary`: add `zaloDisplayName: string | null`.

## 5. Edge Cases

- **EC-0001:** `msg.senderName` rỗng/null → giữ giá trị `zaloDisplayName`
  hiện tại (không overwrite bằng empty).
- **EC-0002:** Migration rollback: drop column an toàn — không feature nào
  khác phụ thuộc.
- **EC-0003:** `fullName` rỗng nhưng `zaloDisplayName` có → display fallback
  BR-0004.
- **EC-0004:** Cả 2 đều null (impossible nhưng defensive) → hiển thị
  "Unknown" hoặc "Chưa có tên" (giữ behavior cũ của fullName fallback).
- **EC-0005:** Contact đã merge (`mergedIntoId != null`): không can thiệp.
  Inbound message của merged contact đi về primary; primary nhận update
  `zaloDisplayName`.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Schema migration adds `zalo_display_name TEXT NULL` —
      build pass, existing rows không lỗi.
- [ ] **AC-0002:** Inbound message handler từ KH mới (zaloUid lần đầu):
      Contact tạo với cả `fullName=zaloDisplayName=senderName`.
- [ ] **AC-0003:** Inbound message handler từ KH cũ (Contact đã tồn tại,
      `fullName='Anh Tuấn'`): receive message với `senderName='Nguyễn Văn T.'`
      → DB: `fullName='Anh Tuấn'` không đổi, `zaloDisplayName='Nguyễn Văn T.'`.
- [ ] **AC-0004:** Rep edit `fullName` qua PUT /contacts/:id →
      `zaloDisplayName` không đổi. Body có `zaloDisplayName` → bị strip,
      không lỗi.
- [ ] **AC-0005:** `GET /contacts/:id` và list endpoints trả thêm
      `zaloDisplayName`.
- [ ] **AC-0006:** FE hiển thị muted secondary text khi BR-0005 triggers
      (fullName ≠ zaloDisplayName, case-insensitive).
- [ ] **AC-0007:** FE không hiển thị secondary khi fullName === zaloDisplayName.
- [ ] **AC-0008:** Group contact: `zaloDisplayName=groupName`, sync khi
      groupName đổi.
- [ ] **AC-0009:** Build pass: BE tsc + FE vue-tsc + vite.
- [ ] **AC-0010:** Backend integration tests cover BR-0001, BR-0002,
      BR-0007.

## 7. Dependencies

- `Contact` model — thêm 1 field. Không đụng feature khác.
- `backend/src/modules/chat/message-handler.ts` — 4 chỗ update (group create/
  update, user create/update).
- `backend/src/modules/contacts/contact-routes.ts` — PUT validation strips
  `zaloDisplayName`.
- `backend/src/modules/chat/chat-routes.ts` — Add `zaloDisplayName` to
  `contact` select in 3 conversation-list endpoints.
- `frontend/src/components/chat/ConversationList.vue` — render secondary.
- `frontend/src/components/chat/ChatHeader.vue` — render secondary.
- `frontend/src/pages/ContactDetailPage.vue` (or equivalent) — render
  secondary.
- `frontend/src/types/contact.ts` / similar — type field.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration (1 field) | ~3 |
| Inbound handler updates (4 sites) | ~25 |
| Contact PUT body strip | ~5 |
| chat-routes select additions (3 sites) | ~6 |
| FE conversation row + chat header + contact detail | ~50 |
| FE TS types | ~5 |
| Integration tests | ~80 |
| **Tổng** | **~175 LOC** |

### Risk: LOW

Additive field with NULL default. Inbound handler change is mechanical.
FE display logic is small + has a clear hide-when-same fallback.

### Test strategy

- Integration: inbound from new contact (both fields set), inbound from
  existing contact (only zaloDisplayName updates), group contact path,
  self-message no-op, PUT strip behavior.
- Manual smoke: change Zalo display name on phone → send message → verify
  CRM shows new zalo name as muted secondary while keeping crm name primary.

### Deviations from ZaloCRM-3.0

None. Same field name (`zalo_display_name`), same display priority
(`crmName > zaloName`). 3.0 also has `crmName` as a separate field — our
codebase uses `fullName` as the CRM-editable name, so we keep that naming
to avoid a 3-field migration (`fullName` already plays the role of `crmName`
in our codebase).

### Out of scope (Phase 2)

- Bulk-rename UI (select N contacts → reset all CRM names to Zalo names).
- Audit log of zalo name changes over time (currently overwritten in place).
- Showing both names in search results (search will be added in a later
  feature).
