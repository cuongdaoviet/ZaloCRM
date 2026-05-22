# Feature 0053: Design regrade #2 fixes

## 1. Mô tả

Sửa 4 finding từ design audit regrade #2 (2026-05-22, `.gstack-design-audit-20260522/design-regrade-2.md`):

- **F21** — Tài khoản Zalo: hàng action có 7 nút icon solid bão hòa nhiều màu (cyan/green/orange/purple/indigo/blue/red) → đổi sang ghost (`variant="text"`) theo cùng pattern F12 của Feature 0049.
- **F22** — Header trang Tài khoản Zalo chỉ có title bên trái và nút "+ Thêm Zalo" tận bên phải, ở giữa là không gian trống → thêm filter trạng thái + search box inline để dùng hết thanh.
- **F16** — Pill "ONLINE" (oval xanh đậm, chữ to viết hoa) trên top bar quá nổi, cạnh tranh sự chú ý với tiêu đề trang → giảm xuống còn 1 chấm xanh 8px bên cạnh tên user.
- **F18** — Chuông thông báo hiển thị badge "1" giả (stale) trên org mới hoặc với member không có quyền — vì query gắn `disconnected` notification cho **mọi** tài khoản Zalo có `status !== 'connected'`, bao gồm cả tài khoản chưa từng đăng nhập → chỉ phát thông báo khi `sessionData IS NOT NULL` (= đã từng kết nối thật sự); với member, lọc thêm theo `zalo_account_access` ACL.

## 2. Business Rules

- **BR-0001 (F21)**: Hàng action trong bảng Zalo accounts dùng `variant="text"` cho mọi nút. Chỉ giữ `color="error"` cho nút Xóa và `color="primary"` cho nút "Đăng nhập QR" (CTA chính khi chưa connect). Icon size `20`.
- **BR-0002 (F22)**: Header trang đặt theo thứ tự: title → status filter (200px) → search (280px) → spacer → nút "+ Thêm Zalo". Search lọc client-side theo `displayName | zaloUid | phone`. Status filter so khớp `liveStatus || status`.
- **BR-0003 (F16)**: Top bar không còn pill ONLINE. Thay bằng `<span class="status-dot bg-success">` (8×8 round) đặt trước tên user, có `title="Đang online"` cho tooltip + a11y.
- **BR-0004 (F18)**: Notification `disconnected` chỉ phát ra cho ZaloAccount thỏa MỌI điều kiện:
  - `orgId = user.orgId`
  - `sessionData IS NOT NULL` (đã login ít nhất 1 lần)
  - Nếu `user.role === 'member'`: account.id ∈ accessible (qua bảng `zalo_account_access`)
  - `zaloPool.getStatus(id) !== 'connected'`

## 3. Acceptance Criteria

- [ ] **AC-0001 (F21)**: Trên trang `/zalo-accounts`, mỗi hàng action chỉ còn icon trong suốt; di chuột không thấy nền màu solid, chỉ thấy ripple/hover; nút Xóa giữ tone error.
- [ ] **AC-0002 (F22)**: Header trang có 4 thành phần đầy đủ (title, filter, search, CTA). Search "abc" lọc đúng theo displayName/uid/phone. Filter "Đang kết nối" chỉ hiển thị account `liveStatus = connected`.
- [ ] **AC-0003 (F16)**: Top bar chỉ còn dot 8×8 xanh + tên user; không có chữ "ONLINE" nào.
- [ ] **AC-0004 (F18)**: Trên org chưa từng login Zalo (sessionData null), bell không có badge. Khi 1 account đã từng login bị rớt, badge hiện đúng "1". Sale1 (member) chỉ thấy alert của Zalo account mình được grant; không thấy alert của account khác.

## 4. Dependencies

- Feature 0049 F12 — ghost icon pattern (đã merge ở `b39d0a8`).
- Bảng `zalo_account_access` (Feature 0048 RBAC) — đã có.
- `Prisma.JsonNull` filter (đã dùng ở `app.ts`, `zalo-health-check.ts`).

## 5. Files thay đổi

- `frontend/src/views/ZaloAccountsView.vue` (F21 + F22)
- `frontend/src/layouts/DefaultLayout.vue` (F16)
- `backend/src/modules/notifications/notification-routes.ts` (F18)
