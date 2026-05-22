# Feature 0051: Chat empty-state copy for member with no Zalo access

## 1. Mô tả

Khi một user role=`member` mở màn hình chat nhưng chưa có row nào
trong `zalo_account_access` (admin chưa cấp quyền truy cập tài khoản
Zalo nào), backend filter `zaloAccountId IN (...accessibleIds)` với
mảng rỗng → trả về `conversations: []`. Frontend hiện chỉ render một
dòng "Chưa có cuộc trò chuyện nào" duy nhất, không phân biệt được giữa
"không có data" và "không có quyền".

Hậu quả thực tế: member (vd. sale1) mở app, thấy chat trống trơn,
không biết tại sao, không biết phải làm gì. Owner/admin không gặp
trường hợp này vì họ bypass ACL (xem mọi conversation trong org).

Feature này thêm một signal nhẹ từ backend (`accessibleAccountCount`)
để FE có thể render empty-state đúng ngữ cảnh — phân biệt rõ 3 trường
hợp "không có conversation".

## 2. User Stories liên quan

- US-0052: Là một sale rep (member) chưa được cấp quyền Zalo, khi tôi
  mở màn hình chat, tôi muốn thấy thông báo nói rõ "Bạn chưa được cấp
  quyền, hãy hỏi quản trị viên" — không phải một màn hình trắng vô
  nghĩa.
- US-0053: Là một sale rep đã được cấp quyền nhưng tài khoản đó chưa
  có conversation nào, tôi muốn thấy thông báo "Chưa có hội thoại,
  hội thoại sẽ xuất hiện khi khách nhắn tin" — yên tâm rằng hệ thống
  đang chờ chứ không hỏng.
- US-0054: Là owner/admin, khi tổ chức của tôi chưa có conversation
  nào (vd. mới onboard), tôi muốn thấy đúng thông báo "chưa có hội
  thoại" — không bị nhầm với thông báo "chưa có quyền" dành cho
  member.

## 3. Business Rules

### Backend

- **BR-0001 — Thêm field `accessibleAccountCount` vào response.**
  Endpoint `GET /api/v1/conversations` trả về một field optional
  `accessibleAccountCount: number` ngoài `conversations`, `total`,
  `page`, `limit` hiện tại. Chỉ populate cho `user.role === 'member'`.
- **BR-0002 — Owner/admin không có field này.** Với owner/admin, field
  bị OMITTED khỏi response (không phải `null`, không phải `undefined`
  — không có key). Lý do: họ bypass ACL → "accessible account count"
  không có ý nghĩa với họ (luôn = mọi account của org).
- **BR-0003 — Field này count distinct `zaloAccountId` trong table
  `zalo_account_access` mà user member sở hữu.** Bất kể permission
  level (`read` / `chat` / `admin`) — chỉ cần có row là count.
- **BR-0004 — Không thay đổi shape của `conversations` array.** Field
  mới nằm ở root của response object. Tương thích ngược: client cũ
  ignore field thừa, không vỡ.
- **BR-0005 — Không áp dụng cho `/conversations/counts`.** Counts
  endpoint giữ nguyên shape hiện tại. Empty state là quyết định FE,
  chỉ cần biết info từ list endpoint.

### Frontend

- **BR-0006 — Composable `use-chat` track `accessibleAccountCount`.**
  Thêm ref `accessibleAccountCount: Ref<number | null>`. Cập nhật mỗi
  lần `fetchConversations` chạy: `value = res.data.accessibleAccountCount ?? null`.
  `null` = unknown (owner/admin, hoặc trước khi fetch xong).
- **BR-0007 — `ConversationList.vue` render empty-state với 3 nhánh.**
  Khi `conversations.length === 0 && !loading`:
  - Case 1 — `accessibleAccountCount === 0`: icon `mdi-shield-alert-outline`,
    text "Bạn chưa được cấp quyền truy cập tài khoản Zalo nào",
    subtext "Hãy hỏi quản trị viên để được cấp quyền."
  - Case 2/3 — `accessibleAccountCount === null` (owner/admin) HOẶC
    `accessibleAccountCount > 0` (member có quyền nhưng chưa có chat):
    icon `mdi-chat-outline`, text "Chưa có cuộc trò chuyện nào",
    subtext "Khi khách hàng nhắn tin Zalo, hội thoại sẽ xuất hiện ở đây."
- **BR-0008 — Không có CTA button cho case 1.** Member không thể tự
  fix bằng cách bấm nút — trang `/zalo-accounts` là admin-only (đã
  được role-gate trong Feature 0048). Show CTA chỉ làm rep frustrated.
- **BR-0009 — Empty-state pattern theo Feature 0049 F2.** 40px muted
  icon (`color="grey-lighten-1"`), `text-body-2 text-medium-emphasis`,
  align center, padding 8 (32px).

## 4. Input / Output

### Backend

- **Input:** GET `/api/v1/conversations?...` (params hiện có, không
  thêm gì)
- **Output (member):**
  ```json
  {
    "conversations": [],
    "total": 0,
    "page": 1,
    "limit": 50,
    "accessibleAccountCount": 0
  }
  ```
- **Output (owner/admin):** Giữ nguyên — KHÔNG có
  `accessibleAccountCount` key:
  ```json
  {
    "conversations": [...],
    "total": N,
    "page": 1,
    "limit": 50
  }
  ```

### Frontend

- **Input:** None — driven by `fetchConversations` lifecycle.
- **Output:** Empty-state UI rendered inside `ConversationList`
  khi list rỗng.

## 5. Edge Cases

- **Member với cả `accountId` filter và 0 ACL rows:** vẫn case 1
  (accessibleAccountCount = 0). Account filter không ảnh hưởng count.
- **Member có 1 grant nhưng filter `accountId` khác:** BE đã trả
  `conversations: []`. `accessibleAccountCount = 1` → case 2 ("chưa
  có hội thoại"). Reasonable: member có quyền trên 1 account, đang
  filter sang account khác → kết quả trống là đúng.
- **Owner/admin với 0 conversations toàn org:** `accessibleAccountCount`
  bị omit → FE thấy `null` → case 2 ("chưa có hội thoại"). Đúng.
- **Network error:** FE bắt lỗi trong `fetchConversations` (đã có),
  `conversations` giữ giá trị cũ. `accessibleAccountCount` không thay
  đổi. Không show empty state vì conversations vẫn còn.
- **Conversations.length > 0:** Bypass empty state hoàn toàn —
  `accessibleAccountCount` không ảnh hưởng UI.

## 6. Acceptance Criteria

- [ ] AC-0001: BE — member với 0 ACL rows: response chứa
      `accessibleAccountCount: 0`, `conversations: []`, `total: 0`.
- [ ] AC-0002: BE — member với 1 ACL row (account không có conv):
      `accessibleAccountCount: 1`, `conversations: []`.
- [ ] AC-0003: BE — member với 1 ACL row (account có 1 conv):
      `accessibleAccountCount: 1`, `conversations.length === 1`.
- [ ] AC-0004: BE — owner bypass: response KHÔNG chứa key
      `accessibleAccountCount` (hoặc giá trị undefined sau JSON
      parse).
- [ ] AC-0005: FE — `accessibleAccountCount === 0` trong composable
      → render icon `mdi-shield-alert-outline` + text "chưa được cấp
      quyền".
- [ ] AC-0006: FE — `accessibleAccountCount === null` trong composable
      → render icon `mdi-chat-outline` + text "Chưa có cuộc trò
      chuyện nào".
- [ ] AC-0007: FE — `accessibleAccountCount > 0` trong composable
      → render icon `mdi-chat-outline` (case 2).
- [ ] AC-0008: Backend integration test cover AC-0001..0004.
- [ ] AC-0009: Frontend unit test cho composable update của 3 cases.

## 7. Dependencies

- Prisma model `ZaloAccountAccess` (đã có).
- Feature 0048 — `/zalo-accounts` page đã role-gate admin (vì vậy không
  set CTA dẫn member tới đó).
- Feature 0049 — empty-state pattern (40px icon + body-2 text). Reuse
  cùng style.

## 8. Implementation order

1. Backend: thêm `accessibleAccountCount` vào GET /conversations
   handler. ~10 LOC + integration test (~80 LOC) — chạy
   `npm run test:integration -- tests/integration/chat-empty-state.integration.test.ts`.
2. Frontend composable: ref + cập nhật trong fetchConversations,
   export ra. ~5 LOC + unit test (~60 LOC).
3. Frontend component: empty-state branching trong ConversationList,
   pass prop từ ChatView. ~20 LOC.
4. Build verify: `npm run build` (BE + FE) clean.
5. Manual smoke: tạo member, không cấp quyền, login, mở /chat → thấy
   case 1 copy.
