# Feature 0033: Friend aggregates (chattingNicksCount, acceptedNicksCount)

## 1. Mô tả

Admin muốn trả lời ngay câu hỏi "Rep A đang chăm sóc bao nhiêu khách qua
nick CRM, bao nhiêu trong số đó đã accept friend request, bao nhiêu đang
active chat?" để đánh giá workload và hiệu quả. Hôm nay phải viết SQL ad-hoc
hoặc query Friend table thủ công.

Feature 0020 (friendship lifecycle) đã có rows trong `Friend` và
`FriendshipAttempt`. Feature này thêm endpoint aggregate đếm theo
`zaloAccountId` (mỗi nick = 1 zalo account), trả về cho admin xem trên
dashboard.

Match ZaloCRM-3.0 release notes: "Friend model + aggregates ... đếm nick CRM
đang chăm khách".

## 2. User Stories

- **US-0033-1:** Là Admin, tôi mở Settings → Zalo Accounts và thấy mỗi
  account hiển thị 2 số: số friend đã accept và số đang active chat (có
  inbound trong 7 ngày gần nhất).
- **US-0033-2:** Là Admin, tôi có endpoint `GET /api/v1/friends/stats` trả
  về aggregate cho toàn org, dùng cho dashboard hoặc export báo cáo.
- **US-0033-3:** Là Admin/Owner, tôi thấy total số friend trên Org-level
  KPI để biết quy mô tệp khách qua kênh Zalo cá nhân.

## 3. Business Rules

### Định nghĩa metrics

- **BR-0001:** `acceptedNicksCount` per ZaloAccount = số rows trong `Friend`
  có `zaloAccountId = X` (Friend rows are created only on accepted attempts
  per Feature 0020, nên count rows = count accepted).
- **BR-0002:** `chattingNicksCount` per ZaloAccount = số DISTINCT `friend.contactId`
  thoả mãn:
  - `friend.zaloAccountId = X`
  - Tồn tại Message với `senderType='contact'`, `senderUid = friend.zaloUid`,
    `createdAt >= NOW() - INTERVAL '7 days'`, và message đó nằm trên
    conversation thuộc zaloAccount X.
  - Reason cho 7 ngày: "active" theo industry default; configurable qua
    env var `FRIEND_ACTIVE_WINDOW_DAYS` (default 7) nếu khách muốn nới ra.
- **BR-0003:** Nếu `friend.contactId IS NULL` (Friend row chưa link với
  CRM contact): chỉ count vào `acceptedNicksCount`, KHÔNG count vào
  `chattingNicksCount`. Reason: không xác định được contact => không xác
  định được conversation.

### Permissions

- **BR-0004:** `GET /api/v1/friends/stats`:
  - Owner/admin của org → trả về toàn org (tất cả ZaloAccount thuộc org).
  - Member → trả về chỉ những ZaloAccount mà member có
    `ZaloAccountAccess` (any permission level, không cần `chat`).
- **BR-0005:** Cross-org leak: query luôn filter `orgId = req.user.orgId`.

### Performance

- **BR-0006:** Aggregate query không được scan toàn `Message` table. Phải
  dùng index `(zaloAccountId, senderType, createdAt)` đã có hoặc thêm
  composite index nếu thiếu. Target: < 200ms cho org có 100k friends + 10M
  messages.
- **BR-0007:** Caching: response cache 60s theo (orgId, userId) — admin
  reload dashboard không cần re-aggregate mỗi click. In-memory LRU (existing
  `lru-cache` dependency nếu có) hoặc đơn giản là Map với TTL. KHÔNG cần
  Redis cho phase 1.

## 4. Input / Output

### Schema

KHÔNG thêm field mới vào `Friend` hoặc `ZaloAccount`. Aggregate là **on-demand
compute**, không denormalize. Reason: friend table rebalances thường xuyên
(Feature 0020 daily refresh), denormalize sẽ luôn stale, tốn complexity
maintain. Compute on-demand đủ nhanh với index.

Tuỳ chọn: nếu performance test cho thấy không đạt BR-0006 với 100k+ friends,
fallback sang materialized view `friend_aggregates_mv` refresh mỗi 5 phút.

**Index audit (deliverable):** Kiểm tra `message` table đã có index nào.
Nếu thiếu `(zalo_account_id, sender_type, created_at)`, thêm trong migration.
Backend hiện đã có một số index trên Message — agent xác minh trước khi add.

### Endpoint

#### `GET /api/v1/friends/stats`

- **Auth:** Required (any authenticated user trong org).
- **Query params:** Không.
- **Response 200:**
  ```json
  {
    "byAccount": [
      {
        "zaloAccountId": "uuid",
        "displayName": "Sale CFO Hà Nội",
        "acceptedNicksCount": 142,
        "chattingNicksCount": 58
      },
      ...
    ],
    "totals": {
      "acceptedNicksCount": 1450,
      "chattingNicksCount": 612
    },
    "windowDays": 7
  }
  ```
- **Behavior:**
  - Member: `byAccount[]` chỉ chứa các account user có access. `totals`
    cũng chỉ sum trên những account đó.
  - Owner/admin: toàn org.
- **Errors:** 401 unauthorized only. No other error paths (read-only
  aggregate, không có invalid input).

### Frontend integration

- Settings → Zalo Accounts page: bảng list account thêm 2 cột:
  "Bạn đã accept" (acceptedNicksCount) và "Đang chat" (chattingNicksCount).
  Subtitle tooltip giải thích "Đang chat = có tin nhắn KH gửi đến trong 7
  ngày gần đây".
- Dashboard (optional, nếu có sẵn): top-row KPI "Total friends across nicks"
  + "Active chats this week". Phase 1 deliverable: only Settings page;
  dashboard tile là nice-to-have.

## 5. Edge Cases

- **EC-0001:** Org chưa có ZaloAccount nào → response `byAccount: []`,
  `totals: { both 0 }`.
- **EC-0002:** ZaloAccount tồn tại nhưng chưa có Friend (mới connect) →
  row với cả 2 count = 0.
- **EC-0003:** Friend.contactId NULL (chưa map CRM) → count vào accepted
  only (BR-0003).
- **EC-0004:** Same KH (same zaloUid) là friend của 2 nicks khác nhau →
  count vào cả 2 ZaloAccount independently (đúng semantics: "nick A đã
  add KH X, nick B cũng đã add KH X", không phải duplicate).
- **EC-0005:** Window edge: tin nhắn cuối lúc T-7d-0s30ms → tính vào active
  hay không? Dùng `>= NOW() - INTERVAL '7 days'` strict cutoff, không cần
  fuzzy.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `GET /api/v1/friends/stats` trả 200 với shape đúng cho
      org có data.
- [ ] **AC-0002:** Member với ACL trên ZaloAccount A,B (không có C) →
      response chỉ có A và B, totals sum chỉ trên A+B.
- [ ] **AC-0003:** Admin/Owner → toàn bộ ZaloAccount trong org.
- [ ] **AC-0004:** Friend không có contactId → counted in accepted, NOT
      in chatting.
- [ ] **AC-0005:** Inbound message > 7 ngày → KHÔNG count active.
- [ ] **AC-0006:** Inbound message trong 7 ngày → count active.
- [ ] **AC-0007:** Cùng KH friend với 2 nicks → count vào cả 2.
- [ ] **AC-0008:** Query plan kiểm tra: dùng index, KHÔNG sequential scan
      `message`. Document `EXPLAIN ANALYZE` output trong PR description.
- [ ] **AC-0009:** Caching: call lần 2 trong 60s → response trả nhanh (cache
      hit). Test: assert second call < 50ms.
- [ ] **AC-0010:** Cross-org: user của org A request → KHÔNG thấy data org B.
- [ ] **AC-0011:** FE Settings → Zalo Accounts hiển thị 2 cột mới.
- [ ] **AC-0012:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Friend` model (Feature 0020) — đọc only, không alter.
- `Message` table — đọc only, kiểm tra index.
- `ZaloAccount` + `ZaloAccountAccess` — đọc để filter theo permission.
- `backend/src/modules/friendship/` — file mới hoặc thêm route vào
  `friendship-routes.ts` (recommend `friendship-routes.ts` để cohesion).
- `frontend/src/pages/SettingsZaloAccounts.vue` (hoặc file Settings Zalo
  Accounts hiện tại) — thêm cột.
- `frontend/src/types/friend.ts` (hoặc tạo mới) — TS type cho response.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| New endpoint handler + permission filter | ~60 |
| SQL aggregate query (2 CTEs hoặc 2 separate queries) | ~40 |
| Index migration (nếu thiếu) | ~5 |
| In-memory cache layer | ~30 |
| FE Settings columns + fetch call | ~50 |
| FE TS types | ~10 |
| Integration tests | ~120 |
| **Tổng** | **~315 LOC** |

### Risk: LOW-MEDIUM

Performance là rủi ro chính. Mitigation: integration test với 10k+ Message
rows + EXPLAIN ANALYZE check trong CI hoặc PR description. Logic bản thân
đơn giản (2 COUNT queries).

### Test strategy

- Integration: seed 3 ZaloAccount × 5 Friend × mixed Message timestamps
  → assert counts.
- Unit: window cutoff math (mock now()).
- Permission: member access subset, admin full.
- Cache: monotonic timer test (Vitest fake timers) — call A, call B in 30s
  → same result (mocked clock); call C at 61s → recompute.

### Aggregate query shape

```sql
-- AcceptedNicks per account
SELECT zalo_account_id, COUNT(*) AS accepted
FROM friends
WHERE org_id = $1 AND zalo_account_id = ANY($2)
GROUP BY zalo_account_id;

-- ChattingNicks per account (7-day window)
SELECT f.zalo_account_id, COUNT(DISTINCT f.contact_id) AS chatting
FROM friends f
JOIN conversations c ON c.contact_id = f.contact_id
  AND c.zalo_account_id = f.zalo_account_id
JOIN messages m ON m.conversation_id = c.id
  AND m.sender_type = 'contact'
  AND m.created_at >= NOW() - INTERVAL '7 days'
WHERE f.org_id = $1
  AND f.zalo_account_id = ANY($2)
  AND f.contact_id IS NOT NULL
GROUP BY f.zalo_account_id;
```

Agent có thể chọn Prisma `$queryRaw` hoặc fluent equivalent. `$queryRaw`
được khuyến nghị cho rõ ràng + ép Postgres dùng plan tốt nhất.

### Deviations from ZaloCRM-3.0

3.0 release notes nói "denormalize aggregates" — chúng ta chọn on-demand
+ cache 60s thay vì denormalize. Lý do: friend rows churn (daily refresh
của 0020), denormalize sẽ stale liên tục. On-demand + cache vẫn cho UX
realtime feel mà không cần phức tạp maintenance. Có thể migrate sang denorm
nếu performance không đạt.

### Out of scope (Phase 2)

- Trend chart (chattingNicksCount theo thời gian).
- Per-user breakdown (rep nào đang chăm KH nào).
- Friend churn metrics (defriend rate, response time).
- Materialized view + refresh job (chỉ làm nếu BR-0006 không đạt với pure
  on-demand).
