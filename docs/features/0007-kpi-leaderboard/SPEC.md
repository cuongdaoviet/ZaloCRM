# Feature 0007: KPI dashboard & leaderboard sale

## 1. Mô tả

Hiện tại admin/owner không có cách so sánh hiệu suất giữa nhân viên: ai gửi tin nhiều, ai chốt đơn nhiều, ai phản hồi khách chậm. Feature này thêm:

1. **Endpoint KPI tổng quan** — chỉ số tổng cho org trong 1 khoảng thời gian
2. **Endpoint leaderboard** — bảng xếp hạng nhân viên theo nhiều metric
3. **Trang `/kpi`** — chart + leaderboard table cho admin/owner

> **Data nguồn:** Tính trực tiếp từ `Message` + `Order` + `Contact`. Bảng `DailyMessageStat` trong schema chưa được populate ở đâu (dead) — bỏ qua, không xây aggregator job vì với volume hiện tại (vài chục K message) query realtime đủ nhanh.

## 2. User Stories

- **US-0001:** Là Owner, tôi muốn xem tháng này team gửi bao nhiêu tin, chốt bao nhiêu đơn, tổng doanh thu → 1 màn hình dashboard
- **US-0002:** Là Admin, tôi muốn xem top 5 sale theo doanh thu + theo số tin gửi → biết ai cần khen, ai cần kèm cặp
- **US-0003:** Là Admin, tôi muốn so sánh kỳ này vs kỳ trước (% change) — biết xu hướng
- **US-0004:** Là Sale (member), tôi KHÔNG được thấy leaderboard — riêng tư team

## 3. Business Rules

- **BR-0001:** Endpoint scope chỉ cho `owner` + `admin`. Member gọi → 403.
- **BR-0002:** Org isolation — chỉ data trong `orgId` của user
- **BR-0003:** Date range:
  - Default `period=last7days` nếu không truyền
  - Hỗ trợ presets: `today`, `yesterday`, `last7days`, `last30days`, `thisMonth`, `lastMonth`, `custom`
  - `custom` cần `from` + `to` ISO date; `from <= to`; range max 365 ngày
- **BR-0004:** "Doanh thu" tính từ `Order.totalAmount` với `status IN ('paid', 'shipped', 'completed')` (đơn confirmed nhưng chưa thanh toán không tính)
- **BR-0005:** "Tin gửi" = `Message` `senderType='self'` AND `repliedByUserId IS NOT NULL` (loại tin auto-reply không có user)
- **BR-0006:** "Khách mới" = `Contact.createdAt` trong range
- **BR-0007:** "Chuyển đổi" = `Contact.status='converted'` được set trong range — tracked bằng `updatedAt` (proxy chấp nhận được, không hoàn hảo)
- **BR-0008:** Compare-to-previous-period: lấy đúng cùng số ngày phía trước (vd: last7days kỳ trước = 7 ngày trước nữa)

## 4. API contract

### GET /api/v1/kpi/summary

**Query params:**
| Param | Type | Default |
|-------|------|---------|
| `period` | preset string | `last7days` |
| `from` | ISO date | required when `period=custom` |
| `to` | ISO date | required when `period=custom` |

**Response 200:**
```json
{
  "range": { "from": "ISO", "to": "ISO", "label": "7 ngày qua" },
  "previousRange": { "from": "ISO", "to": "ISO" },
  "summary": {
    "messagesSent": { "current": 1234, "previous": 1100, "delta": 12.2 },
    "messagesReceived": { "current": 567, "previous": 540, "delta": 5.0 },
    "newContacts": { "current": 45, "previous": 38, "delta": 18.4 },
    "convertedContacts": { "current": 12, "previous": 15, "delta": -20.0 },
    "ordersCount": { "current": 8, "previous": 6, "delta": 33.3 },
    "revenue": { "current": 50000000, "previous": 42000000, "delta": 19.0 }
  }
}
```

### GET /api/v1/kpi/leaderboard

**Query params:** same `period`/`from`/`to` plus `metric` (one of `messagesSent`, `revenue`, `ordersCount`, `newContacts`) and optional `limit` (default 10, max 50).

**Response 200:**
```json
{
  "range": { "from": "ISO", "to": "ISO" },
  "metric": "revenue",
  "rows": [
    {
      "userId": "...",
      "fullName": "Hương",
      "email": "huong@...",
      "value": 30000000,
      "rank": 1
    }
  ]
}
```

**Errors:**
- `400` — bad period, custom thiếu from/to, range > 365 ngày, bad metric
- `403` — member

## 5. Helpers (pure)

```ts
// Resolve a preset/custom into concrete {from, to, label, previousRange}
resolveDateRange(input: {period: string; from?: string; to?: string}, now: Date)
  // Returns Result<{from, to, label, previous: {from, to}}, error>

// Percent delta between two numeric values, null if previous is 0
percentDelta(current: number, previous: number): number | null
```

## 6. Frontend (`/kpi`)

- Top: date range selector (dropdown of presets + custom date pickers)
- Hero row: 6 KPI cards (current value + previous + % chip green/red)
- Chart row: 1 line chart "Tin gửi/nhận theo ngày", 1 doughnut "Pipeline contacts"
- Bottom: leaderboard table — metric selector tab bar + top-N table (avatar | name | value | rank)
- Auto-refresh on filter change, manual refresh button

**Permission gate:** Route guarded — nếu `!authStore.isAdmin` redirect về `/`. Menu item ẩn cho member.

## 7. Acceptance Criteria

- [ ] **AC-0001:** GET `/kpi/summary?period=last7days` trả 6 metrics current + previous + delta
- [ ] **AC-0002:** GET `/kpi/leaderboard?metric=revenue` trả top 10 user theo doanh thu (descending)
- [ ] **AC-0003:** Custom range > 365 ngày → 400
- [ ] **AC-0004:** Member gọi cả 2 endpoint → 403
- [ ] **AC-0005:** Cross-org isolation
- [ ] **AC-0006:** "Doanh thu" chỉ count đơn `paid|shipped|completed` (không tính `new`/`confirmed`/`cancelled`)
- [ ] **AC-0007:** Auto-reply messages (senderType=self nhưng repliedByUserId=null) KHÔNG tính vào `messagesSent`
- [ ] **AC-0008:** Trang `/kpi` render đúng số liệu + leaderboard, ẩn khỏi menu của member
- [ ] **AC-0009:** Build BE + FE pass, tests pass

## 8. Edge cases

- **EC-0001:** Range không có data → all values = 0, delta = `null`
- **EC-0002:** Previous = 0, current > 0 → delta = `null` (display "—" hoặc "+∞" tuỳ FE)
- **EC-0003:** User bị xoá khỏi org nhưng vẫn có Order/Message cũ → leaderboard query LEFT JOIN từ User, không hiện user đã xoá. (acceptable mất 1-2 row)
- **EC-0004:** Custom range `from=to` (1 ngày) → vẫn hợp lệ, range = 1 day, previous = day trước đó

## 9. Test plan

### Unit
- `resolveDateRange`: every preset, custom with bad inputs (missing, swapped, > 365), previous range math
- `percentDelta`: 0/0, x/0, 0/y, x/y

### Integration
- Real Postgres + seeded fixtures
- Cover BR-0004 (only confirmed orders), BR-0005 (auto-reply excluded), BR-0007 (member 403), cross-org

## 10. Out of scope

- Per-day time-series (chỉ tổng trong range; chart line là nâng cấp sau)
- Team-level grouping (chỉ user-level)
- Export Excel (đã có ở /reports, không trùng)
- Real-time push của KPI (refresh manual)
- Aggregator job populate `DailyMessageStat` — chấp nhận overhead query realtime
