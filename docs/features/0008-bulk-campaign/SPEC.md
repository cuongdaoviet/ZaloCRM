# Feature 0008: Bulk message campaign (broadcast)

## 1. Mô tả

Sale cần gửi tin nhắn cho nhiều khách hàng cùng lúc — tin thông báo sale, lời chúc Tết, follow-up bảng giá. Hiện tại phải gửi từng người một, tốn thời gian.

Feature này thêm:
1. **Tạo campaign** — chọn nhóm khách hàng (filter status / source / tag), soạn nội dung (placeholder), chọn Zalo account, có thể schedule cho thời điểm tương lai
2. **Worker tự gửi** — node-cron tick mỗi 30s để pick campaign đến lúc send, send từng target với delay random 2-5s, ghi nhận success/fail/skipped per target
3. **Pause/Resume/Cancel** — admin can pause running campaign giữa chừng
4. **Progress realtime** — Socket.IO push event mỗi 5 targets hoặc khi status đổi
5. **Retry failed** — failed targets có thể retry riêng (vd: Zalo bị mất kết nối tạm)

## 2. User Stories

- **US-0001:** Là Sale, tôi muốn gửi 1 tin Tết tới 200 KH có status `quan_tam` từ Zalo "Sale Hương" → tôi soạn 1 lần, hệ thống tự gửi tuần tự với delay an toàn
- **US-0002:** Là Sale, tôi muốn schedule campaign gửi vào 9h sáng mai (vì giờ là 22h đêm — không tiện gửi)
- **US-0003:** Là Admin, đang chạy campaign 200 KH thì phát hiện nội dung sai → tôi muốn **pause** ngay, không cần đợi 1 tiếng cho hết
- **US-0004:** Sau khi campaign chạy xong, 15 KH bị fail (Zalo lỗi network) → tôi muốn bấm **Retry failed** để gửi lại 15 cái đó
- **US-0005:** Là Sale, tôi muốn xem progress realtime: đã gửi 87/200, fail 3, đang chạy

## 3. Business Rules

### Permission
- **BR-0001:** Tạo + chạy campaign yêu cầu role `owner` / `admin` (không cho `member` vì rủi ro block Zalo). Member chỉ xem campaign của chính mình
- **BR-0002:** Mỗi campaign gắn với **1 Zalo account**. User phải có quyền `chat` trở lên trên account đó

### Sending
- **BR-0003:** Delay giữa các tin: **random 2-5s** (uniform distribution) để tránh detection. Implement: `await sleep(2000 + Math.random() * 3000)`
- **BR-0004:** Reuse `zaloRateLimiter` — nếu account hit 200 tin/ngày → **pause** campaign, ghi log, gửi notification tới user. Tiếp tục ngày hôm sau khi reset
- **BR-0005:** Trước mỗi send, check `isReplied` của conversation gần nhất — nếu KH vừa nhắn 5 phút trước → **delay** send target này lên cuối queue (tránh interrupt active chat)
- **BR-0006:** Auto-skip target nếu contact bị xoá / mất `zaloUid` giữa chừng

### Scheduling
- **BR-0007:** Schedule = lưu `scheduledAt`, status `scheduled`. Worker cron tick mỗi 30s, pick campaigns có `scheduledAt <= now AND status='scheduled'` → đổi sang `running`
- **BR-0008:** Tối đa **1 campaign chạy đồng thời** mỗi Zalo account (tránh chồng chéo). Campaign mới start sẽ pending nếu account đang busy

### Content
- **BR-0009:** Message length 1-2000 chars. Placeholder support: `{{contactName}}`, `{{firstName}}` (reuse logic feature 0004/0005)
- **BR-0010:** No file attachment trong v1 — chỉ text. Multi-file campaign là feature riêng

### Lifecycle
- **BR-0011:** Status lifecycle: `draft` → `scheduled` (nếu set scheduledAt) hoặc `running` (nếu send now) → `paused` (manual) → `running` (resume) → `completed` (all targets processed) hoặc `cancelled` (manual abort)
- **BR-0012:** `completed` campaign không thể delete cứng — soft-delete (set `isDeleted=true`) để giữ audit trail
- **BR-0013:** Retry chỉ áp dụng cho target với status `failed`. Retry tạo new send attempt, không tạo campaign mới

## 4. Schema

```prisma
model Campaign {
  id              String   @id @default(uuid())
  orgId           String   @map("org_id")
  createdByUserId String   @map("created_by_user_id")
  zaloAccountId   String   @map("zalo_account_id")
  name            String
  message         String   // text, max 2000 chars, supports placeholders
  status          String   @default("draft") // draft|scheduled|running|paused|completed|cancelled
  scheduledAt     DateTime? @map("scheduled_at") // null = send now (status=running on create)
  startedAt       DateTime? @map("started_at")
  completedAt     DateTime? @map("completed_at")
  // Filter snapshot — JSON {status?: [...], source?: [...], tags?: [...]}
  // Stored as JSON so we have a record of "what filter ran" even if contact list changes later
  filterSnapshot  Json     @map("filter_snapshot") @default("{}")
  // Stats — denormalized for fast progress queries
  totalTargets    Int      @default(0) @map("total_targets")
  sentCount       Int      @default(0) @map("sent_count")
  failedCount     Int      @default(0) @map("failed_count")
  skippedCount    Int      @default(0) @map("skipped_count")
  isDeleted       Boolean  @default(false) @map("is_deleted")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  org         Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  createdBy   User             @relation("CreatedCampaigns", fields: [createdByUserId], references: [id])
  zaloAccount ZaloAccount      @relation(fields: [zaloAccountId], references: [id])
  targets     CampaignTarget[]

  @@index([status, scheduledAt])
  @@index([orgId, createdAt(sort: Desc)])
  @@map("campaigns")
}

model CampaignTarget {
  id           String    @id @default(uuid())
  campaignId   String    @map("campaign_id")
  contactId    String    @map("contact_id")
  status       String    @default("pending") // pending|sent|failed|skipped
  errorMessage String?   @map("error_message") // populated when status=failed
  sentAt       DateTime? @map("sent_at")
  attemptCount Int       @default(0) @map("attempt_count") // for retry tracking
  createdAt    DateTime  @default(now()) @map("created_at")

  campaign Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  contact  Contact  @relation(fields: [contactId], references: [id])

  @@unique([campaignId, contactId])
  @@index([campaignId, status])
  @@map("campaign_targets")
}
```

Update `Organization`, `User`, `ZaloAccount`, `Contact` để add reverse relations.

## 5. API contract

### POST /api/v1/campaigns
Tạo + tự materialize danh sách target từ filter.

**Body:**
```json
{
  "name": "Khuyến mãi Tết 2026",
  "zaloAccountId": "...",
  "message": "Chào {{firstName}}, shop có khuyến mãi...",
  "filter": {
    "status": ["interested", "converted"],
    "source": ["FB"],
    "tags": ["vip"]
  },
  "scheduledAt": "2026-02-01T09:00:00+07:00" // null = send now
}
```

**Response 201:** Campaign object với `totalTargets` đã populate, status `draft` (nếu cần preview) hoặc `scheduled`/`running`.

> Actually flow tốt hơn: tạo dạng `draft` với targets, user preview xong mới bấm "Start" → đổi sang `scheduled`/`running`. SPEC support 2-step.

### POST /api/v1/campaigns/:id/start
Đổi status `draft` → `scheduled` (nếu có scheduledAt) hoặc `running` (nếu không).

### POST /api/v1/campaigns/:id/pause
Đổi `running` → `paused`. Worker thấy paused thì skip.

### POST /api/v1/campaigns/:id/resume
Đổi `paused` → `running`.

### POST /api/v1/campaigns/:id/cancel
Đổi bất kỳ status → `cancelled`. Remaining pending targets không gửi nữa.

### POST /api/v1/campaigns/:id/retry-failed
Reset targets `failed` về `pending`. Status campaign về `running`.

### GET /api/v1/campaigns?status=running&limit=20
List với filter.

### GET /api/v1/campaigns/:id
Chi tiết + first 50 targets (with contact info).

### GET /api/v1/campaigns/:id/targets?status=failed&page=1
Paginated targets.

### DELETE /api/v1/campaigns/:id
Soft delete (chỉ campaign `completed` hoặc `cancelled`).

**Errors:**
- `400` — validation (message length, scheduledAt past, filter empty)
- `403` — member tạo campaign, hoặc user thiếu access trên Zalo account
- `404` — campaign không tồn tại
- `409` — start campaign khi account đã có 1 campaign đang chạy

## 6. Worker

`campaign-worker.ts`:

```ts
// Tick every 30s
cron.schedule('*/30 * * * * *', async () => {
  // 1. Pick scheduled campaigns due
  const due = await prisma.campaign.findMany({
    where: { status: 'scheduled', scheduledAt: { lte: new Date() } },
  });
  for (const c of due) {
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'running', startedAt: new Date() } });
  }

  // 2. For each running campaign, process up to N targets in this tick
  const running = await prisma.campaign.findMany({
    where: { status: 'running' },
    take: 5, // limit concurrency across campaigns
  });
  for (const c of running) {
    await processCampaignTick(c);
  }
});

async function processCampaignTick(campaign) {
  // Pick pending targets, max 10 per tick per campaign
  const targets = await prisma.campaignTarget.findMany({
    where: { campaignId: campaign.id, status: 'pending' },
    take: 10,
  });
  if (targets.length === 0) {
    // No more pending → mark completed
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'completed', completedAt: new Date() } });
    io.emit('campaign:status', { campaignId: campaign.id, status: 'completed' });
    return;
  }
  for (const target of targets) {
    // Re-check campaign status (might have been paused mid-loop)
    const fresh = await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true } });
    if (fresh?.status !== 'running') return;
    // BR-0004 rate limit
    if (!zaloRateLimiter.checkLimits(campaign.zaloAccountId).allowed) {
      await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'paused' } });
      return;
    }
    await sendOneTarget(campaign, target);
    await sleep(2000 + Math.random() * 3000);
  }
  // Emit progress
  io.emit('campaign:progress', { campaignId: campaign.id, ...stats });
}
```

## 7. Frontend

**Route mới:** `/campaigns` (sidebar mục mới "Chiến dịch", icon `mdi-bullhorn-outline`, admin only)

### List view
- Table: Name | Zalo account | Status (chip) | Total / Sent / Failed | Created at | Actions (View / Start / Pause / Retry / Cancel / Delete)
- Filter status

### Create dialog
- Step 1: Form (name, Zalo account select, message textarea với placeholder hint)
- Step 2: Contact filter (status multi-select, source multi-select, tag multi-select) → preview count
- Step 3: Schedule (Now / Schedule for…) → bấm "Tạo" → tạo campaign status `draft`

### Detail view (`/campaigns/:id`)
- Header: status chip + actions (Start / Pause / Resume / Cancel / Retry failed / Delete)
- Progress bar: sentCount / totalTargets, % completed
- Stats cards: total / sent / failed / skipped
- Targets table với tab (Tất cả / Đã gửi / Lỗi / Bỏ qua) — paginated
- Socket.IO subscribe `campaign:progress` cho campaign này → cập nhật progress realtime

## 8. Acceptance Criteria

- [ ] **AC-0001:** POST /campaigns với filter `{status: ['interested']}` → tạo campaign với `totalTargets` = count contacts match
- [ ] **AC-0002:** Start campaign không có scheduledAt → status `running` ngay, worker bắt đầu send trong vòng 30s
- [ ] **AC-0003:** Start với scheduledAt future → status `scheduled`, worker pick lên khi đến giờ
- [ ] **AC-0004:** Pause running campaign giữa chừng → các target chưa gửi không tiếp tục, status `paused`
- [ ] **AC-0005:** Resume paused → tiếp tục từ target tiếp theo (pending), không gửi lại đã sent
- [ ] **AC-0006:** Cancel → status `cancelled`, pending targets không gửi nữa
- [ ] **AC-0007:** Retry failed → các target `failed` về `pending`, campaign về `running`
- [ ] **AC-0008:** Rate limit hit (giả lập) → campaign tự pause với reason log
- [ ] **AC-0009:** Member tạo campaign → 403
- [ ] **AC-0010:** 2 campaigns cùng start trên 1 Zalo account → cái thứ 2 vẫn được tạo nhưng worker chỉ xử lý 1 cái cùng lúc (queue tự động)
- [ ] **AC-0011:** Placeholder `{{contactName}}` substitute đúng cho từng target
- [ ] **AC-0012:** Cross-org isolation: campaign org A không hiện cho user org B
- [ ] **AC-0013:** Build BE + FE pass, tests pass

## 9. Edge cases

- **EC-0001:** Campaign target không có `zaloUid` (contact chưa sync) → status `skipped`, errorMessage='Contact chưa được sync từ Zalo'
- **EC-0002:** Zalo account disconnected giữa lúc campaign chạy → target fail, retry sau khi account reconnect
- **EC-0003:** Server restart giữa lúc campaign running → worker tick lại pick `running` campaign, tiếp tục pending targets
- **EC-0004:** Contact bị xoá giữa campaign → target skip với errorMessage
- **EC-0005:** scheduledAt past khi tạo (vd: 1 phút trước) → worker pick lên ngay ở tick tiếp theo, không reject

## 10. Test plan

### Unit (helpers)
- `validateCampaignInput` — name length, message length, scheduledAt format, filter shape
- `buildContactFilter` — convert API filter object → Prisma where clause
- `applyMessagePlaceholders` — reuse existing helper

### Integration
- Real Postgres + mocked Zalo. Mock worker tick → verify targets processed
- Cover full lifecycle: create → start → pause → resume → complete
- AC-0008: rate limit hit auto-pause
- AC-0007: retry failed
- AC-0009: 403 member
- AC-0010: serial processing per Zalo account
- AC-0012: cross-org isolation

## 11. Out of scope (v1)

- File/image attachment trong campaign — chỉ text
- A/B testing message variants
- Conditional logic (vd: nếu KH ở miền Bắc → message khác)
- Campaign analytics dashboard chi tiết (chỉ count basic ở list view)
- Email/SMS fallback nếu Zalo fail
- Multi-channel send (Zalo + Facebook Messenger cùng lúc)

## 12. Deployment notes

Schema mới — cần `npm run db:push` trên staging trước khi merge.

Worker register vào app.ts cùng với cron của appointment-reminder và zalo-health-check.
