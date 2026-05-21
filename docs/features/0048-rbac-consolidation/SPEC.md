# Feature 0048: RBAC consolidation — close server gaps surfaced by sidebar grouping

## 1. Mô tả

Trong quá trình review feature 0047 (sidebar grouping), audit RBAC phát
hiện 4 chỗ lệch giữa client-side `adminOnly` menu flag và server-side
role enforcement. Hai trong số đó là rò rỉ data thật (revenue per-staff,
org-wide reports). Hai còn lại là UX leak (page render được cho member
mặc dù mọi action đều 403). Feature này đóng các gap đó và thống nhất
RBAC giữa FE + BE.

Roles trong hệ thống (Prisma `User.role`): `owner`, `admin`, `member`.
`isAdmin` = `owner OR admin`. `member` là default.

## 2. User Stories liên quan

- US-0048: Là một owner/admin, tôi muốn member KHÔNG xem được doanh thu
  per-staff hay export báo cáo org-wide, vì những số liệu này là
  management-only.
- US-0049: Là một member, tôi không muốn truy cập trang `/settings/ai-config`
  và chỉ thấy loading skeleton + empty state confusing — tôi muốn router
  redirect tôi về dashboard rõ ràng.

## 3. Business Rules

### Phần A — Đóng server-side gaps (security)

- **BR-0001 — `/api/v1/orders/by-staff` phải role-gate.**
  Hiện tại trả về order count + total revenue của TỪNG nhân viên cho bất
  kỳ user nào đăng nhập. Thêm `{ preHandler: requireRole('owner','admin') }`.
- **BR-0002 — `/api/v1/orders/stats` phải role-gate.**
  Trả về `totalRevenue` + `todayRevenue` org-wide. Cùng treatment với
  BR-0001.
- **BR-0003 — `/api/v1/reports/*` phải role-gate.**
  Bốn endpoint: `/reports/messages`, `/reports/contacts`,
  `/reports/appointments`, `/reports/export`. Tất cả thêm
  `requireRole('owner','admin')`. Sibling features (`/kpi`, `/analytics`)
  đã admin-only — đây là gap inconsistency.

### Phần B — Router role guard (UX)

- **BR-0004 — Thêm `requiresAdmin: true` meta** cho mọi route admin-only
  trong `frontend/src/router/index.ts`. Danh sách:
  `/duplicate-groups`, `/duplicate-groups/:id`, `/campaigns`,
  `/kpi`, `/analytics`, `/activity`, `/settings/tags`,
  `/settings/lead-score`, `/settings/workflows`,
  `/settings/ai-config`, `/settings/integrations`.
- **BR-0005 — `beforeEach` redirect.** Trong `router.beforeEach`, sau
  bước kiểm tra `requiresAuth`, thêm:
  ```ts
  if (to.meta.requiresAdmin && !authStore.isAdmin) return next('/');
  ```

### Phần C — Page-level menu consistency (product call)

- **BR-0006 — Quyết định cho 4 page "menu open, writes admin-only".**
  Pages: Tin nhắn mẫu, Auto-tag keyword, Tài khoản Zalo, Nhân viên.
  Hai lựa chọn:
  - (a) Giữ menu open → member có read-only view. Cần kiểm tra UI hide
    nút action cho member.
  - (b) Mark `adminOnly: true` → member không thấy menu.
  - Cần CEO/product call trước khi implement. Hiện đề xuất (a) cho
    Tin nhắn mẫu (member cần xem template), (b) cho ba page còn lại.

## 4. Input / Output

- **Input:** Không có user input mới. Chỉ thay đổi middleware bindings
  + router meta.
- **Output:** Member khi gọi `/api/v1/orders/by-staff` hay
  `/api/v1/reports/*` sẽ nhận 403. Member khi navigate vào admin route
  sẽ redirect về `/`.

## 5. Edge Cases

- **Member đã có tab admin page mở từ trước (token hợp lệ):** trang
  đó vẫn render UI shell, nhưng mọi data fetch sẽ 403. BR-0005 chỉ
  block navigation MỚI; cần document cho support.
- **Owner downgrade thành admin sau khi PR ship:** không có vấn đề
  (admin vẫn pass `isAdmin`).
- **Promotion từ member → admin trong cùng session:** `authStore.user.role`
  không tự refresh; cần force re-login. Out of scope của feature này
  (đã tồn tại từ trước, sẽ track riêng).
- **Reports export đã chạy sẵn (download in flight):** không bị chặn
  giữa chừng vì middleware chạy preHandler. Members chỉ block từ
  request mới.

## 6. Acceptance Criteria

- [ ] AC-0001: GET `/api/v1/orders/by-staff` với token member trả về
      403 (`Không có quyền truy cập`).
- [ ] AC-0002: GET `/api/v1/orders/stats` với token member trả về 403.
- [ ] AC-0003: GET `/api/v1/reports/messages` với token member trả về
      403. Cùng với contacts, appointments, export.
- [ ] AC-0004: Member navigate `/settings/ai-config` redirect về `/`
      (Dashboard) — không thấy AI config page.
- [ ] AC-0005: Owner/admin navigate tất cả admin routes vẫn vào bình
      thường (không regression).
- [ ] AC-0006: Integration tests trong `backend/tests/integration/`
      cover 403 cases cho mỗi endpoint trên (5 mới + 4 reports = 9 test
      cases mới).
- [ ] AC-0007: Frontend unit test `router.test.ts` cover BR-0005 redirect.
- [ ] AC-0008: Product decision cho BR-0006 được document trong SPEC
      trước khi implement; menu changes commit riêng từ server fixes.

## 7. Dependencies

- Feature 0046 (security hardening) đã ship → role-middleware ổn định.
- Feature 0047 (sidebar grouping) đã ship → menu groups xác định
  cấu trúc final.
- Không có schema change. Không có migration.

## 8. Implementation order

1. **Phần A (server)** — đóng security gap trước. PR riêng để reviewer
   tập trung. ~20 LOC change + 9 integration tests.
2. **Phần B (router)** — UX cleanup. PR riêng. ~15 LOC.
3. **Phần C (product call)** — sau khi có quyết định, PR ngắn update
   menu config.

Mỗi phần là 1 commit + 1 PR. Không gộp vào một PR vì các phần độc lập
và scope rất khác nhau (BE security vs FE routing vs FE config).
