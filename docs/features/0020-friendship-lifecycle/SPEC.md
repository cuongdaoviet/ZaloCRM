# Feature 0020: Friend / FriendshipAttempt lifecycle tracking

## 1. Mô tả
Sale dùng zca-js để tra Zalo UID từ số điện thoại rồi gửi lời mời kết bạn —
nhưng toàn bộ vòng đời đó hiện vô hình với manager và phải tự nhớ với sale.
Tính năng này thêm `FriendshipAttempt` (state machine queued → looking_up →
sent → accepted | declined | timeout | error) và `Friend` (quan hệ đã kết
nối), kèm worker cron 30s xử lý queue (gọi `findUser` và `sendFriendRequest`
qua zca-js, tôn trọng rate-limit), socket-listener nhận sự kiện accepted từ
Zalo, và trang `/friends` để theo dõi.

## 2. User Stories liên quan
- US-0020-1: Là Sale, tôi nhập 50 số điện thoại từ form lead → bấm "Đặt vào
  hàng đợi kết bạn" → hệ thống tự tra UID và gửi lời mời, tôi không phải mở
  Zalo và nhập tay từng cái.
- US-0020-2: Là Sale, tôi mở trang `/friends`, lọc `state=sent` → thấy 23
  lời mời đang chờ phản hồi để biết theo dõi tiếp.
- US-0020-3: Là Sale, tôi mở chi tiết 1 Contact → thấy lịch sử attempt (gửi
  lúc nào, từ Zalo nào, kết quả gì) để biết KH đã từng từ chối hay chưa.
- US-0020-4: Là Admin, tôi xem `/friends` cho cả org → biết Zalo "Sale Hương"
  đang có 12 lời mời pending, 3 bị decline tuần này.
- US-0020-5: Là Sale, KH từ chối tuần trước, giờ tôi muốn gửi lại lời mời từ
  một Zalo identity khác → hệ thống cho phép (mỗi (contact, zaloAccount) là
  một dòng đời riêng).
- US-0020-6: Là Sale, KH chấp nhận lời mời → tôi mở chat thấy conversation
  có sẵn ngay, không phải tự tạo.

## 3. Business Rules

### Quyền
- BR-0001: **Enqueue** yêu cầu caller có ít nhất một trong các điều kiện sau
  trên `zaloAccountId`:
  - Là `owner` của `ZaloAccount` (`ZaloAccount.ownerUserId === user.id`), HOẶC
  - Có `ZaloAccountAccess` với `permission ∈ {chat, admin}`, HOẶC
  - Là role `owner`/`admin` của org (bỏ qua ACL).
- BR-0002: **Cancel** chỉ chủ nhân attempt (`createdByUserId`) hoặc role
  `owner`/`admin` được phép.
- BR-0003: **List**: `member` chỉ thấy attempt do chính mình tạo;
  `owner`/`admin` thấy toàn org.
- BR-0004: Tất cả query đều org-scoped — không leak qua org khác.

### State machine
```
queued ──► looking_up ──► sent ──► accepted (→ tạo Friend + Conversation)
   │           │            │  ╲
   │           ╲            │   ╲► declined
   │            ╲           │
   ╲► cancelled  ╲► error   ╲► timeout
                              (sweep 7 ngày)
```
- BR-0005: Tại mọi thời điểm chỉ có **một** attempt **active** cho cặp
  `(contactId, zaloAccountId)`. Active = `state ∈ {queued, looking_up, sent}`.
  Re-enqueue cho cặp này chỉ hợp lệ khi attempt cũ ở
  `{accepted, declined, timeout, error, cancelled}`.
- BR-0006: Một contact có thể có nhiều attempt **với các zaloAccountId khác
  nhau** đồng thời.
- BR-0007: Transition cho phép (mọi transition khác → 409):
  - `queued → looking_up | cancelled`
  - `looking_up → sent | error | cancelled`
  - `sent → accepted | declined | timeout | error`
  - Các state terminal bất biến.
- BR-0008: `cancel` chỉ hợp lệ khi `state ∈ {queued, looking_up}`. Khi
  `state = sent`, lời mời đã rời server — không recall được.

### Rate-limit & throttling
- BR-0009: Reuse `zaloRateLimiter` (daily 200 / burst 5-per-30s). **Lookup
  và sendFriendRequest cùng được tính** vào quota. Khi quota hết, worker
  dừng batch hiện tại, attempt còn lại ở trạng thái cũ → pick lại tick sau.
- BR-0010: Inter-call delay trong batch worker: random 2–5s (reuse
  `nextSendDelayMs()` từ `campaign-helpers.ts`).

### Look-up & send
- BR-0011: Nếu `findUser(phone)` trả về "không có Zalo" → `state = error`,
  `errorCode = 'phone_not_on_zalo'`, đồng thời set
  `Contact.metadata.notOnZalo = { checkedAt, by: zaloAccountId }`. Lần sau
  enqueue chính contact đó vẫn được phép, nhưng FE phải warn trước.
- BR-0012: `findUser` thành công nhưng UID đã trùng với `Friend` hiện hữu
  của cùng `zaloAccountId` → chuyển thẳng sang `accepted`, không gửi
  request (idempotent: đã là bạn rồi).
- BR-0013: `requestMsg` optional, ≤ 200 ký tự, hỗ trợ placeholder
  `{{contactName}}`, `{{firstName}}` (reuse `applyMessagePlaceholders`).
- BR-0014: Empty `requestMsg` → gửi với chuỗi rỗng (zca-js cho phép).

### Accepted detection
- BR-0015: Hai nguồn quyết transition `sent → accepted`:
  1. **Listener event** từ zca-js (sự kiện friend accepted / "friend_added")
     — primary.
  2. **Timeout sweep**: với attempt `sent` quá `FRIENDSHIP_TIMEOUT_DAYS`
     (default 7), worker chuyển sang `timeout`. Có thể re-enqueue.
- BR-0016: Khi transition `accepted`:
  - Upsert row `Friend(zaloAccountId, zaloUid)`.
  - Nếu chưa có `Conversation(zaloAccountId, externalThreadId=zaloUid)` →
    tạo conversation rỗng (sale muốn vào chat ngay sau accept).
  - Emit activity `friendship.accepted`.

### Activity log
- BR-0017: Mỗi transition emit qua `logActivityAsync()` (đã được
  `trackBackground`-wrap, an toàn cho tests):
  - `friendship.queued`, `friendship.lookup_failed`, `friendship.sent`,
    `friendship.accepted`, `friendship.declined`, `friendship.timeout`,
    `friendship.cancelled`, `friendship.error`.
- BR-0018: System events (worker, listener) log với `userId = null`.
  Manual cancel/enqueue log với `userId = caller.id`.

## 4. Input / Output

### Schemas

```ts
interface FriendshipAttempt {
  id: string;
  orgId: string;
  contactId: string;
  zaloAccountId: string;
  createdByUserId: string | null;
  state: 'queued' | 'looking_up' | 'sent' | 'accepted'
       | 'declined' | 'timeout' | 'error' | 'cancelled';
  zaloUidFound: string | null;
  requestMsg: string | null;
  resolvedMsg: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  queuedAt: Date;
  lookedUpAt: Date | null;
  sentAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Friend {
  id: string;
  orgId: string;
  zaloAccountId: string;
  zaloUid: string;
  contactId: string | null;
  attemptId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}
// Unique: (zaloAccountId, zaloUid)
```

Back-references mới: `Contact.attempts`, `Contact.friends`,
`ZaloAccount.friendshipAttempts`, `ZaloAccount.friends`,
`User.createdFriendshipAttempts` (relation "CreatedFriendshipAttempts").

### Endpoints

#### POST /api/v1/contacts/:id/friendship
- **Auth:** `authMiddleware` + BR-0001.
- **Body:** `{ zaloAccountId, message? }`.
- **Response 201:** FriendshipAttempt object (`state = 'queued'`).
- **Errors:** 400 (no phone, message > 200), 403, 404, 409 `attempt_already_active`.

#### POST /api/v1/friendship-attempts/bulk
- **Body:** `{ zaloAccountId, contactIds[] (≥1, ≤500), message? }`.
- **Response 201:** `{ queued[], skipped[], totalQueued, totalSkipped }` (partial success).

#### GET /api/v1/friendship-attempts
- **Query:** state (CSV), zaloAccountId, contactId, from, to, page, limit.
- **Response 200:** paginated list with include (contact, zaloAccount, createdBy).
- Member tự ép `createdByUserId = self.id` ở tầng service.

#### GET /api/v1/friendship-attempts/:id
- 200 + same include shape. 404 nếu cross-org hoặc member xem của người khác.

#### POST /api/v1/friendship-attempts/:id/cancel
- Hợp lệ khi `state ∈ {queued, looking_up}`. 200/409.

## 5. Worker design

`backend/src/modules/friendship/friendship-worker.ts` — pattern bám sát `campaign-worker.ts`:

- **Tick:** node-cron `*/30 * * * * *`.
- **Batch size mỗi tick:**
  - 20 attempt `queued` → `looking_up` → gọi `findUser`.
  - 20 attempt `looking_up` → gọi `sendFriendRequest`.
  - Sweep `sent` quá hạn → `timeout`.
- **Group theo zaloAccountId**, `MAX_ACCOUNTS_PER_TICK = 5`.
- **Re-entrant check:** re-fetch state trước mỗi gọi zca-js; nếu đã `cancelled` → skip.
- **Rate-limit:** `zaloRateLimiter.checkLimits()` trước mỗi call. Hết quota → break batch (KHÔNG mark error — transient).
- **Backoff khi gọi zca-js fail:**
  - Lookup fail → retry **immediate** một lần. Vẫn fail → `state = error`, `errorCode = 'lookup_failed'`.
  - Send fail → tương tự, `errorCode = 'send_failed'`.
- **Account disconnected:** `errorCode = 'account_disconnected'`, `state = error`.
- **Inter-call delay:** `await sleep(nextSendDelayMs())` (2–5s).
- **Graceful shutdown:** mỗi DB write phải await-ed. Recovery: đầu mỗi tick, reset attempt `looking_up` với `updatedAt < now - 5 phút` về `queued`.
- **trackBackground discipline:** MANDATORY dùng `logActivityAsync` hoặc `trackBackground()` cho mọi fire-and-forget DB write (xem PR #24).

### Timeout sweep
```ts
await prisma.friendshipAttempt.updateMany({
  where: {
    state: 'sent',
    sentAt: { lt: new Date(Date.now() - FRIENDSHIP_TIMEOUT_DAYS * 86400_000) },
  },
  data: { state: 'timeout', decidedAt: new Date() },
});
```

### Config
| Const | Default |
|---|---|
| `LOOKUP_BATCH` | 20 |
| `SEND_BATCH` | 20 |
| `MAX_ACCOUNTS_PER_TICK` | 5 |
| `FRIENDSHIP_TIMEOUT_DAYS` | 7 |
| `STUCK_LOOKUP_MS` | 5 * 60_000 |

## 6. Webhook / listener integration

zca-js bắn sự kiện khi recipient phản hồi friend request. Implementation guideline:

- Thêm listener trong `zalo-listener-factory.ts`:
  ```ts
  listener.on('friend_event', async (event: any) => {
    await handleFriendEvent(accountId, event);
  });
  ```
- `handleFriendEvent` ở `friendship-listener.ts`:
  - Parse `event.userId` + `event.type` (accepted/declined/added).
  - Lookup attempt theo `(zaloAccountId, zaloUidFound, state='sent')`.
  - Gọi `markAccepted()` / `markDeclined()` service.
  - Không tìm thấy (KH chấp nhận ngoài CRM): vẫn upsert `Friend` row nhưng không có `attemptId`. Log với `details: { source: 'external' }`.
- Listener phải swallow exception.

**Nếu webhook không bắn:**
- Timeout sweep là safety net.
- Optional v2: định kỳ gọi `api.getAllFriends()` reconcile. **Out of scope v1.**

## 7. Edge Cases

- **EC-0001:** Bulk enqueue 100 contact, account hit burst-limit tại 50. Worker tick tiếp theo (30s) tự tiếp tục.
- **EC-0002:** Contact thiếu phone tại lúc enqueue → reject sớm ở endpoint (400 `contact_missing_phone`).
- **EC-0003:** Sale edit Contact.phone trong khi attempt `sent`. Friend.zaloUid vẫn chính xác (lưu từ zaloUidFound).
- **EC-0004:** Cùng contact, 2 Zalo accounts cùng enqueue → cả hai attempt chạy độc lập.
- **EC-0005:** `findUser` OK nhưng `sendFriendRequest` fail với "already friends" → chuyển `accepted`, upsert Friend, `details: {source: 'already_friends'}`.
- **EC-0006:** Server restart khi attempt `looking_up`. `STUCK_LOOKUP_MS` sweep reset về `queued`.
- **EC-0007:** Contact bị xoá giữa lúc attempt `queued`. Worker pick lên → `errorCode = 'contact_deleted'`.
- **EC-0008:** Race cancel vs worker pick. Re-fetch state trước mỗi gọi zca-js → worker skip.
- **EC-0009:** zca-js `findUser` trả UID rỗng/format lạ → treat như `phone_not_on_zalo`.
- **EC-0010:** Listener bắn accepted cho UID không có attempt (sale tự kết bạn ngoài CRM) → tạo Friend không attempt, không tạo attempt giả.

## 8. Acceptance Criteria

- [ ] **AC-0001:** POST `/contacts/:id/friendship` với phone hợp lệ → 201 `state=queued`.
- [ ] **AC-0002:** POST khi đã có attempt active → 409 `attempt_already_active`.
- [ ] **AC-0003:** POST khi Contact thiếu phone → 400 `contact_missing_phone`.
- [ ] **AC-0004:** Member không có ZaloAccountAccess `chat` → 403.
- [ ] **AC-0005:** Worker tick: attempt `queued` → mocked findUser → `looking_up` → mocked send → `sent`.
- [ ] **AC-0006:** Worker khi mocked findUser trả null → `state=error`, `errorCode='phone_not_on_zalo'`, Contact.metadata có `notOnZalo`.
- [ ] **AC-0007:** Listener nhận event accepted cho UID đã `sent` → `state=accepted`, Friend tạo, Conversation upsert.
- [ ] **AC-0008:** Sweep timeout: attempt `sent` cách đây 8 ngày → tick tiếp theo `timeout`.
- [ ] **AC-0009:** Bulk enqueue 3 contact (1 OK, 1 thiếu phone, 1 active) → `totalQueued=1, totalSkipped=2`.
- [ ] **AC-0010:** Cancel attempt `queued` → 200, state `cancelled`.
- [ ] **AC-0011:** Cancel attempt `sent` → 409.
- [ ] **AC-0012:** Worker hit rate-limit giữa batch → attempt còn lại ở `queued`, tick sau tiếp tục.
- [ ] **AC-0013:** Cross-org isolation: GET không trả attempt của org khác.
- [ ] **AC-0014:** Activity log: enqueue → `friendship.queued`; accept → `friendship.accepted` với `userId=null`.
- [ ] **AC-0015:** Build BE + FE pass, tests pass, không deadlock test suite.

## 9. Dependencies

- **`modules/contacts/`** — Contact gains back-refs `attempts`, `friends`.
- **`modules/zalo/zalo-pool.ts`** — `zaloPool.getInstance()`.
- **`modules/zalo/zalo-rate-limiter.ts`** — `checkLimits()` + `recordSend()`.
- **`modules/zalo/zalo-listener-factory.ts`** — attach friend event listener.
- **`modules/activity/activity-service.ts`** — `logActivityAsync()`.
- **`modules/campaigns/campaign-helpers.ts`** — reuse `applyMessagePlaceholders()`, `nextSendDelayMs()`.
- **`modules/campaigns/campaign-worker.ts`** — pattern reference.
- **`shared/utils/background-tasks.ts`** — `trackBackground()` (CRITICAL).
- **Frontend:**
  - Route `/friends` (FriendsView.vue) + sidebar.
  - `FriendshipBadge.vue` ở Contact detail panel.
  - Bulk action trong ContactsView toolbar.

## 10. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| schema.prisma block | ~40 |
| friendship-service.ts | ~280 |
| friendship-routes.ts (5 endpoints) | ~220 |
| friendship-worker.ts | ~260 |
| friendship-listener.ts | ~80 |
| friendship-helpers.ts | ~60 |
| Backend tests | ~500 |
| FE FriendsView.vue | ~280 |
| FE FriendshipBadge + Contact panel wiring | ~120 |
| FE bulk action dialog | ~140 |
| FE Pinia store | ~120 |
| FE tests | ~180 |
| **Total** | **~2,280 LOC** |

### Risk: **MEDIUM**

- Live zca-js integration cho 2 undocumented APIs (`findUser`, `sendFriendRequest`).
- State machine 8 trạng thái, 11 transition.
- Listener event name (`friend_event`) chưa được verify trong codebase — cần kiểm tra phiên bản zca-js đang dùng.
- Fire-and-forget + worker + test cùng chạy → MANDATORY tuân thủ pattern PR #24 (`trackBackground`).

### Test strategy
- **Unit:** state transition validator, permission check, error code mapping.
- **Integration (Postgres + mocked zca-js):**
  - Mock `zaloPool.getInstance()` với `api.findUser` và `api.sendFriendRequest` là `vi.fn()`.
  - Tick worker thủ công (`processOneAttempt(id)`) thay vì đợi cron.
  - Full lifecycle assertions.
- **E2E (Playwright):** bulk enqueue flow.
- **Test isolation:** `beforeEach` gọi `flushBackgroundTasks()` rồi `resetDb()`.

### Out of scope (v1)
- Hủy lời mời đã `sent` (Zalo không support recall).
- Bulk re-enqueue tất cả `timeout`.
- Statistics dashboard chi tiết.
- Optional `getAllFriends()` reconciliation.
- Webhook outbound khi friend accepted.

### Deployment notes
- Schema mới — `npm run db:push` trên staging trước.
- Worker register trong `app.ts` cùng `startCampaignWorker(io)`.
- Cấu hình `FRIENDSHIP_TIMEOUT_DAYS` qua env optional, default 7.
