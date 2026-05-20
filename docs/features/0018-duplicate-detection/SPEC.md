# Feature 0018: Phát hiện & gộp contact trùng (Duplicate detection + merge)

## Decisions for orchestrator

Trước khi triển khai, orchestrator cần chốt 3 quyết định sau (mọi mục dưới SPEC được viết dưới dạng "mặc định khuyến nghị" — có thể điều chỉnh):

- **D-0001 — Quét: cron vs on-demand.** Mặc định khuyến nghị **on-demand** (admin bấm "Quét trùng" → API chạy đồng bộ trên job nhỏ, async cho org > 5k contact qua setTimeout fire-and-forget). Lý do: dễ kiểm soát, không thêm scheduler infra; tốc độ chấp nhận được vì most org < 10k contacts. Lựa chọn thay thế: cron daily 03:00 trong cùng process Fastify (giống `appointment-reminder.ts`).
- **D-0002 — Undo / soft-delete window.** Mặc định khuyến nghị **không undo** (merge là một chiều), nhưng giữ `mergedIntoId` + `mergedAt` để admin có thể truy ngược qua activity log và DBA có thể rollback thủ công bằng SQL nếu sai. Lựa chọn thay thế: cửa sổ undo 7 ngày + endpoint `POST /merge/undo` (tăng ~300 LOC + complexity về re-attaching FK).
- **D-0003 — Cross-conversation merge.** Mặc định khuyến nghị **giữ cả hai conversation** trỏ về primary contact (không gộp message thread). Lý do: mỗi conversation gắn với một `zaloAccountId + externalThreadId`; gộp message stream sẽ phá `@@unique([zaloAccountId, externalThreadId])` và làm rối lịch sử. UI sẽ render conversation list của primary contact gồm cả 2 thread. Lựa chọn thay thế: gộp message thread (HIGH risk — phải reorder theo `sentAt`, có thể vi phạm unique, không khả thi MVP).

## 1. Mô tả

Sau một thời gian dài sync + import, danh bạ có nhiều contact trùng (cùng số điện thoại / cùng zaloUid / cùng tên với typo). Feature này thêm (1) job quét phát hiện contact trùng theo nhiều tiêu chí, (2) bảng `DuplicateGroup` chứa các nhóm chờ admin xử lý, và (3) UI admin để xem song song và **gộp** các contact thành một primary — tự động kéo theo conversations / orders / appointments / notes về primary.

## 2. User Stories liên quan

- **US-0018-1:** Là admin/owner, tôi muốn quét toàn bộ contact của org để hệ thống tự gom thành các nhóm trùng, vì hiện tại tôi phải tự search bằng tay khi nghi ngờ.
- **US-0018-2:** Là admin, tôi muốn xem hai contact đặt cạnh nhau (profile, số đơn, hội thoại, lịch hẹn) trước khi quyết định gộp, vì có thể đó là 2 khách thật khác nhau cùng số.
- **US-0018-3:** Là admin, tôi muốn chọn 1 contact làm primary, nhấn "Gộp", và mọi dữ liệu của các contact phụ chuyển sang primary, không cần thao tác thủ công từng order / appointment / conversation.
- **US-0018-4:** Là admin, khi nhóm không phải trùng thật, tôi muốn "Bỏ qua" để lần quét sau không hiện lại.

## 3. Business Rules

### Chuẩn hoá (normalization)

- **BR-0001:** Số điện thoại được chuẩn hoá trước khi so khớp:
  - Loại bỏ khoảng trắng, dấu `+`, dấu `-`, dấu `.`, dấu `(`/`)`.
  - Nếu chuỗi bắt đầu bằng `0` và có 10 chữ số → đổi thành `84` + 9 chữ số sau (VD `0901234567` → `84901234567`).
  - Nếu bắt đầu bằng `84` → giữ nguyên.
  - Nếu bắt đầu bằng `+84` → bỏ `+`.
  - Nếu sau chuẩn hoá < 9 chữ số hoặc không phải toàn chữ số → bỏ qua khỏi quét trùng (coi như không có phone).
- **BR-0002:** Tên được chuẩn hoá: trim, lowercase, NFD-normalize bỏ dấu tiếng Việt (`đ`→`d`, `Đ`→`d`), gộp khoảng trắng. Tên rỗng / ≤ 2 ký tự → bỏ qua khỏi quét fuzzy.

### Phát hiện trùng (detection)

- **BR-0003:** Ba mức phát hiện trùng:
  - **Mức `phone_exact`** — 2 contact cùng phone đã chuẩn hoá. **Auto-confidence = 1.0**.
  - **Mức `zaloUid_exact`** — 2 contact cùng `zaloUid` (non-null). **Auto-confidence = 1.0**.
  - **Mức `name_fuzzy`** — 2 contact có normalized name giống nhau hoàn toàn HOẶC Levenshtein distance ≤ 2 trên normalized name AND độ dài tên ≥ 5. **Confidence 0.6 – 0.9** tuỳ distance.
- **BR-0004:** Một `DuplicateGroup` có thể chứa **≥ 2 contact** (vd: 3 contact cùng phone). Job quét dùng union-find (disjoint-set) để gộp pairs thành group.
- **BR-0005:** Khi rescan, nếu một nhóm đã tồn tại với cùng tập `contactIds` và `status = 'pending'` → giữ nguyên, không tạo trùng. Nếu nhóm cũ có `status = 'merged'` hoặc `'dismissed'` → bỏ qua các pair đã được resolve trước đó (xem BR-0010).

### Quyền (permission)

- **BR-0006:** Quét và gộp chỉ dành cho **owner / admin** của org. Member → 403. Lý do: gộp ảnh hưởng dữ liệu toàn org và không thể undo (theo D-0002).
- **BR-0007:** Xem danh sách nhóm trùng: owner / admin only (member chưa cần dùng).

### Dữ liệu carry-over khi gộp

- **BR-0008:** Khi gộp, **primary contact giữ nguyên** mọi field profile của chính nó (fullName, phone, email, source, status, tags, assignedUserId, metadata). Các contact phụ đóng góp:
  - `tags` của primary = union(`primary.tags`, `phụ.tags`) (loại trùng).
  - `notes` của primary = `primary.notes` + `\n\n--- Gộp từ <fullName-phụ> ---\n` + `phụ.notes` (concat, bỏ qua nếu rỗng).
  - `metadata` shallow-merge: `primary.metadata = { ...phụ.metadata, ...primary.metadata }` (primary wins trên xung đột key).
  - **Mặc định** không ghi đè các field scalar (phone/email/name). Body `POST /merge` có thể truyền `fieldsToKeep` để chọn lại — xem section 4.
- **BR-0009:** FK rewrite: mọi `Conversation.contactId`, `Order.contactId`, `Appointment.contactId`, `CampaignTarget.contactId` của các contact phụ → đổi sang `primary.id`. Thực hiện trong **một Prisma `$transaction`**.

### Lịch sử & idempotency

- **BR-0010:** Sau gộp:
  - Contact phụ KHÔNG bị xoá cứng. Thay vào đó: set `mergedIntoId = primary.id`, `mergedAt = now()`, `status = 'merged'` (giá trị mới của contact.status enum — coi như terminal). Các endpoint list contact mặc định loại trừ `mergedIntoId IS NOT NULL`.
  - `DuplicateGroup.status = 'merged'`, `DuplicateGroup.resolvedByUserId`, `resolvedAt`, `primaryContactId` được ghi vào row.
  - Một activity log `contact.merged` được ghi qua `logActivityAsync` cho **mỗi contact phụ** (`entityType='contact'`, `entityId=phụ.id`, `details={ mergedInto: primary.id, groupId, level }`) — wire vào audit trail của feature 0012.
- **BR-0011:** Dismiss: `DuplicateGroup.status = 'dismissed'`, `resolvedByUserId`, `resolvedAt`. Lần quét sau, các cặp contactIds trong group dismissed này được skip để không nổi lên lại (lưu hash của tập `contactIds` đã sort).
- **BR-0012:** Merge là **một chiều** (D-0002): không có endpoint undo. Admin chỉ có audit log để truy ngược.

## 4. Input / Output

### Schema mới (`DuplicateGroup`)

Lưu ý: feature này thêm 1 model mới + 2 field vào `Contact`. Schema chính xác do orchestrator chốt khi viết code. Đây là cấu trúc dự kiến:

```prisma
// Cập nhật Contact (thêm 2 field)
model Contact {
  // ...existing fields...
  mergedIntoId   String?   @map("merged_into_id")
  mergedAt       DateTime? @map("merged_at")
  mergedInto     Contact?  @relation("ContactMerges", fields: [mergedIntoId], references: [id])
  mergedChildren Contact[] @relation("ContactMerges")

  @@index([orgId, mergedIntoId])
}

model DuplicateGroup {
  id               String   @id @default(uuid())
  orgId            String   @map("org_id")
  level            String   // 'phone_exact' | 'zaloUid_exact' | 'name_fuzzy'
  confidence       Float
  contactIds       Json     // string[] — sorted ascending, length >= 2
  contactIdsHash   String   @map("contact_ids_hash") // sha1 of sorted ids — dedupe key
  status           String   @default("pending") // pending | merged | dismissed
  primaryContactId String?  @map("primary_contact_id")
  resolvedByUserId String?  @map("resolved_by_user_id")
  resolvedAt       DateTime? @map("resolved_at")
  detectedAt       DateTime @default(now()) @map("detected_at")

  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@unique([orgId, contactIdsHash])
  @@index([orgId, status, detectedAt(sort: Desc)])
  @@map("duplicate_groups")
}
```

### `POST /api/v1/contacts/scan-duplicates`

- **Permission:** owner / admin (member → 403).
- **Body:** `{ levels?: ('phone_exact'|'zaloUid_exact'|'name_fuzzy')[] }` (mặc định tất cả ba mức).
- **Behavior:** chạy đồng bộ với hard timeout 30s. Nếu org có > 5000 contact → trả `{ status: 'queued', jobId }` và spawn async (setTimeout 0). Đây là D-0001.
- **Response 200 (sync):**
  ```json
  {
    "status": "completed",
    "groupsCreated": 12,
    "groupsExisting": 3,
    "contactsScanned": 487,
    "durationMs": 1240
  }
  ```
- **Response 202 (async):** `{ "status": "queued", "jobId": "uuid", "estimatedSeconds": 20 }`.
- **Errors:** 403 (member), 429 (đã có scan đang chạy của org này — chống flood).

### `GET /api/v1/duplicate-groups`

- **Permission:** owner / admin.
- **Query:** `status` (pending|merged|dismissed|all — default `pending`), `level`, `page` (default 1), `limit` (default 50, max 200).
- **Response 200:**
  ```json
  {
    "groups": [
      {
        "id": "...",
        "level": "phone_exact",
        "confidence": 1.0,
        "status": "pending",
        "contactCount": 2,
        "contactsPreview": [
          { "id": "...", "fullName": "Nguyễn Văn A", "phone": "84901234567" },
          { "id": "...", "fullName": "Nguyen Van A", "phone": "+84 901 234 567" }
        ],
        "detectedAt": "..."
      }
    ],
    "total": 12,
    "page": 1,
    "limit": 50
  }
  ```

### `GET /api/v1/duplicate-groups/:id`

- **Permission:** owner / admin. Cross-org → 404.
- **Response 200:** full group + đầy đủ contact rows kèm số đếm:
  ```json
  {
    "id": "...",
    "level": "...",
    "confidence": 0.85,
    "status": "pending",
    "contacts": [
      {
        "id": "...",
        "fullName": "...",
        "phone": "...",
        "email": "...",
        "source": "FB",
        "status": "interested",
        "tags": ["vip"],
        "createdAt": "...",
        "assignedUser": { "id": "...", "fullName": "..." },
        "stats": { "conversations": 2, "orders": 5, "appointments": 1, "notes": 7 }
      }
    ],
    "detectedAt": "...",
    "resolvedAt": null,
    "resolvedBy": null,
    "primaryContactId": null
  }
  ```

### `POST /api/v1/duplicate-groups/:id/merge`

- **Permission:** owner / admin.
- **Body:**
  ```json
  {
    "primaryContactId": "uuid",
    "fieldsToKeep": {
      "fullName": "uuid-of-source-contact",
      "phone": "uuid-of-source-contact",
      "email": "uuid-of-source-contact",
      "source": "uuid-of-source-contact",
      "assignedUserId": "uuid-of-source-contact"
    }
  }
  ```
  - `fieldsToKeep` là optional. Mỗi key tuỳ chọn (`fullName`, `phone`, `email`, `source`, `assignedUserId`). Value phải là một `contactId` thuộc group. Nếu key vắng mặt → giữ field hiện có của primary (BR-0008).
- **Response 200:**
  ```json
  {
    "status": "merged",
    "primaryContactId": "...",
    "mergedContactIds": ["..."],
    "moved": {
      "conversations": 3,
      "orders": 8,
      "appointments": 2,
      "notes": 7,
      "campaignTargets": 1
    }
  }
  ```
- **Errors:**
  - 400 — `primaryContactId` không thuộc group / `fieldsToKeep` chứa id ngoài group / group đã resolved.
  - 403 — member.
  - 404 — group không thuộc org.
  - 409 — group đang được merge bởi admin khác (race — xem BR-0014 ở edge cases).

### `POST /api/v1/duplicate-groups/:id/dismiss`

- **Permission:** owner / admin.
- **Body:** `{ reason?: string (≤ 500 chars) }`.
- **Response 200:** `{ "status": "dismissed", "resolvedAt": "..." }`.
- **Errors:** 400 (đã resolved), 403, 404.

## 5. Edge Cases

- **EC-0001 — Contact ở nhiều nhóm pending cùng lúc:** Contact `C` trùng phone với `A` và trùng tên fuzzy với `B`. Job tạo 2 group khác nhau. Khi admin merge group `(A, C)` với primary `A`, contact `C` được set `mergedIntoId=A` → group `(B, C)` còn lại trở thành "stale". API list **phải auto-cleanup**: khi `GET /duplicate-groups/:id`, lọc bỏ contact có `mergedIntoId != null` khỏi `contacts[]`. Nếu sau filter chỉ còn ≤ 1 contact → auto-mark group `status='dismissed'` với `resolvedByUserId=null` (system).
- **EC-0002 — Primary đang có conversation với cùng zaloAccount như contact phụ:** Theo D-0003, giữ cả 2 conversation, chỉ re-point `contactId`. Hậu quả: trên Customer 360 (0013) sẽ thấy 2 conversation. Acceptable cho MVP.
- **EC-0003 — Concurrency (2 admin merge cùng group):** dùng Prisma `$transaction` với `update where: { id: groupId, status: 'pending' }`. Người về sau nhận update count = 0 → trả 409.
- **EC-0004 — Primary đã bị merge trước đó:** kiểm tra `primary.mergedIntoId != null` → trả 400 với message "Primary đã được gộp vào contact khác".
- **EC-0005 — `CampaignTarget` unique violation:** `@@unique([campaignId, contactId])`. Nếu primary và phụ cùng nằm trong một campaign → re-point sẽ vỡ unique. **Xử lý:** trong transaction, query trước `CampaignTarget` xung đột, **xoá** row của contact phụ (giữ row của primary). Đếm số xoá để báo trong response (`skippedDuplicateTargets`).
- **EC-0006 — `Conversation` unique violation `[zaloAccountId, externalThreadId]`:** nếu một conversation của contact phụ có cùng `(zaloAccountId, externalThreadId)` với conversation của primary → xảy ra cực hiếm (có nghĩa là cùng thread). **Xử lý:** chuyển `messages` + `notes` của conversation phụ sang conversation primary, rồi xoá conversation phụ. Ghi vào response (`mergedConversations`).
- **EC-0007 — Phone normalize ra rỗng (toàn ký tự đặc biệt):** bỏ qua khỏi quét `phone_exact`.
- **EC-0008 — `zaloUid` rỗng / null:** không tham gia mức `zaloUid_exact` (không trùng `null`).
- **EC-0009 — Org quá lớn (> 50k contact):** `name_fuzzy` Levenshtein O(n²) sẽ blow up. **Giải pháp:** pre-bucket theo độ dài tên (`length ± 2`) trước khi so từng cặp. Vẫn worst-case nhưng chấp nhận được cho org dưới 20k. Nếu > 20k contact → BR-skip mức `name_fuzzy`, trả về `groupsCreated` với note.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `POST /scan-duplicates` chạy với 2 contact cùng phone (khác format) → tạo 1 `DuplicateGroup` `level=phone_exact, confidence=1.0`.
- [ ] **AC-0002:** Scan chạy lần 2 không tạo thêm group trùng (idempotent qua `contactIdsHash`).
- [ ] **AC-0003:** 3 contact A/B/C cùng phone → tạo **1 group duy nhất** chứa cả 3 (union-find).
- [ ] **AC-0004:** `GET /duplicate-groups?status=pending` trả list, member nhận 403.
- [ ] **AC-0005:** `POST /:id/merge` với `primaryContactId=A` và phụ là `B`: sau merge, mọi `Conversation.contactId / Order.contactId / Appointment.contactId / ConversationNote (qua conversation)` của B đã trỏ về A; B có `mergedIntoId=A, mergedAt`.
- [ ] **AC-0006:** Sau merge, `GET /api/v1/contacts` (list mặc định) không trả B (vì B có `mergedIntoId`).
- [ ] **AC-0007:** 1 activity log `contact.merged` được ghi cho mỗi contact phụ với `details.mergedInto=primary.id`.
- [ ] **AC-0008:** Body `{ fieldsToKeep: { fullName: 'B.id' } }` → primary A sau merge có `fullName` = giá trị của B.
- [ ] **AC-0009:** Merge concurrency (2 request song song) → 1 thành công (200), 1 trả 409.
- [ ] **AC-0010:** `POST /:id/dismiss` → status `dismissed`. Lần scan sau không tạo lại group có cùng `contactIdsHash`.
- [ ] **AC-0011:** Cross-org: admin org X gọi `/duplicate-groups/:id` của org Y → 404.
- [ ] **AC-0012:** UI: trang `/duplicate-groups` (admin only) liệt kê pending, click vào group → màn so sánh side-by-side với chọn primary + nút "Gộp" / "Bỏ qua". Mọi chuỗi tiếng Việt.
- [ ] **AC-0013:** Build pass (FE + BE), không lỗi TypeScript.

## 7. Dependencies

Module hiện có sẽ bị đụng tới:

- **`backend/src/modules/contacts/`** — thêm `duplicate-routes.ts`, `duplicate-service.ts` (scan + merge), `phone-normalize.ts`, `name-normalize.ts`. Bổ sung filter `mergedIntoId: null` vào các query list/pipeline hiện có trong `contact-routes.ts` và `contact-overview-routes.ts`.
- **`backend/src/modules/conversations/`** — không thay đổi code, nhưng merge service `UPDATE conversations SET contact_id = ?` qua Prisma. Cần test conversation list vẫn hoạt động sau merge.
- **`backend/src/modules/orders/`** — service merge `UPDATE orders SET contact_id = ?`. Endpoint list/report đã filter theo orgId → không cần đổi.
- **`backend/src/modules/contacts/appointment-routes.ts`** — merge service `UPDATE appointments SET contact_id = ?`.
- **`backend/src/modules/conversation-notes/`** — `ConversationNote.conversationId` không đụng tới (note đi theo conversation, conversation đi theo contact). Cascade-correct.
- **`backend/src/modules/activity/activity-service.ts`** — gọi `logActivityAsync` từ merge service (feature 0012 đã có).
- **`backend/src/modules/contacts/contact-overview-routes.ts`** (feature 0013) — đảm bảo `GET /:id/overview` của contact đã `mergedIntoId` trả 410 Gone hoặc redirect-hint `{ mergedInto: primary.id }` để FE biết jump.
- **`backend/src/modules/campaigns/`** — service merge xử lý `CampaignTarget` unique conflict (EC-0005).
- **Prisma schema** — thêm model `DuplicateGroup` + 2 field trên `Contact` (do orchestrator viết khi implement).
- **Frontend** — route mới `/duplicate-groups` (admin guard giống `/activity` của 0012), 1 list view + 1 detail view, link vào sidebar Settings/Admin section.

## 8. Implementation notes

### Cấu trúc backend đề xuất

```
backend/src/modules/contacts/
├── duplicate-routes.ts            # 4 endpoints (scan, list, detail, merge, dismiss)
├── duplicate-service.ts           # scanDuplicates() + mergeContacts() (transactional)
├── duplicate-detection.ts         # pure: detectPhoneGroups, detectUidGroups, detectNameGroups, unionFind
├── phone-normalize.ts             # normalizePhone(raw): string | null
├── name-normalize.ts              # normalizeName(raw): string  (NFD + stripDiacritics + lowercase)
└── levenshtein.ts                 # pure helper, capped at distance ≤ 3 for early exit
```

Routes registered in `backend/src/app.ts` (giống pattern của `contactRoutes`, `webhookDebugRoutes`).

### Nơi chạy job

Theo D-0001 (on-demand mặc định): không thêm cron. Endpoint `POST /scan-duplicates`:
- Org ≤ 5000 contact: chạy sync trong request (predict ~1-2s).
- Org > 5000 contact: spawn `setImmediate(() => scanDuplicates(orgId))` fire-and-forget; trả 202 + jobId.
- Chống flood: cache trong-memory `Map<orgId, runningAt>`. Nếu < 60s từ lần cuối → 429.

### LOC ước lượng

| Khu vực | LOC dự kiến |
|---|---|
| `duplicate-detection.ts` + `phone-normalize.ts` + `name-normalize.ts` + `levenshtein.ts` (pure helpers) | ~250 |
| `duplicate-service.ts` (scan + merge transactional) | ~400 |
| `duplicate-routes.ts` (5 endpoints) | ~250 |
| Schema migration (+ Prisma generate) | ~30 dòng prisma + 1 SQL migration |
| Cập nhật filter `mergedIntoId: null` vào contact-routes / overview-routes | ~50 |
| Frontend: route guard + view list + view detail (Vuetify, 2 file Vue) | ~450 |
| Pinia store + API client | ~120 |
| Tests: unit cho normalizers + Levenshtein + detection + integration cho merge transaction + permission/cross-org | ~500 |
| **Tổng** | **~2,050 LOC** |

### Risk areas (gọi tên rõ)

- **R-HIGH — Cross-conversation merge (EC-0006).** Conversation có unique `[zaloAccountId, externalThreadId]`. Nếu hai contact chia sẻ thread (rất hiếm nhưng có thể nếu zaloUid trùng), phải gộp `messages` + xoá conversation phụ trong cùng transaction. Có thể trigger constraint nếu `Message.id` cascade — cần test kỹ. **Mitigation:** viết integration test rõ ràng cho case này; thêm dry-run mode trong service (`mergeContacts({ dryRun: true })`) để debug.
- **R-MEDIUM — `CampaignTarget` unique (EC-0005)** — phải pre-scan conflict trước UPDATE, không thì transaction abort. Mitigation: query trước, xoá row phụ, rồi update phần còn lại.
- **R-MEDIUM — `name_fuzzy` complexity O(n²)** với org lớn. Mitigation: BR-EC-0009 bucket theo độ dài + skip nếu > 20k contact.
- **R-LOW — Idempotent rescan** — `contactIdsHash` đảm bảo không tạo trùng, nhưng phải nhớ skip cả các hash đã từng bị `dismissed` (BR-0011).
- **R-LOW — Activity log "system" merge cleanup (EC-0001)** — khi auto-dismiss vì contact đã merge ở group khác, ghi log `userId=null` để không gây nhầm "ai dismiss?".

### Risk level tổng thể

**MEDIUM.** Logic detection thuần (pure function, dễ test). Logic merge transactional là phần rủi ro nhất — chủ yếu vì FK rewrite chạm 4 bảng + 2 unique constraint cần xử lý đặc biệt. Không có dependency external mới (không thêm package, không thêm infra).

## 9. Out of scope

- Undo merge / rollback window (D-0002 — quyết định 1-chiều).
- Gộp message thread khi 2 contact chung Zalo thread (D-0003 — giữ cả 2 conversation).
- Suggest primary tự động (heuristic "contact có nhiều order hơn") — MVP để admin tự chọn.
- Bulk merge (gộp nhiều group một lần).
- Auto-merge khi confidence = 1.0 mà không cần admin xác nhận.
- Webhook event `contact.merged` ra ngoài (có thể thêm sau, dùng hook của feature 0014 đã có).
- Quét cross-org (impossible by design — luôn trong cùng org).
