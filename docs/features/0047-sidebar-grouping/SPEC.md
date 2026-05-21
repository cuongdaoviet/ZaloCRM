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
- **BR-0002 — Collapsible accordion, single-expand.** Dùng `v-list-group`
  với `v-model:opened` cap ở 1 phần tử. Click vào header thứ hai sẽ
  đóng header đang mở (accordion behavior).
- **BR-0003 — Auto-open nhóm chứa route active.** Khi user navigate vào
  `/chat`, nhóm `Trò chuyện` tự mở. Watch `route.path` và update
  `openedGroups` immediate trên mount + mỗi navigation.
- **BR-0004 — Auto-open KHÔNG kèm auto-close.** Nếu user mở thủ công một
  nhóm khác (ví dụ đang ở `/chat` nhưng mở `Hệ thống` để xem các mục),
  giữ nguyên cho đến khi user navigate vào nhóm khác.
- **BR-0005 — Ungrouped row (Dashboard) render flat.** `label: null` =
  bypass `v-list-group`, render trực tiếp `v-list-item`.
- **BR-0006 — Drop empty groups.** Nếu sau khi lọc `adminOnly` một nhóm
  còn 0 mục, drop cả header để tránh orphan.
- **BR-0007 — Giữ nguyên tất cả paths.** Feature này KHÔNG thêm / bớt /
  đổi route. Pure UI restructure.
- **BR-0008 — Giữ nguyên admin gating.** `adminOnly` field tiếp tục
  filter ở client; backend role check không đổi.
- **BR-0009 — Prefix-match cho child routes.** `groupIdForPath` duyệt
  qua các nhóm theo thứ tự declaration và match item nào có path ===
  current path HOẶC current path bắt đầu bằng `item.path + '/'`. Nhờ
  vậy `/contacts/:id` vẫn auto-open nhóm Khách hàng. Đặc biệt:
  `/settings/workflows` được khai báo trong nhóm Marketing TRƯỚC khi
  `/settings` xuất hiện ở nhóm Hệ thống, nên các route con của settings
  (workflows / ai-config / integrations / tags / lead-score) auto-open
  đúng nhóm chứa chúng — không bị nhầm về Hệ thống.

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
- [ ] AC-0003: Mỗi nhóm là collapsible (click vào header → mở/đóng).
      Tại bất kỳ thời điểm, tối đa 1 nhóm đang mở.
- [ ] AC-0004: Khi user navigate vào một route, nhóm chứa route đó
      tự mở. Ví dụ: `/chat` → mở nhóm Trò chuyện. `/settings/workflows`
      → mở nhóm Marketing (không phải Hệ thống).
- [ ] AC-0005: Click vào header thứ hai sẽ đóng header đang mở
      (accordion behavior, không phải multi-select).
- [ ] AC-0006: Dashboard (ungrouped) luôn hiển thị flat ở trên cùng,
      không nằm trong nhóm nào.
- [ ] AC-0007: Non-admin user không thấy header của nhóm nếu toàn bộ
      items trong nhóm đó là `adminOnly`.
- [ ] AC-0008: Build frontend (`npm run build`) pass clean —
      không có template/type error.
- [ ] AC-0009: Tin nhắn mẫu (path `/quick-replies`) nằm trong nhóm
      Trò chuyện (đã sửa từ cuối list lên đúng nhóm — đây chính là
      pain-point gốc của user).
- [ ] AC-0010: Child routes của các item trong menu (ví dụ
      `/contacts/:id`) auto-open đúng nhóm cha (Khách hàng).

## 7. Dependencies

Không có. Đây là client-side restructure trong 1 file
(`frontend/src/layouts/DefaultLayout.vue`). Không có schema change,
không có API change, không có migration.
