# Feature 0047: Sidebar grouped by functional domain

## 1. Mô tả

Sidebar trái hiện là một danh sách phẳng 24 mục không phân nhóm, khiến
người dùng phải scan toàn bộ mỗi lần. Feature này chia menu thành 6 nhóm
chức năng (Dashboard, Trò chuyện, Khách hàng, Marketing & Automation,
Báo cáo, Hệ thống) với section header non-collapsible để giảm tải nhận
thức mà không ép thêm click.

## 2. User Stories liên quan

- US-0047: Là một nhân viên CRM, tôi muốn các mục menu được nhóm theo
  chức năng (chat / khách hàng / marketing / báo cáo / hệ thống) để tìm
  đúng trang nhanh hơn mà không phải đọc qua 24 dòng.

## 3. Business Rules

- **BR-0001 — Thứ tự nhóm theo tần suất sử dụng.** Trò chuyện (most-used)
  ngay sau Dashboard. Hệ thống / Settings xuống cuối cùng.
- **BR-0002 — Non-collapsible headers.** Dùng `v-list-subheader`, không
  dùng `v-list-group`. Lý do: tất cả điểm đến luôn 1 click; collapsible
  nhóm sẽ ẩn affordance.
- **BR-0003 — Ẩn header trong rail mode.** Khi sidebar collapsed
  (`rail = true`), chỉ hiển thị icon — subheader không hiện vì sẽ vỡ
  layout 56px.
- **BR-0004 — Drop empty groups.** Nếu sau khi lọc `adminOnly` một nhóm
  còn 0 mục (ví dụ một staff role có 0 quyền vào nhóm Marketing), drop
  cả header để tránh orphan subheader.
- **BR-0005 — Giữ nguyên tất cả paths.** Không feature này KHÔNG thêm /
  bớt / đổi route. Pure UI restructure.
- **BR-0006 — Giữ nguyên admin gating.** `adminOnly` field tiếp tục
  filter ở client; backend role check không đổi.

## 4. Input / Output

- **Input:** Danh sách menu items (24 mục, mỗi mục có `title`, `icon`,
  `path`, `adminOnly?`).
- **Output:** Sidebar nhóm thành 6 sections, mỗi section có subheader
  text quiet (uppercase, low-contrast) — trừ Dashboard solo group
  không có header.

## 5. Edge Cases

- **Non-admin user:** Một số mục trong nhóm Marketing & Automation và
  Reports là `adminOnly`. Filter chạy per-item, sau đó drop empty group.
- **Rail mode:** Header ẩn (template `v-if="!rail"`).
- **Active route highlight:** `v-list-item :to` Vuetify tự xử lý
  `active` state — không cần thay đổi.
- **Theme switch (light/dark):** Subheader dùng `opacity: 0.55` nên tự
  điều chỉnh theo theme.

## 6. Acceptance Criteria

- [ ] AC-0001: Sidebar hiển thị 6 nhóm theo đúng thứ tự: (Dashboard) →
      Trò chuyện → Khách hàng → Marketing & Automation → Báo cáo →
      Hệ thống.
- [ ] AC-0002: Tất cả 24 paths gốc còn nguyên — không có 404 mới.
- [ ] AC-0003: Non-admin user không thấy header của nhóm nếu toàn bộ
      items trong nhóm đó là `adminOnly` (currently không xảy ra với
      grouping hiện tại, nhưng logic phải đúng).
- [ ] AC-0004: Rail mode (sidebar collapsed) hiển thị icon-only,
      không có subheader text.
- [ ] AC-0005: Subheaders đọc quiet, không tranh attention với
      list-items (font-size 11px, opacity 0.55, uppercase, letter-
      spacing tăng).
- [ ] AC-0006: Build frontend (`npm run build`) pass clean —
      không có template/type error.
- [ ] AC-0007: Tin nhắn mẫu (path `/quick-replies`) nằm trong nhóm
      Trò chuyện (đã sửa từ cuối list lên đúng nhóm — đây chính là
      pain-point gốc của user).

## 7. Dependencies

Không có. Đây là client-side restructure trong 1 file
(`frontend/src/layouts/DefaultLayout.vue`). Không có schema change,
không có API change, không có migration.
