# Feature 0017: Vietnamese appointment fallback parser

## 1. Mô tả
Khi khách gửi tin nhắn dạng "9h sáng mai gặp em nhé" hoặc "ngày 20/5 lúc 14h",
nhân viên phải tự đọc rồi nhập tay vào form lịch hẹn — chậm và dễ sót. Tính
năng này thêm parser thuần regex (không gọi AI, không dùng dependency ngoài)
chạy trên backend, kèm một chip gợi ý ở khung chat. Khi parser phát hiện
intent, chip hiện thị "Gợi ý lịch hẹn: HH:MM, DD/MM" và nút "Tạo" pre-fill form
tạo lịch hẹn của contact đang mở.

Parser là pure compute — không ghi DB, không lookup FK — nên không gây áp lực
lên transaction pool.

## 2. User Stories liên quan
- US-0017-1: Là nhân viên sales, khi khách nhắn thời điểm hẹn bằng tiếng Việt,
  tôi muốn hệ thống tự gợi ý ngày/giờ ngay phía trên ô nhập tin để tôi không
  phải tự nhập tay.
- US-0017-2: Là nhân viên sales, khi click "Tạo", tôi muốn form tạo lịch hẹn
  được mở sẵn với ngày/giờ đã parse và ghi chú là câu khách đã nói.

## 3. Business Rules
- BR-0001: Parser chỉ chạy trên tin nhắn **incoming** (contact gửi) gần nhất
  có `contentType === 'text'`. Bỏ qua tin gửi đi (self) và tin attachment.
- BR-0002: Parser không truy DB, không gọi AI. Nó là pure function nhận `text`
  + `now`, trả về `ParsedAppointment | null`.
- BR-0003: Trả về `null` khi không có intent — frontend ẩn chip hoàn toàn.
- BR-0004: Khi tin nhắn mới nhất không thay đổi (cùng nội dung), composable
  trả về cache result thay vì gọi lại API.
- BR-0005: Chip có thể đóng (closable). Đóng xong chỉ ẩn cho đến khi parser
  phát hiện một `matchedPhrase` MỚI.
- BR-0006: Endpoint `POST /api/v1/appointments/parse` yêu cầu JWT auth. Text
  rỗng / thiếu → 400. Text > 5000 ký tự → 400 để bảo vệ regex worst-case.
- BR-0007: Click "Tạo" → mở contact panel (nếu chưa mở) và pre-fill form tạo
  lịch hẹn trong `ChatAppointments` (date, time, notes).

## 4. Input / Output

### Function signature (`backend/src/modules/contacts/appointment-parser.ts`)
```ts
export interface ParsedAppointment {
  date: Date;            // combined date + time
  confidence: number;    // 0..1
  matchedPhrase: string; // up to 160 chars, whitespace collapsed
  type?: 'call' | 'message' | 'meeting' | 'follow_up';
}
export function parseAppointmentFromText(
  text: string,
  now?: Date,
): ParsedAppointment | null;
```

### Endpoint `POST /api/v1/appointments/parse`
- **Auth:** JWT (authMiddleware).
- **Body:** `{ text: string }` (string, ≤ 5000 chars).
- **Response 200 (intent found):** the `ParsedAppointment` JSON.
- **Response 200 (no intent):** `{ "result": null }`.
- **Errors:**
  - `400` if `text` is missing, not a string, or > 5000 chars.
  - `401` from auth middleware when token is missing/invalid.

## 5. Supported phrase patterns
Detected by the rule-based parser. The reference test in
`backend/tests/unit/appointment-parser.test.ts` covers the main ones.

### Date / day patterns
| Pattern | Resolves to |
|---|---|
| `hôm nay`, `today` | Today (00:00 local + time if also matched) |
| `mai`, `ngày mai`, `tomorrow` | +1 day |
| `kia`, `ngày kia`, `mốt`, `mot` | +2 days |
| `N ngày nữa` | +N days |
| `tuần sau`, `tuần tới` | +7 days |
| `N tuần nữa\|sau\|tới` | +N × 7 days |
| `thứ 2`..`thứ 7`, `chủ nhật` (also `T2`..`T7`, `CN`, ASCII variants) | Upcoming weekday (same weekday → next week) |
| `<weekday> tuần tới\|sau` | Same weekday in next week |
| `DD/MM`, `DD-MM`, `DD.MM` (with optional year) | Absolute date (rolls to next year if already passed) |
| `ngày DD tháng MM` (optional `năm YYYY`) | Absolute date |

### Time patterns
| Pattern | Example | Resolves to |
|---|---|---|
| `Xh sáng\|trưa\|chiều\|tối\|đêm`, `Xpm`, `Xam` | `2pm`, `3h chiều` | Hour with AM/PM heuristic |
| `lúc HH:MM`, `HH:MM` | `17:30` | Exact time |
| `lúc Xh`, `Xh` | `9h`, `lúc 14h` | Hour (with "chiều/tối" → PM heuristic for X<7) |
| Period-only: `sáng`, `trưa`, `chiều`, `tối` | `chiều mai` | Default hours: 09 / 12 / 14 / 19 |

### Type inference
| Keyword | type |
|---|---|
| `gọi`, `call`, `điện thoại`, `dt`, `alo` | `call` |
| `nhắn`, `tin nhắn`, `sms`, `message`, `chat` | `message` |
| `gặp`, `cafe`, `cà phê`, `đi xem`, `ghé`, `meeting`, `hẹn` | `meeting` |
| (otherwise) | `follow_up` |

### Confidence
Floor `0.35`, ceiling `1.0`. Each matched signal adds 0.15–0.5 depending on
specificity (an exact date contributes more than a default-hour period match).

## 6. Edge Cases
- **Empty / whitespace-only input** → `null`.
- **Plain greeting** like `chào shop nha` → `null` (no date, no time, no
  action verb).
- **Past `DD/MM` without year** → auto-roll to next year so `ngày 1/1` while it
  is already May 2026 resolves to 2027-01-01.
- **"thứ X tuần sau" with a digit weekday** (e.g. `thứ 2 tuần sau`) — the
  regex for "N tuần sau" wins, so the parser treats it as "+2 weeks". This is
  an inherited limitation of the reference rule-based parser. Use the word
  form (`thứ hai`) to bypass — though that also falls into the generic
  "tuần sau" handler. Documented in unit tests.
- **Text > 5000 chars** → backend returns 400 (regex worst-case guard).
- **Non-text messages** (image/file) → composable skips them and walks
  backwards until it finds a text message.
- **Same incoming text appearing twice** → composable returns the cached
  result without a network round trip.

## 7. Acceptance Criteria
- [ ] AC-0001: `parseAppointmentFromText('', now)` → `null`.
- [ ] AC-0002: `parseAppointmentFromText('abc xyz random', now)` → `null`.
- [ ] AC-0003: `parseAppointmentFromText('9h sáng mai gặp em nhé', now)` →
       `date.getHours() === 9` on the day after `now`.
- [ ] AC-0004: `parseAppointmentFromText('hẹn 2pm thứ 5', wedNow)` → next
       Thursday at 14:00.
- [ ] AC-0005: `parseAppointmentFromText('ngày 20/5 lúc 14h', anyNow)` →
       20 May at 14:00 (current year if upcoming, otherwise next year).
- [ ] AC-0006: `POST /api/v1/appointments/parse` returns the parsed object
       for valid Vietnamese appointment text.
- [ ] AC-0007: `POST .../parse` returns `{ result: null }` for non-appointment
       text.
- [ ] AC-0008: `POST .../parse` returns `400` for missing / non-string `text`.
- [ ] AC-0009: `POST .../parse` returns `400` for text > 5000 chars.
- [ ] AC-0010: Unauthenticated request → `401`.
- [ ] AC-0011: MessageThread shows a closable chip above the input when the
       latest incoming text yields an intent.
- [ ] AC-0012: Click "Tạo" opens the contact panel and pre-fills date / time
       / notes in `ChatAppointments`.

## 8. Dependencies
- Existing `appointment-routes.ts` (CRUD endpoints) — used by ChatAppointments
  for the actual create call once the user confirms.
- Existing `ChatAppointments.vue` — extended with an optional `prefill` prop
  (no behavioural change when prop is omitted).
- No schema changes. No new tables. No new env vars.
