# ZaloCRM — Quản lý nhiều tài khoản Zalo cá nhân

Hệ thống CRM tự host giúp đội Sale quản lý tập trung **nhiều tài khoản Zalo cá nhân** trên một giao diện web duy nhất. Tích hợp chat real-time, quản lý khách hàng theo pipeline, lịch hẹn, đơn hàng, dashboard doanh thu, API & Webhook cho tích hợp bên ngoài.

## Tính năng

- **Đa tài khoản Zalo** — Đăng nhập bằng QR, lưu phiên, tự kết nối lại khi server khởi động lại
- **Chat real-time** — Gửi/nhận tin nhắn, gửi ảnh & file (max 20MB), sticker, nhóm chat (Socket.IO)
- **Đồng bộ lịch sử nhóm** — Một lần bấm, tải tối đa 200 tin/nhóm cho mỗi tài khoản Zalo. Tin nhắn đến trong lúc server downtime cũng được tự bù
- **Bắt đầu chat mới từ web** — Dialog "Chat mới với khách hàng": chọn Zalo account + contact đã sync → conversation mới xuất hiện ngay
- **Tin nhắn mẫu (Quick replies)** — Lưu template với shortcut. Trong chat gõ `/chao` → popover, chọn → tự thay placeholder `{{contactName}}` / `{{firstName}}`. Scope cá nhân / toàn org
- **Auto-reply ngoài giờ** — Mỗi Zalo account có rule: ngày làm việc, giờ làm, message, cooldown. Tin từ khách ngoài giờ → tự reply 1 lần
- **Tìm kiếm tin nhắn nâng cao** — Trang `/search`: filter theo khoảng ngày, người gửi, loại tin, account; snippet highlight, pagination
- **KPI & Leaderboard** — Trang `/kpi` (admin/owner): 6 KPI cards với % thay đổi vs kỳ trước + bảng xếp hạng sale theo doanh thu / số đơn / tin gửi / KH mới
- **Quản lý khách hàng (CRM)** — Pipeline 5 trạng thái: Mới → Đã liên hệ → Quan tâm → Chuyển đổi → Mất; gắn nguồn, tag, ghi chú
- **Đồng bộ danh bạ Zalo** — Nhập bạn bè Zalo trực tiếp vào danh sách khách hàng
- **Lịch hẹn** — Tạo lịch, nhắc nhở tự động qua cron job hàng ngày
- **Đơn hàng & Doanh thu** — Tạo đơn từ hội thoại chat, theo dõi trạng thái (mới → xác nhận → thanh toán → giao → hoàn tất), dashboard doanh thu, báo cáo theo nhân viên
- **Báo cáo Excel** — Xuất báo cáo theo khoảng thời gian, theo nhân viên, theo tài khoản Zalo
- **Phân quyền nhiều cấp** — Org → Team → User với role Owner / Admin / Member; ACL riêng cho từng tài khoản Zalo (xem / chat / quản lý)
- **API công khai** — REST API với xác thực `X-API-Key`, rate limit, dành cho tích hợp bên ngoài
- **Webhook outbound** — Gửi sự kiện ra hệ thống bên ngoài khi có tin nhắn / khách hàng / kết nối Zalo thay đổi
- **Chống block Zalo** — Giới hạn 200 tin/ngày/tài khoản, phát hiện gửi quá nhanh, health-check tự động
- **Thông báo** — Tin chưa trả lời >30 phút, lịch hẹn sắp tới, Zalo mất kết nối
- **Giao diện** — Vue 3 + Vuetify, theme tối/sáng, đa ngôn ngữ (vue-i18n)

## Yêu cầu hệ thống

| Thành phần | Tối thiểu | Khuyến nghị |
|-----------|----------|------------|
| CPU | 1 vCPU | 2-4 vCPU |
| RAM | 1 GB | 4 GB |
| Ổ cứng | 10 GB | 20 GB SSD |
| Hệ điều hành | Ubuntu 20.04+ | Ubuntu 22.04 LTS |
| Phần mềm | Docker + Docker Compose | Docker 24+ |

## Cài đặt nhanh

> Hướng dẫn chi tiết: [HUONG-DAN-CAI-DAT.md](HUONG-DAN-CAI-DAT.md)

```bash
git clone https://github.com/vuongnguyenbinh/ZaloCRM.git
cd ZaloCRM
cp .env.example .env
# Sửa file .env — đặt mật khẩu và secret keys
docker compose up -d --build
```

Truy cập **http://IP-server:3080** → Tạo tài khoản admin lần đầu.

## Công nghệ sử dụng

| Thành phần | Công nghệ |
|-----------|----------|
| Backend | Node.js 20 · Fastify 5 · Prisma 7 · TypeScript |
| Frontend | Vue 3 · Vuetify 4 · Pinia · Vue Router · Vue I18n · Chart.js · Vite |
| Cơ sở dữ liệu | PostgreSQL 16 |
| Real-time | Socket.IO 4 |
| Tích hợp Zalo | zca-js 2.x |
| Auth | JWT (`@fastify/jwt`) · bcryptjs |
| Tác vụ định kỳ | node-cron (nhắc lịch hẹn, health-check Zalo) |
| Xuất Excel | exceljs |
| Triển khai | Docker Compose (dev + prod) |

## Cấu trúc module backend

`backend/src/modules/` được tổ chức theo domain:

| Module | Vai trò |
|--------|---------|
| `auth` | Đăng nhập, JWT, quản lý User / Team / Organization |
| `zalo` | Kết nối Zalo (zca-js), pool tài khoản, ACL, sync danh bạ + lịch sử nhóm, health-check, offline catch-up |
| `chat` | Hội thoại, tin nhắn, đính kèm (multipart), tạo conversation mới |
| `contacts` | Khách hàng, lịch hẹn + cron nhắc nhở |
| `dashboard` | Thống kê, biểu đồ, xuất Excel |
| `orders` | Đơn hàng, doanh thu, báo cáo theo nhân viên |
| `quick-replies` | Tin nhắn mẫu CRUD với scope org/user + placeholder |
| `auto-reply` | Rule auto-reply/out-of-office per Zalo account + cooldown ledger |
| `search` | Global search + paginated message search với filter |
| `kpi` | KPI summary + leaderboard sale (admin/owner only) |
| `notifications` | Thông báo tin chưa trả lời, lịch hẹn, mất kết nối |
| `api` | REST API công khai (`/api/public/*`) + webhook outbound |

## API & Webhook

> Hướng dẫn chi tiết: [HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md)

### Xác thực API
```
Header: X-API-Key: your-api-key
```

### Endpoint chính

**API công khai (cần `X-API-Key`):**

| Phương thức | Đường dẫn | Mô tả |
|------------|----------|-------|
| GET | `/api/public/contacts` | Danh sách khách hàng |
| POST | `/api/public/contacts` | Tạo khách hàng mới |
| POST | `/api/public/messages/send` | Gửi tin nhắn qua Zalo |
| GET | `/api/public/appointments` | Danh sách lịch hẹn |
| GET | `/api/public/orders` | Danh sách đơn hàng |
| GET | `/health` | Kiểm tra trạng thái server + DB |
| GET | `/api/v1/status` | Banner phiên bản API |

**API nội bộ (cần JWT, dùng từ frontend):**

| Phương thức | Đường dẫn | Mô tả |
|------------|----------|-------|
| POST | `/api/v1/conversations` | Bắt đầu conversation mới với contact đã sync (feature 0002) |
| POST | `/api/v1/conversations/:id/attachments` | Upload + gửi file/ảnh, max 20MB (feature 0003) |
| POST | `/api/v1/zalo-accounts/:id/sync-group-history` | Đồng bộ N tin gần nhất của group chat (feature 0001) |
| GET / POST / PUT / DELETE | `/api/v1/quick-replies` | CRUD tin nhắn mẫu (feature 0004) |
| GET / PUT / DELETE | `/api/v1/zalo-accounts/:id/auto-reply` | Cấu hình rule auto-reply (feature 0005) |
| GET | `/api/v1/search/messages` | Tìm tin nhắn với filter + snippet + pagination (feature 0006) |
| GET | `/api/v1/kpi/summary` | KPI summary với delta vs kỳ trước (feature 0007, admin only) |
| GET | `/api/v1/kpi/leaderboard` | Leaderboard sale theo metric (feature 0007, admin only) |

### Sự kiện Webhook

| Sự kiện | Mô tả |
|---------|-------|
| `message.received` | Tin nhắn mới đến |
| `message.sent` | Tin nhắn gửi đi |
| `contact.created` | Khách hàng mới |
| `zalo.connected` | Zalo kết nối |
| `zalo.disconnected` | Zalo mất kết nối |

## Tài liệu liên quan

- [HUONG-DAN-CAI-DAT.md](HUONG-DAN-CAI-DAT.md) — Hướng dẫn cài đặt chi tiết
- [HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md) — Hướng dẫn sử dụng cho người dùng cuối
- [docs/features/](docs/features/) — SPEC chi tiết của 7 feature (`SPEC.md` mỗi feature)
- [docs/operations/CI-CD.md](docs/operations/CI-CD.md) — Pipeline CI + branch protection
- [docs/operations/RUNBOOK.md](docs/operations/RUNBOOK.md) — Cheat sheet vận hành (deploy, backup, troubleshoot)
- [plans/](plans/) — Tài liệu thiết kế & kế hoạch

## Giấy phép

MIT — Miễn phí sử dụng và chỉnh sửa.
