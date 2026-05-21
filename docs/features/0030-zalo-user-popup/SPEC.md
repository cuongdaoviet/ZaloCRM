# Feature 0030: Zalo user info popup (avatar click in group)

## 1. Mô tả

Trong group chats, sale không biết ai vừa nói gì nếu sender không phải KH
quen. Hôm nay click avatar không có action; sale phải mở Zalo trên điện
thoại để xem thông tin user. Feature này thêm popover khi click avatar
trong group: hiện displayName, phone (nếu là friend), Zalo ID, avatar
fullsize, và link "Tạo contact CRM" nếu chưa có.

Match ZaloCRM-3.0 v3.0: "Click vào avatar trong nhóm xem thông tin user".

## 2. User Stories

- **US-0030-1:** Là Sale, tôi click vào avatar 1 member trong group chat
  → popover hiện ngay tên, avatar lớn, Zalo ID, optional phone.
- **US-0030-2:** Là Sale, nếu user trong popover chưa có Contact trong CRM,
  tôi thấy nút "Tạo Contact" — click → tạo Contact mới với prefilled
  fullName + zaloUid.
- **US-0030-3:** Là Sale, nếu user đã có Contact, popover hiện link sang
  Contact detail page.

## 3. Business Rules

### Trigger

- **BR-0001:** Click avatar của 1 message TRONG group conversation →
  open popover anchored at avatar position.
- **BR-0002:** Click outside / press Esc → close.
- **BR-0003:** Self (current rep) avatar → KHÔNG mở popover (nothing useful
  to show về chính mình).
- **BR-0004:** Click avatar trong user-to-user conversation (không phải
  group) → popover vẫn mở nhưng UX tương tự (đa số case sender = contact
  có sẵn). Nice-to-have phase 1: chỉ mở trong group; phase 2 mở rộng cho
  user chat.

### Data source

- **BR-0005:** Backend endpoint `GET /api/v1/zalo/users/:uid?accountId=...`
  trả user info lấy từ zca-js `api.getUserInfo(uid)`:
  - displayName, avatarUrl, gender (nếu có), phone (chỉ available nếu
    user là friend của rep's account).
  - Map field này từ zca-js response shape (verify tại impl time).
- **BR-0006:** Cache 10 phút per `(accountId, uid)` để tránh hit Zalo
  every click. In-memory Map TTL.
- **BR-0007:** Cross-reference với Contact table: query
  `Contact.findFirst({ where: { zaloUid: uid, orgId } })`. Trả 
  `contactId: string | null` để FE biết link sang Contact detail hay show
  "Tạo Contact" button.

### Permissions

- **BR-0008:** `requireZaloAccess('chat')` trên `accountId` của
  conversation. Reason: user info là Zalo data — cùng quyền truy cập
  như chat messages.

### Tạo Contact flow

- **BR-0009:** Click "Tạo Contact" trong popover (chỉ hiện khi
  `contactId === null`):
  - Modal/form mở với prefilled: `fullName = displayName`,
    `zaloUid = uid`, `avatarUrl = avatarUrl`, `phone = phone || null`.
  - User submit → POST `/api/v1/contacts` standard flow (existing endpoint).
  - Sau success: popover đóng, optional toast "Đã tạo Contact".

## 4. Input / Output

### Schema

KHÔNG thêm field DB. Read-only feature.

### Endpoint

#### `GET /api/v1/zalo/users/:uid?accountId={accountId}`

- **Auth:** `requireZaloAccess('chat')` on accountId.
- **Errors:**
  - 400 `missing_account_id` — query param thiếu.
  - 403 — no ACL.
  - 404 — accountId không thuộc org.
- **Behavior:**
  - Lookup zaloPool for `accountId`. Nếu offline → 200 với `online: false`
    + cached data nếu có hoặc minimal stub.
  - Gọi `api.getUserInfo(uid)`. Parse fields.
  - Lookup Contact by zaloUid trong cùng org. Set `contactId`.
  - Cache.
- **Response 200:**
  ```json
  {
    "uid": "2347234782",
    "displayName": "Lan Anh",
    "avatarUrl": "https://...",
    "gender": "female",
    "phone": "0901234567",
    "contactId": "uuid-or-null"
  }
  ```

### Frontend

#### Component `UserInfoPopover.vue`

- Props: `{ uid: string, accountId: string, anchorEl: HTMLElement }`.
- Lifecycle: on mount, fetch endpoint. Show skeleton during load.
- Render: avatar (medium-large), name, optional phone, "Tạo Contact" or
  "Xem trong CRM" button.
- "Tạo Contact" click → emit event `create-contact-from-zalo` to parent
  with prefilled data. Parent opens existing CreateContactDialog.
- "Xem trong CRM" click → router push to Contact detail page.

#### Integration in `MessageThread.vue`

- Avatar `<img>` of each message gets `@click.stop="onAvatarClick(msg)"`.
- `onAvatarClick(msg)`:
  - Skip if `msg.isSelf`.
  - Open popover anchored at clicked avatar.
  - Pass `uid = msg.senderUid`, `accountId = conversation.accountId`.

## 5. Edge Cases

- **EC-0001:** zca-js `getUserInfo` fail (user privacy settings hidden) →
  response trả minimum data (uid, displayName='Unknown', avatarUrl=null).
  KHÔNG 500.
- **EC-0002:** Self avatar (own message) → click no-op (BR-0003).
- **EC-0003:** Account offline → 200 với data từ cache nếu có, hoặc stub.
- **EC-0004:** Same uid clicked 2 lần trong 10 phút → cache hit.
- **EC-0005:** uid có ký tự non-digit (corruption) → 400 `invalid_uid`.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `GET /zalo/users/:uid?accountId=X` với valid params →
      200 với expected shape (mocked api.getUserInfo).
- [ ] **AC-0002:** Same uid query within 10 min → cache hit (spy on
      api.getUserInfo).
- [ ] **AC-0003:** Member không ACL chat → 403.
- [ ] **AC-0004:** Cross-org accountId → 404.
- [ ] **AC-0005:** Response includes `contactId: <uuid>` khi Contact tồn
      tại với zaloUid trùng.
- [ ] **AC-0006:** Response includes `contactId: null` khi chưa có Contact.
- [ ] **AC-0007:** zca-js fail → response degraded (displayName='Unknown')
      với HTTP 200.
- [ ] **AC-0008:** FE: click avatar trong group → popover open với data.
- [ ] **AC-0009:** FE: click self avatar → KHÔNG open.
- [ ] **AC-0010:** FE: click "Tạo Contact" trong popover → CreateContact
      dialog mở với prefill.
- [ ] **AC-0011:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Contact` table — đọc only (lookup by zaloUid).
- `backend/src/modules/zalo/zalo-routes.ts` (hoặc tạo mới
  `zalo-user-routes.ts`) — thêm GET endpoint.
- `backend/src/modules/zalo/zalo-message-helpers.ts` — đã có `resolveZaloName`
  dùng `api.getUserInfo`. Có thể refactor share cache, hoặc song song với
  cache mới phục vụ endpoint này.
- `frontend/src/components/chat/MessageThread.vue` — avatar click handler.
- `frontend/src/components/chat/UserInfoPopover.vue` — new.
- Existing `CreateContactDialog.vue` (or equivalent) — accept prefill prop.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Backend endpoint + cache + contactId lookup | ~80 |
| FE UserInfoPopover component | ~120 |
| MessageThread integration | ~30 |
| CreateContactDialog prefill prop | ~15 |
| Backend tests | ~80 |
| FE component test (basic) | ~30 |
| **Tổng** | **~355 LOC** |

### Risk: LOW

Read-only endpoint with mock-friendly zca-js dep. UI is straightforward.

### Test strategy

- Integration: mocked `api.getUserInfo`, assert response shape, cache,
  permission, contactId lookup.
- FE: click handler triggers fetch, popover renders, prefill propagation.

### Deviations from ZaloCRM-3.0

None significant. 3.0 release note short. We add `contactId` cross-link
nice-to-have.

### Out of scope (Phase 2)

- "Send direct message" button trong popover (start a new conversation).
- Member list view trong group (related but separate — partially feature
  0026).
- Block/report user (Zalo-level action).
