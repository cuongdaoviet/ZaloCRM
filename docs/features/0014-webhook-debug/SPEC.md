# Feature 0014: Webhook test/debug panel

## 1. Mô tả
Hiện tại webhook gửi đi là fire-and-forget — không có cách nào biết lần gọi
trước thành công hay thất bại. Tính năng này thêm bảng `WebhookDelivery` để
ghi lại mọi attempt (URL, payload, status code, duration, lỗi) và một panel
debug cho admin xem + replay.

## 2. User Stories liên quan
- US-0014-1: Là admin, tôi muốn xem 50 lần gọi webhook gần nhất với HTTP
  status và response để biết integration partner có nhận được không.
- US-0014-2: Là admin, khi webhook thất bại, tôi muốn replay đúng payload đó
  để partner xử lý lại mà không phải tạo lại event.
- US-0014-3: Là admin, tôi muốn xem chính xác payload + chữ ký HMAC đã gửi
  để debug bên phía partner.

## 3. Business Rules
- BR-0001: Mỗi attempt (kể cả test event, kể cả retry) → 1 row trong
  `webhook_deliveries`.
- BR-0002: Org-scoped: admin chỉ thấy delivery của org mình. Member không
  truy cập được endpoint debug.
- BR-0003: Lưu `responseStatus` (int hoặc null nếu fetch fail trước khi có
  response), `errorMessage`, `durationMs`.
- BR-0004: Body lưu nguyên payload đã gửi (raw JSON string) để replay khớp
  hoàn toàn — kể cả timestamp. Replay = gửi lại y nguyên payload cũ + tạo
  delivery row mới (không sửa row cũ).
- BR-0005: Cleanup: chỉ lưu 1000 delivery gần nhất per org (auto-prune cũ
  hơn) — thực hiện best-effort sau mỗi insert.
- BR-0006: Endpoint không lộ secret. Signature đã được tính và lưu trong row
  như header; được truy xuất qua API debug.

## 4. Input / Output

### GET /api/v1/settings/webhook/deliveries
- **Query:** `status` (success|failed|all, default all), `page`, `limit` (max 200)
- **Permission:** owner/admin only (member → 403)
- **Output 200:**
  ```json
  {
    "deliveries": [
      {
        "id": "...",
        "event": "contact.created",
        "url": "https://...",
        "responseStatus": 200,
        "durationMs": 145,
        "errorMessage": null,
        "createdAt": "..."
      }
    ],
    "total": 42,
    "page": 1,
    "limit": 50,
    "totalPages": 1
  }
  ```

### GET /api/v1/settings/webhook/deliveries/:id
- **Permission:** owner/admin only
- **Output 200:** full row including `payload` (raw JSON string), `signature`
- **Error:** 404 if cross-org

### POST /api/v1/settings/webhook/deliveries/:id/replay
- **Permission:** owner/admin only
- **Output 200:** `{ deliveryId: <new row id>, responseStatus, durationMs }`
- **Error:** 404 if cross-org, 400 if webhook URL not configured

## 5. Edge Cases
- Webhook URL đổi giữa lúc replay → dùng URL hiện tại (intent: redeliver
  to current endpoint).
- Fetch timeout (10s) → `responseStatus=null`, `errorMessage="AbortError…"`.
- Payload rỗng (event không có data) → vẫn lưu row với payload=`{}`.
- Org chưa cấu hình webhook → `emitWebhook` return sớm, không tạo delivery
  row (vì không có gì để gửi).

## 6. Acceptance Criteria
- [ ] AC-0001: emitWebhook tạo `WebhookDelivery` row mỗi lần
- [ ] AC-0002: Status code thật được lưu khi partner trả về
- [ ] AC-0003: Fetch error (timeout, DNS) → row với responseStatus=null +
      errorMessage
- [ ] AC-0004: Member gọi /deliveries → 403
- [ ] AC-0005: Owner gọi → 200 và chỉ thấy org mình
- [ ] AC-0006: Cross-org GET /:id → 404
- [ ] AC-0007: Replay tạo row mới, giữ row cũ
- [ ] AC-0008: Replay khi chưa cấu hình URL → 400
- [ ] AC-0009: Prune giữ ≤ 1000 row per org
- [ ] AC-0010: FE panel hiển thị list, lọc theo status, xem detail, click
      replay với confirm

## 7. Dependencies
- Bảng `app_settings` (đã có) — đọc `webhook_url` + `webhook_secret`
- Module `webhook-service.ts` (đã có) — refactor để persist
