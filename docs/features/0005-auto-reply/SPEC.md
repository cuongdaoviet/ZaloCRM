# Feature 0005: Auto-reply / Out-of-office

## 1. Mô tả

Ngoài giờ làm việc hoặc lúc sale offline, khách nhắn đến không có ai trả lời → khách sốt ruột, conversion giảm. Feature này cho phép từng tài khoản Zalo tự gửi 1 tin trả lời tự động khi nhận tin mới ngoài "active window" do sale cấu hình.

## 2. User Stories

- **US-0001:** Là Sale, sau khi cấu hình giờ làm việc (T2-T6, 8h-18h, timezone VN), tin nhắn đến lúc 22h hôm thứ ba được tự reply 1 tin định sẵn (vd: "Em đã nhận tin, sẽ phản hồi vào giờ làm việc sáng mai").
- **US-0002:** Là Sale, tôi muốn auto-reply **chỉ gửi 1 lần / contact / window** (không spam khách 10 tin trong 1 đêm).
- **US-0003:** Là Admin, tôi muốn override quy tắc auto-reply cho từng Zalo account (vd: sale Hương giờ trưa nghỉ 12-13h vẫn auto-reply, sale Lan không cần).
- **US-0004:** Là Sale, tôi muốn bật/tắt auto-reply trên-the-fly khi đang ngồi ở cửa hàng (vd: ngày Chủ Nhật vào làm bất chợt, không muốn auto-reply nữa).

## 3. Business Rules

- **BR-0001:** Mỗi `ZaloAccount` có **tối đa 1 `AutoReplyRule`** (1-1). Có thể disable mà không xóa.
- **BR-0002:** Active window mô tả bằng:
  - `daysOfWeek`: bitmask 7 bit (CN=0, T2=1, ..., T7=6). Trong window = "đang làm việc, KHÔNG auto-reply".
  - `startMinute`, `endMinute`: phút trong ngày (0-1439). Auto-reply trigger khi tin nhắn đến **ngoài** [start, end) hoặc ngoài `daysOfWeek` đã chọn.
  - `timezone`: IANA string, default `Asia/Ho_Chi_Minh`.
- **BR-0003:** Cooldown — sau khi auto-reply 1 contact, **không** auto-reply lại contact đó trong `cooldownMinutes` (default 240 = 4 giờ). Tránh spam.
- **BR-0004:** Auto-reply **chỉ áp dụng cho 1-1 chat** (`threadType=user`), KHÔNG áp dụng cho group chat.
- **BR-0005:** Auto-reply **chỉ trigger cho tin từ contact** (`isSelf=false`), không trigger cho tin self gửi từ điện thoại.
- **BR-0006:** Khi gửi auto-reply, vẫn dùng `zaloRateLimiter` — nếu hit limit thì skip (log warn, không retry).
- **BR-0007:** Khi tin từ contact đến và **CÓ** sale đang reply trong 5 phút gần đây (track bằng `Message.repliedByUserId`), skip auto-reply (sale đang active).
- **BR-0008:** Placeholder `{{contactName}}` được substitute trước khi gửi (reuse logic feature 0004).

## 4. Schema

```prisma
model AutoReplyRule {
  id              String   @id @default(uuid())
  zaloAccountId   String   @unique @map("zalo_account_id")
  enabled         Boolean  @default(true)
  // Active window — outside this window, auto-reply fires
  daysOfWeek      Int      @default(62) @map("days_of_week") // bitmask: bit 1-5 = Mon-Fri = 0b0111110 = 62
  startMinute     Int      @default(480) @map("start_minute") // 08:00
  endMinute       Int      @default(1080) @map("end_minute")  // 18:00
  timezone        String   @default("Asia/Ho_Chi_Minh")
  // Reply config
  message         String   // The actual reply text, placeholders allowed
  cooldownMinutes Int      @default(240) @map("cooldown_minutes")
  // Tracking
  lastTriggeredAt DateTime? @map("last_triggered_at")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  zaloAccount ZaloAccount        @relation(fields: [zaloAccountId], references: [id], onDelete: Cascade)
  history     AutoReplyHistory[]

  @@map("auto_reply_rules")
}

// Cooldown tracking — one row per (rule, contact) the last time we auto-replied
model AutoReplyHistory {
  id         String   @id @default(uuid())
  ruleId     String   @map("rule_id")
  contactUid String   @map("contact_uid") // zaloUid of the contact who received the auto-reply
  sentAt     DateTime @default(now()) @map("sent_at")

  rule AutoReplyRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)

  @@unique([ruleId, contactUid])
  @@index([sentAt])
  @@map("auto_reply_history")
}
```

Sửa `ZaloAccount` thêm `autoReplyRule AutoReplyRule?`.

## 5. API contract

### GET /api/v1/zalo-accounts/:id/auto-reply
Trả về rule (hoặc 404 nếu chưa có).

### PUT /api/v1/zalo-accounts/:id/auto-reply
Upsert. Body:
```json
{
  "enabled": true,
  "daysOfWeek": 62,
  "startMinute": 480,
  "endMinute": 1080,
  "timezone": "Asia/Ho_Chi_Minh",
  "message": "Em đã nhận tin, sẽ phản hồi sớm vào giờ làm việc.",
  "cooldownMinutes": 240
}
```

### DELETE /api/v1/zalo-accounts/:id/auto-reply
Xoá rule (= disable hoàn toàn, không chỉ off).

**Permission:** `requireZaloAccess('admin')` — chỉ owner Zalo account hoặc admin/owner CRM mới sửa được rule.

**Validation:**
- `daysOfWeek`: 0-127 (7 bit)
- `startMinute`, `endMinute`: 0-1440, `start < end`
- `timezone`: phải parse được bằng `Intl.DateTimeFormat`
- `message`: 1-1000 chars
- `cooldownMinutes`: 1-10080 (1 phút - 7 ngày)

## 6. Matcher logic

```ts
function shouldAutoReply(rule, now, message): boolean {
  if (!rule.enabled) return false;
  if (message.threadType !== 'user') return false;
  if (message.isSelf) return false;

  // Time check
  const localNow = toTimezone(now, rule.timezone);
  const day = localNow.getDay(); // 0=Sun, 1=Mon, ...
  const minuteOfDay = localNow.getHours() * 60 + localNow.getMinutes();
  const isWorkDay = (rule.daysOfWeek & (1 << day)) !== 0;
  const isWorkHour = minuteOfDay >= rule.startMinute && minuteOfDay < rule.endMinute;
  if (isWorkDay && isWorkHour) return false; // in active window → skip

  // Cooldown check
  const existing = await findHistory(rule.id, message.senderUid);
  if (existing && minutesSince(existing.sentAt) < rule.cooldownMinutes) return false;

  // Recent staff activity check (BR-0007)
  const recentReply = await findRecentSelfMessage(conversation.id, 5);
  if (recentReply) return false;

  return true;
}
```

## 7. Wire vào listener

Trong `zalo-listener-factory.ts`, sau khi `processZaloMessage` thành công với `threadType=user, isSelf=false`, gọi `maybeAutoReply(...)`. Fire-and-forget, không block listener.

## 8. Acceptance Criteria

- [ ] **AC-0001:** Tin từ contact đến lúc 22h thứ ba → auto-reply gửi, history record được tạo
- [ ] **AC-0002:** Tin 2 từ cùng contact 5 phút sau → KHÔNG auto-reply (cooldown)
- [ ] **AC-0003:** Tin từ contact lúc 10h thứ tư (work hours) → KHÔNG auto-reply
- [ ] **AC-0004:** Tin group chat → KHÔNG auto-reply
- [ ] **AC-0005:** Self message → KHÔNG trigger
- [ ] **AC-0006:** Rule disabled → KHÔNG trigger
- [ ] **AC-0007:** Sale vừa reply contact đó trong 3 phút trước → KHÔNG trigger (BR-0007)
- [ ] **AC-0008:** PUT với `startMinute=1080, endMinute=480` → 400 (start>=end)
- [ ] **AC-0009:** PUT với timezone không hợp lệ → 400
- [ ] **AC-0010:** Member không có ZaloAccountAccess(admin) → 403
- [ ] **AC-0011:** UI trang quản lý: bật/tắt, sửa giờ, sửa message, hiện preview
- [ ] **AC-0012:** Build BE + FE pass, tests pass

## 9. Frontend

- **Route mới:** `/zalo-accounts/:id/auto-reply` (hoặc dialog ngay từ trang `ZaloAccountsView`)
- Đề xuất: **dialog** thay vì page mới, vì gắn liền với 1 Zalo account
- Form:
  - Switch "Bật auto-reply"
  - 7 checkbox cho ngày (CN, T2..T7)
  - Time picker cho `startMinute`/`endMinute`
  - Textarea cho message (counter 1000)
  - Number input cho cooldown (slider 5-1440)
  - Timezone select (default Asia/Ho_Chi_Minh, ít option)
- Nút thử: "Gửi thử cho UID X" (optional, có thể skip MVP)

## 10. Edge cases

- **EC-0001:** Window vượt qua nửa đêm (vd: shop đêm 22h-6h) → SPEC v1 không hỗ trợ, validation `start < end`. Sale phải tạo 2 rule hoặc đảo logic. Document rõ.
- **EC-0002:** Contact spam 100 tin trong 1 phút → chỉ auto-reply 1 lần do cooldown check.
- **EC-0003:** Server restart đúng lúc trigger → mất tin đó, không retry (acceptable: auto-reply là best-effort).
- **EC-0004:** Zalo rate limit hit → log warn, skip, history KHÔNG insert (để có thể retry lần sau).
- **EC-0005:** Rule update giữa lúc tin đến → đọc rule mới nhất từ DB mỗi message (chấp nhận 1 query/msg, acceptable load).

## 11. Out of scope

- Multiple rules / time-based variants (chỉ 1 rule per account)
- Window vượt nửa đêm (làm sau)
- Auto-reply theo keyword trigger ("bảng giá" → gửi bảng giá) — đó là chatbot, scope khác
- Stats / dashboard: số tin auto-reply, % conversion sau auto-reply

## 12. Test plan

### Unit (mocked)
- `shouldAutoReply` các nhánh: workhour, after-hour, weekend, disabled, group, self, cooldown, recent-staff-reply
- Bitmask helper `isWorkDay`
- Timezone conversion edge cases (DST không applicable cho VN, nhưng test với UTC)

### Integration (real Postgres)
- Full lifecycle: PUT rule → simulate incoming message → verify Message row + AutoReplyHistory row
- Cooldown: trigger 2 lần liên tiếp, chỉ 1 row history
- Permission: 403 cho member, 200 cho admin
- Validation: 400 cho input sai
