# Feature 0034: Contact merge by Zalo globalId

## 1. Mô tả

Feature 0018 đã có duplicate detection theo 3 strategy: `phone_exact`,
`zaloUid_exact`, `name_fuzzy`. Tuy nhiên Zalo có khái niệm `globalId` —
canonical user ID survives khi user merge/migrate giữa các tài khoản Zalo.
Cùng 1 người thật có thể có nhiều `zaloUid` khác nhau theo thời gian (cũ
bị deactivate, mới sinh ra) nhưng `globalId` giữ nguyên.

Feature này thêm `Contact.zaloGlobalId` + strategy detection thứ 4
`globalId_exact` để bắt duplicate mà phone/uid không match.

Match ZaloCRM-3.0 v3.0: "Gộp khách hàng cha-con tự động, policy hard/soft
merge" + "globalId".

## 2. User Stories

- **US-0034-1:** Là Admin, khi KH có 2 zalo account khác `zaloUid` nhưng
  cùng `globalId`, hệ thống tự gom thành 1 cluster duplicate đề xuất merge.
- **US-0034-2:** Là Sale, tôi không phải tự nhớ "ờ anh này có 2 nick zalo" —
  duplicate page báo cho tôi.

## 3. Business Rules

### Schema

- **BR-0001:** `Contact.zaloGlobalId String?` — nullable. Lưu khi inbound
  message có globalId trong payload. KHÔNG required khi tạo contact.

### Sync

- **BR-0002:** Inbound message handler: nếu `message.data.globalId` (hoặc
  field tương đương zca-js trả về) non-empty → upsert vào contact.
  - Contact tạo mới → set ngay khi create.
  - Contact đã tồn tại + globalId hiện tại NULL → update.
  - Contact đã tồn tại + globalId hiện tại non-null + khác với incoming →
    KHÔNG overwrite (defensive: có thể inbound từ thread khác liên kết
    contact qua zaloUid). Log warning với detail để inspect manual.

### Detection

- **BR-0003:** New duplicate strategy `globalId_exact`: group contacts có
  cùng `zaloGlobalId` non-null trong cùng `orgId`. Confidence 1.0 (cao nhất,
  ngang `zaloUid_exact`).
- **BR-0004:** Strategy priority (existing): phone_exact > zaloUid_exact >
  globalId_exact > name_fuzzy. Nếu cùng 2 contacts match nhiều strategy →
  giữ strategy có confidence cao nhất.

### Merge policy

- **BR-0005:** Khi user merge 2 contacts qua duplicate UI: existing merge
  logic của Feature 0018 áp dụng. Sau merge:
  - `primary.zaloGlobalId` được giữ.
  - Nếu primary chưa có globalId nhưng secondary có → copy globalId sang
    primary.
  - Nếu cả 2 đều có và khác nhau → giữ primary's globalId (manual decision
    by rep). Log warning.

## 4. Input / Output

### Schema migration

```prisma
model Contact {
  // ... existing fields ...
  zaloGlobalId String? @map("zalo_global_id")

  @@index([orgId, zaloGlobalId])  // for fast lookup in detection
}
```

Migration: `ADD COLUMN zalo_global_id TEXT NULL` + composite index.
Backfill: NULL ok (BR-0002 sẽ điền dần).

### Endpoint changes

- `GET /api/v1/contacts/:id` — projection thêm `zaloGlobalId`.
- `GET /api/v1/contacts/duplicates` (Feature 0018 endpoint) — response
  cluster nay có thể có `level: 'globalId_exact'`.

### Detection update

In `backend/src/modules/contacts/duplicate-detection.ts`:

```typescript
export type DuplicateLevel =
  | 'phone_exact'
  | 'zaloUid_exact'
  | 'globalId_exact'  // new
  | 'name_fuzzy';

function detectByGlobalId(contacts: ContactForDup[]): DuplicateGroup[] {
  // Group by zaloGlobalId, filter groups with size > 1.
}
```

Update the service entry to call new detector.

### Inbound handler

In `backend/src/modules/chat/message-handler.ts`, when persisting contact:
- Add `zaloGlobalId: msg.globalId || null` to creates.
- For existing contacts: conditional update per BR-0002.

`msg.globalId` comes from `processZaloMessage` enrichment. Implementer
verifies field name in zca-js payload (likely `message.data.globalId` or
`message.data.cliMsgId` enriched) and propagates through
`handleIncomingMessage` opts.

## 5. Edge Cases

- **EC-0001:** zca-js không gửi globalId field (cũ payload, hoặc version
  khác) → field giữ NULL, không lỗi.
- **EC-0002:** Same globalId xuất hiện trên 3+ contacts → tất cả gộp 1
  cluster.
- **EC-0003:** Contact đã merge (mergedIntoId set) → exclude khỏi
  duplicate detection (Feature 0018 đã làm).
- **EC-0004:** Migration: existing rows globalId NULL → không cluster hoá
  được bằng strategy này; chỉ "kích hoạt" sau khi inbound điền dần.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Migration add `zalo_global_id TEXT NULL` + index → build pass.
- [ ] **AC-0002:** Inbound message với globalId → Contact mới tạo có
      `zaloGlobalId` set.
- [ ] **AC-0003:** Inbound message với globalId → Contact cũ có globalId
      NULL → update to globalId.
- [ ] **AC-0004:** Inbound message với globalId khác globalId hiện tại →
      KHÔNG overwrite, log warning.
- [ ] **AC-0005:** 2 contacts cùng `zaloGlobalId`, khác `zaloUid` →
      `duplicate-detection` group level=`globalId_exact`, confidence=1.0.
- [ ] **AC-0006:** GET `/contacts/duplicates` trả cluster có
      `level=globalId_exact`.
- [ ] **AC-0007:** Merge 2 contacts: primary giữ globalId, secondary's
      globalId chuyển sang primary nếu primary NULL.
- [ ] **AC-0008:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `Contact` model — thêm 1 field + 1 index.
- `backend/src/modules/contacts/duplicate-detection.ts` — thêm strategy.
- `backend/src/modules/contacts/duplicate-service.ts` — register new detector.
- `backend/src/modules/contacts/duplicate-routes.ts` — expand response
  type if needed.
- `backend/src/modules/chat/message-handler.ts` — propagate globalId from
  zca-js payload.
- `backend/src/modules/zalo/zalo-message-helpers.ts` /
  `zalo-listener-factory.ts` — enrich `handleIncomingMessage` opts với
  globalId (verify zca-js field name).
- FE: Feature 0018 duplicate UI tự động pick up new level — nice to add
  label "Trùng globalId" for the new level (small i18n update).

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration | ~5 |
| Inbound globalId propagation (4 files) | ~20 |
| New detector + service wiring | ~50 |
| Routes type update | ~10 |
| FE label/i18n | ~10 |
| Backend tests | ~80 |
| **Tổng** | **~175 LOC** |

### Risk: LOW

Additive. Existing duplicate flow tested in Feature 0018. New strategy
là copy-paste của zaloUid_exact với field swap.

### Test strategy

- Integration: 2 contacts same globalId different uids → detected.
- Inbound: globalId propagation through pipeline (mock zca-js payload).
- Merge: globalId carried to primary correctly.

### Deviations from ZaloCRM-3.0

3.0 release note ngắn ("policy hard/soft merge"). Chúng ta giữ existing
Feature 0018 merge logic (soft merge: mergedIntoId pointer). Hard merge
(physical delete of secondary row) là Phase 2 nếu cần.

### Out of scope (Phase 2)

- Auto-merge khi globalId match (hiện tại detection-only, rep confirm thủ
  công).
- globalId-based duplicate during contact CREATE form (vd Admin nhập 2
  contact trùng globalId thủ công).
- Backfill historical contacts (cần gọi zca-js getUserInfo cho từng
  zaloUid để lấy globalId — heavy job).
