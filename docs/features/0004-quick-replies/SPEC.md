# Feature 0004: Tin nhắn mẫu (Quick Replies)

## 1. Mô tả

Sale thường gửi đi gửi lại các tin chuẩn (chào, giới thiệu, gửi tài liệu, hỏi địa chỉ giao hàng…). Hiện phải gõ tay mỗi lần — chậm và dễ sai chính tả.

Feature này thêm:
1. **Quản lý tin mẫu** — CRUD danh sách mẫu theo org, mỗi mẫu có shortcut + content.
2. **Sử dụng trong chat** — gõ `/` ở ô nhập → popup list mẫu (filter theo shortcut) → chọn → fill vào textarea.
3. **Trang quản lý** — view/add/edit/delete trong Settings.

## 2. User Stories

- **US-0001:** Là Sale, tôi muốn lưu các tin nhắn hay dùng (vd: lời chào, gửi giá) để không phải gõ lại.
- **US-0002:** Là Sale, tôi muốn gõ `/chao` trong chat → tự hiện và chọn mẫu chào.
- **US-0003:** Là Admin, tôi muốn tạo template chung cho team để tin nhắn nhất quán.
- **US-0004:** Là Sale, tôi muốn template có placeholder `{{tên}}` được thay bằng tên khách hàng khi chèn.

## 3. Business Rules

- **BR-0001:** Quick reply scoped theo `orgId`. Owner/admin tạo template thấy được cho toàn org. Member tạo template **chỉ riêng mình** (`createdByUserId`).
- **BR-0002:** `shortcut` unique trong scope visible: cùng user thấy không thể có 2 template trùng shortcut. Admin tạo `chao` + member tạo `chao` riêng → ok (khác scope).
- **BR-0003:** `shortcut` chỉ chứa `a-z0-9_-`, 2-20 ký tự. Tự lowercase khi save.
- **BR-0004:** `content` 1-2000 ký tự.
- **BR-0005:** Placeholder hỗ trợ: `{{contactName}}`, `{{firstName}}` (split theo space đầu). FE substitute trước khi gửi.
- **BR-0006:** Khi delete template, không cascade — chỉ xoá row.
- **BR-0007:** Member chỉ sửa/xoá template của chính mình. Admin/owner sửa/xoá tất cả trong org.

## 4. API contract

### GET /api/v1/quick-replies
Liệt kê template visible cho user (org-shared + của riêng user).

**Response 200:**
```json
{
  "replies": [
    {
      "id": "...",
      "shortcut": "chao",
      "content": "Chào {{contactName}}, em là ...",
      "scope": "org" | "user",
      "createdByUserId": "...",
      "createdByName": "Hương",
      "createdAt": "ISO8601",
      "updatedAt": "ISO8601"
    }
  ]
}
```

### POST /api/v1/quick-replies
Tạo mới.

**Body:**
```json
{ "shortcut": "chao", "content": "...", "scope": "org" | "user" }
```
- Admin/owner có thể set `scope: org`. Member: chỉ `scope: user` (force).

**Response 201:** Quick reply object.

### PUT /api/v1/quick-replies/:id
Update. Member chỉ update template của mình.

### DELETE /api/v1/quick-replies/:id
Xoá. Same permission rule như update.

**Errors:**
- `400` — validation fail
- `403` — member sửa/xoá template không phải của mình
- `404` — không tồn tại
- `409` — shortcut conflict trong scope visible

## 5. Schema

```prisma
model QuickReply {
  id              String   @id @default(uuid())
  orgId           String   @map("org_id")
  createdByUserId String   @map("created_by_user_id")
  shortcut        String   // a-z0-9_- only, lowercase
  content         String
  scope           String   @default("user") // "user" or "org"
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  createdBy User         @relation("CreatedQuickReplies", fields: [createdByUserId], references: [id], onDelete: Cascade)

  @@index([orgId, scope])
  @@index([createdByUserId])
  @@map("quick_replies")
}
```

Tham chiếu: cập nhật `Organization` thêm `quickReplies QuickReply[]` và `User` thêm `quickReplies QuickReply[] @relation("CreatedQuickReplies")`.

## 6. Frontend UX

### Trong khung chat (`MessageThread.vue`)
- User gõ `/` ở đầu dòng → popover hiện danh sách template (max 8 hiển thị, scroll nếu nhiều hơn)
- Gõ tiếp `chao` → filter shortcut bắt đầu `chao`
- Arrow up/down để navigate, Enter để chọn
- Esc đóng popover
- Khi chọn: substitute placeholders (`{{contactName}}` → `contact.fullName`, `{{firstName}}` → first word), replace toàn bộ textarea content
- Mouse click cũng chọn được

### Trang quản lý (`/settings/quick-replies` hoặc tab trong Settings)
- Table: Shortcut | Content (truncate) | Scope (chip: "Toàn org" / "Cá nhân") | Người tạo | Actions (Edit / Delete)
- Nút "Tạo tin mẫu" → dialog với form: shortcut, content (textarea preview placeholder), scope (chỉ hiện khi admin/owner)
- Edit dùng cùng dialog

## 7. Acceptance Criteria

- [ ] **AC-0001:** Tạo template `shortcut=chao, content=Chào {{contactName}}` → 201, hiện trong list
- [ ] **AC-0002:** Gõ `/chao` trong chat → popover hiện template, chọn → textarea = "Chào Nguyễn Văn A"
- [ ] **AC-0003:** Tạo trùng shortcut → 409
- [ ] **AC-0004:** Member tạo với `scope=org` → backend tự ép về `user`
- [ ] **AC-0005:** Member sửa template của owner → 403
- [ ] **AC-0006:** Shortcut sai format (vd: `Chào!`) → 400
- [ ] **AC-0007:** Build BE + FE pass, tất cả tests pass
- [ ] **AC-0008:** Trang `/settings/quick-replies` hiển thị + thao tác CRUD đầy đủ

## 8. Edge cases

- **EC-0001:** Conversation không có contact (group chat) → placeholder `{{contactName}}` giữ nguyên hoặc thay bằng "" (decide: dùng tên group).
- **EC-0002:** Slash command với shortcut chưa có → popover hiện "Không tìm thấy tin mẫu", Enter không làm gì.
- **EC-0003:** User gõ `/` giữa câu (vd: `bạn/chị`) → không trigger popover (chỉ trigger khi `/` ở đầu dòng hoặc sau space).
- **EC-0004:** Content có ký tự multi-byte (emoji, dấu) → vẫn hoạt động (TS string là UTF-16).

## 9. Test plan

### Unit (mocked Prisma)
- Validation: shortcut format, content length, scope coercion for member
- Permission: member can't edit other's template
- Placeholder substitution helper

### Integration (real Postgres)
- Full CRUD lifecycle
- Org-shared vs user-scoped visibility
- 409 on duplicate shortcut
- Cross-org isolation

### Manual UI
- Slash command flow
- Settings page CRUD
- Placeholder substitution với contact có/không có fullName

## 10. Out of scope

- Categories/folders cho template (sau)
- Rich text formatting (markdown, bold) — chỉ plain text
- Sync template từ Zalo Quick Reply API (zca-js có `getQuickMessageList` nhưng chưa cần)
- Stats/analytics: template nào dùng nhiều nhất
