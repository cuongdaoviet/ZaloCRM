# Feature 0019: CRM tags as proper model

## 1. Mô tả
Hiện tại `Contact.tags` là một mảng JSON các chuỗi tự do — sale gõ tay "VIP",
"vip", "Vip" thì cả ba đều cùng tồn tại, không màu, không nhóm, không sync
được với label gốc của Zalo. Feature này chuyển `tags` từ JSON sang model
quan hệ thực thụ (`CrmTag`, `CrmTagGroup`, `ZaloLabel`) cùng bảng nối
`ContactTag`, kèm một đợt migrate one-shot backfill toàn bộ tag string hiện có
thành row trong `CrmTag` và link lại qua `ContactTag`. Đây là Tier-2 feature
có rủi ro CAO vì migration destructive trên dữ liệu production.

## 2. User Stories liên quan
- **US-0019-1:** Là sale, khi gắn nhãn cho khách, tôi muốn chọn từ danh sách
  nhãn có sẵn (autocomplete) thay vì gõ tay, để tránh tạo nhãn trùng nghĩa
  vì lỗi chính tả ("vip" vs "VIP").
- **US-0019-2:** Là admin, tôi muốn vào "Cài đặt → Quản lý nhãn" để xem toàn
  bộ nhãn của tổ chức, đổi tên, đổi màu, gộp vào group, hoặc lưu trữ nhãn cũ
  không dùng nữa.
- **US-0019-3:** Là admin, tôi muốn pull label gốc của Zalo về CRM thành các
  nhãn `managedBy='zalo_sync'` (read-only), để sale dùng đúng label Zalo đã
  có sẵn (kèm màu + emoji).
- **US-0019-4:** Là sale, khi click vào chip nhãn ở trang Customer 360, tôi
  muốn nhảy sang trang Contacts đã filter sẵn theo nhãn đó.
- **US-0019-5:** Là admin, sau khi migrate, tôi muốn mọi contact giữ nguyên
  bộ nhãn cũ — không có tag nào bị mất, không có contact nào bị orphan.
- **US-0019-6:** Là admin, khi đổi tên nhãn "khach-vip" → "VIP", tôi muốn
  mọi contact đang gắn nhãn này vẫn giữ liên kết (không cần re-tag).

## 3. Business Rules

### Phạm vi & uniqueness
- **BR-0001:** `CrmTag` scope theo `orgId`. Unique trên `(orgId, normalizedName)`
  — KHÔNG unique trên `name` thô.
- **BR-0002:** **Case-folding:** `normalizedName = name.trim().toLowerCase()`
  (NFC normalize). Hai tag "VIP" và "vip" được coi là TRÙNG → tạo cái thứ hai
  bị reject `409 Conflict`. `name` hiển thị vẫn giữ nguyên case người dùng nhập.
- **BR-0003:** `CrmTagGroup` scope theo `orgId`. Unique `(orgId, name)` (case-insensitive).
  Group là tuỳ chọn — tag có thể không thuộc group nào (`groupId = null`).

### Quyền tạo / sửa / xoá
- **BR-0004:** **Tạo tag**: bất kỳ user nào có quyền edit contact đều được
  tạo nhãn mới (vì sale thường cần tag mới ngay khi đang chat, không tiện
  chờ admin). Có thể bật flag `restrictTagCreation` trong org settings để
  giới hạn về owner/admin (Phase 2 — out of scope của 0019).
- **BR-0005:** **Sửa tag (rename, đổi màu, đổi group)**: chỉ owner/admin.
- **BR-0006:** **Lưu trữ tag (archive)**: chỉ owner/admin.
- **BR-0007:** **Quản lý group**: chỉ owner/admin.

### Zalo-sync
- **BR-0008:** Tag với `managedBy='zalo_sync'` là **read-only one-way**: chỉ
  được tạo/cập nhật bởi job `sync-labels` (kéo Zalo → CRM). User không
  được rename, đổi màu, archive, hoặc delete qua API thông thường (`400 ZALO_MANAGED`).
- **BR-0009:** Mỗi `ZaloLabel` row khi sync về sẽ map 1-1 sang một `CrmTag`
  qua `sourceZaloLabelId`. Khi label bị xoá ở Zalo (không còn xuất hiện
  trong response sync), CrmTag tương ứng được **archive tự động** (set
  `archivedAt = now()`) — KHÔNG hard-delete, vì có thể đang gắn vào contacts.
- **BR-0010:** Phase 1 KHÔNG push tag CRM-only lên Zalo. Tag CRM-only chỉ
  tồn tại trong DB của ta.

### Archive vs delete
- **BR-0011:** **Không hard-delete tag** trong v1. `DELETE /crm-tags/:id`
  set `archivedAt = now()` và `isActive = false`. Lý do: contact có thể
  đang gắn — hard-delete sẽ cascade rỗng metadata, mất history.
- **BR-0012:** Tag archive vẫn giữ `ContactTag` rows. UI mặc định ẩn tag
  archive khỏi picker và filter; có toggle "Hiện cả nhãn đã lưu trữ".
- **BR-0013:** Admin có thể **un-archive** (`PUT /crm-tags/:id { archivedAt: null }`).
- **BR-0014:** Khi rename, archive, đổi màu — KHÔNG đụng vào `ContactTag`.
  Liên kết giữ nguyên (FK theo `id`, không theo `name`).

### Default color & metadata
- **BR-0015:** Nếu user không pick màu khi tạo tag, dùng default `#9E9E9E`
  (xám trung tính). Backend validate `color` phải match regex `/^#[0-9A-Fa-f]{6}$/`.
- **BR-0016:** `usageCount` là **denormalized counter** — update mỗi khi
  `ContactTag` được thêm/xoá. Re-sync bằng script `prisma/scripts/recount-tag-usage.ts`
  khi cần.

### Migration & legacy column
- **BR-0017:** **Quyết định**: `Contact.tags` Json giữ lại như **denormalized
  read-cache** (giữ array tên tag) **trong Phase A và B**. Cập nhật mỗi
  khi `ContactTag` thay đổi — qua Prisma middleware hoặc explicit dual-write
  trong service. Drop column ở Phase C riêng biệt sau khi xác nhận
  campaigns + KPI đã đọc từ junction table.
- **BR-0018:** Backfill chạy idempotent — chạy lại 2 lần không tạo dup. Dùng
  `upsert` theo `(orgId, normalizedName)`.

## 4. Input / Output

### Schema (Prisma)

```prisma
model CrmTag {
  id                String    @id @default(uuid())
  orgId             String    @map("org_id")
  name              String    // hiển thị, giữ nguyên case
  normalizedName    String    @map("normalized_name") // lowercase, trimmed
  color             String    @default("#9E9E9E") // hex #RRGGBB
  emoji             String?
  description       String?
  groupId           String?   @map("group_id")
  managedBy         String?   @map("managed_by") // null | 'zalo_sync'
  sourceZaloLabelId String?   @map("source_zalo_label_id") // FK soft → ZaloLabel.id
  order             Int       @default(0)
  isActive          Boolean   @default(true) @map("is_active")
  usageCount        Int       @default(0) @map("usage_count")
  archivedAt        DateTime? @map("archived_at")
  createdAt         DateTime  @default(now()) @map("created_at")
  updatedAt         DateTime  @updatedAt @map("updated_at")

  org          Organization  @relation(fields: [orgId], references: [id], onDelete: Cascade)
  group        CrmTagGroup?  @relation(fields: [groupId], references: [id], onDelete: SetNull)
  contactTags  ContactTag[]

  @@unique([orgId, normalizedName])
  @@index([orgId, isActive, archivedAt])
  @@index([orgId, groupId])
  @@map("crm_tags")
}

model CrmTagGroup {
  id            String    @id @default(uuid())
  orgId         String    @map("org_id")
  name          String
  managedBy     String?   @map("managed_by") // null | 'zalo_sync'
  zaloAccountId String?   @map("zalo_account_id") // set when group mirrors a Zalo account's labels
  order         Int       @default(0)
  archivedAt    DateTime? @map("archived_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  org         Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  zaloAccount ZaloAccount? @relation(fields: [zaloAccountId], references: [id], onDelete: SetNull)
  tags        CrmTag[]

  @@unique([orgId, name])
  @@map("crm_tag_groups")
}

model ZaloLabel {
  id            String   @id @default(uuid())
  orgId         String   @map("org_id")
  zaloAccountId String   @map("zalo_account_id")
  zaloLabelId   String   @map("zalo_label_id") // numeric id from Zalo SDK
  textKey       String   @map("text_key")
  text          String
  color         String
  emoji         String?
  offset        Int      @default(0)
  version       Int      @default(0)
  conversations Json     @default("[]") // string[] of external thread ids
  createTime    BigInt?  @map("create_time")
  syncedAt      DateTime @default(now()) @map("synced_at")

  org         Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  zaloAccount ZaloAccount  @relation(fields: [zaloAccountId], references: [id], onDelete: Cascade)

  @@unique([zaloAccountId, zaloLabelId])
  @@index([orgId])
  @@map("zalo_labels")
}

model ContactTag {
  contactId     String   @map("contact_id")
  tagId         String   @map("tag_id")
  addedAt       DateTime @default(now()) @map("added_at")
  addedByUserId String?  @map("added_by_user_id")

  contact     Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)
  tag         CrmTag  @relation(fields: [tagId],     references: [id], onDelete: Cascade)
  addedByUser User?   @relation(fields: [addedByUserId], references: [id], onDelete: SetNull)

  @@id([contactId, tagId])
  @@index([tagId])
  @@map("contact_tags")
}
```

Reverse relations cần thêm: `Organization.crmTags`, `Organization.crmTagGroups`,
`Organization.zaloLabels`, `ZaloAccount.zaloLabels`, `Contact.contactTags`,
`User.contactTagsAdded`.

### Endpoints

#### `GET /api/v1/crm-tags`
- **Auth:** JWT.
- **Query:**
  - `groupId?: string`
  - `includeArchived?: boolean` (default `false`)
  - `managedBy?: 'zalo_sync' | 'crm'` (`'crm'` = `managedBy IS NULL`)
  - `search?: string` (substring match trên `name`, case-insensitive)
- **Response 200:** array of tag objects with usage counts.

#### `POST /api/v1/crm-tags`
- **Auth:** JWT + quyền edit contact.
- **Body:** `{ name, color?, emoji?, description?, groupId? }`.
- **Errors:** 400 `INVALID_NAME`/`INVALID_COLOR`/`INVALID_GROUP`, 409 `TAG_DUPLICATE` (kèm `existingTagId`).

#### `PUT /api/v1/crm-tags/:id`
- **Auth:** owner/admin only.
- **Errors:** 400 `ZALO_MANAGED` (tag `managedBy='zalo_sync'`), 403, 404, 409.

#### `DELETE /api/v1/crm-tags/:id`
- Soft delete (set `archivedAt`). Idempotent. 400 `ZALO_MANAGED` cho tag Zalo-sync.

#### `GET /api/v1/crm-tag-groups`, `POST /api/v1/crm-tag-groups`
- Tương tự pattern tags. Group là optional namespace.

#### `PUT /api/v1/contacts/:id/tags` *(REPLACES existing endpoint)*
- **Body NEW:** `{ "tagIds": ["uuid", "uuid"] }`.
- **Backward compat Phase A:** chấp nhận cả legacy `{ tags: ["VIP"] }` (string array). Backend tự upsert thành tag rồi convert. Log warning.
- **Behavior:** replace toàn bộ (không phải diff). Diff tính server-side để emit activity log đúng.

#### `POST /api/v1/zalo-accounts/:id/sync-labels`
- Admin only. Gọi Zalo SDK `getLabels()`, upsert `ZaloLabel` + `CrmTagGroup` + `CrmTag` (`managedBy='zalo_sync'`). Label biến mất khỏi Zalo → auto-archive CrmTag tương ứng.

## 5. Migration plan

> **Đây là phần rủi ro CAO nhất của feature.** Migration được tách thành 3 PR
> độc lập (xem §9 Implementation notes — Phase A/B/C).

### Phase A — Schema mới + dual-write (PR #1, an toàn rollback)

**Step A.1:** Migration Prisma `0019_crm_tags_models`
- `CREATE TABLE crm_tag_groups, crm_tags, zalo_labels, contact_tags`
- Indexes + FKs + reverse relations
- **KHÔNG** chạm `contacts.tags` (vẫn là Json column)

**Step A.2:** Service layer dual-write
- `PUT /contacts/:id/tags` mới: ghi cả `ContactTag` rows VÀ `contact.tags` JSON
  (string array của tag names) để campaigns/KPI hiện tại không vỡ.
- `keyword-rule-service.ts` `applyRule()`: khi `addTag`, upsert `CrmTag` theo
  name rồi tạo `ContactTag`, đồng thời append vào `contact.tags` JSON.

**Step A.3:** Endpoints CRUD + sync-labels release.

**Rollback:** Drop 4 bảng mới, revert service layer. `contact.tags` JSON
chưa bị đụng đến nên data nguyên vẹn.

### Phase B — Backfill (PR #2, chạy 1 lần)

**Step B.1: Pre-flight script** `prisma/scripts/0019-preflight-tags.ts`
- Query: số contact có tags non-empty, số tag string unique per org,
  số string có ký tự lạ, số null/empty/invalid JSON.
- Output report `0019-preflight-report.json` cho admin xem trước khi chạy.
- KHÔNG modify gì.

**Step B.2: Backfill script** `prisma/scripts/0019-backfill-tags.ts`
- Chạy per-org để tránh long transaction.
- Idempotent: rerun chỉ thêm row mới, không dup.
- Có cờ `--dry-run`.

**Step B.3:** Sau backfill thành công, **switch read path**:
- `GET /contacts/:id/overview` và `ContactFilters` đọc tags từ `ContactTag` join
  thay vì JSON. Junction table trở thành source-of-truth.
- Dual-write vẫn duy trì 1 release để có thể rollback nhanh.

**Rollback Phase B:**
- Transaction per-org rollback. Các org đã xong vẫn OK (idempotent).
- Nếu phát hiện data sai: TRUNCATE `contact_tags` + chạy lại backfill.
- Vì `contact.tags` JSON còn nguyên, luôn có nguồn để rebuild.

### Phase C — Drop legacy column (PR #3, sau ≥ 1 sprint quan sát)

**Step C.1:** Migration `0019_drop_contact_tags_json`
- `ALTER TABLE contacts DROP COLUMN tags;`

**Step C.2:** Remove dual-write code. Update campaigns/KPI/keyword-rules
để query qua `ContactTag` join.

**Step C.3:** Update `campaign-helpers.ts` filter `tags` → `tagIds` (UUID array).

**Rollback Phase C:** add column lại + reverse backfill (SQL trong runbook).

## 6. Edge Cases

- **Hai contact cùng tag string "vip":** backfill tạo 1 row `CrmTag` + 2 `ContactTag` rows.
- **Case variants `"vip"`, `"VIP"`, `"Vip"`:** backfill upsert vào CÙNG `CrmTag` (chọn case đầu tiên gặp làm `name` hiển thị). Log warning.
- **Tag string trùng với Zalo label đã sync:** chạy backfill TRƯỚC, sync sau.
- **`contact.tags = null`:** coerce sang `[]`, skip.
- **`contact.tags = [""]` hoặc whitespace:** trim, skip empty entries.
- **`contact.tags` chứa item không phải string:** skip + log vào report.
- **Tag string > 50 ký tự:** truncate về 50 + log warning.
- **Rename tag "vip" → "VVIP":** chỉ update name + normalizedName. ContactTag liên kết qua tagId không đụng.
- **Archive tag đang dùng:** vẫn cho phép. Contact giữ liên kết. UI default ẩn.
- **Sync Zalo khi tag "VIP" CRM-only đã tồn tại:** Zalo sync adopt tag đó (set managedBy + sourceZaloLabelId). Document trong UX.

## 7. Acceptance Criteria

### Backend CRUD
- [ ] **AC-0001:** POST tag "VIP" + color hợp lệ → 201, normalizedName='vip'.
- [ ] **AC-0002:** POST "vip" sau khi đã tạo "VIP" → 409 `TAG_DUPLICATE` kèm `existingTagId`.
- [ ] **AC-0003:** POST với color "#XYZ" → 400 `INVALID_COLOR`.
- [ ] **AC-0004:** PUT trên tag `managedBy='zalo_sync'` → 400 `ZALO_MANAGED`.
- [ ] **AC-0005:** DELETE set `archivedAt`, không xoá row. Idempotent.
- [ ] **AC-0006:** Member gọi PUT → 403.

### ContactTag
- [ ] **AC-0007:** PUT `{ tagIds: [A, B] }` → contact có đúng 2 link, usageCount tăng.
- [ ] **AC-0008:** Replace `{ tagIds: [A] }` → B bị gỡ, usageCount(B) giảm.
- [ ] **AC-0009:** Gán tagId của org khác → 400 `INVALID_TAG_ID`.
- [ ] **AC-0010:** Gán tag đã archive → 400 `TAG_ARCHIVED`.
- [ ] **AC-0011:** Legacy body `{ tags: ["VIP"] }` Phase A → tự upsert + tạo link.

### Zalo sync
- [ ] **AC-0012:** sync-labels lần đầu → tạo CrmTagGroup + CrmTag + ZaloLabel rows.
- [ ] **AC-0013:** Sync sau khi 1 label bị xoá ở Zalo → CrmTag auto-archive.
- [ ] **AC-0014:** Member gọi sync-labels → 403.

### Migration
- [ ] **AC-0015:** Backfill trên 1000 contacts × ~5 tag string → tạo đúng CrmTag unique và ContactTag rows.
- [ ] **AC-0016:** Chạy backfill lần 2 → 0 row mới (idempotent).
- [ ] **AC-0017:** Sau backfill, usageCount = COUNT từ ContactTag.
- [ ] **AC-0018:** Contact có `tags = null` hoặc `[""]` → bỏ qua, không lỗi.
- [ ] **AC-0019:** Pre-flight script không modify, trả report đầy đủ.

### Frontend
- [ ] **AC-0020:** ContactDetailDialog: text input → v-autocomplete multi-select.
- [ ] **AC-0021:** Customer360View chip có click → navigate `/contacts?tagIds=<id>`.
- [ ] **AC-0022:** Settings page "Quản lý nhãn" hiển thị tất cả tag + group, admin only.
- [ ] **AC-0023:** Build pass: backend tsc + frontend vue-tsc + vite.

## 8. Frontend impact

### Components đổi
- **`ContactDetailDialog.vue`** — text input → `<v-autocomplete multiple>` từ `useCrmTags()`. Tạo tag mới on-the-fly.
- **`ChatContactPanel.vue`** — extract thành reusable `TagPicker.vue`.
- **`Customer360View.vue`** — chip render `:color="tag.color"` + emoji. Click → router navigation với `tagIds` query.
- **`ContactFilters.vue`** — filter array string → multi-select tag picker, gửi `tagIds[]`.
- **`CampaignCreateDialog.vue`** — tab "Tags" đổi từ free-text → tag picker. Filter snapshot lưu `tagIds`.

### Components mới
- **`TagPicker.vue`** — reusable autocomplete với tạo mới, color + emoji rendering.
- **`TagChip.vue`** — chip render màu + emoji + name.
- **`SettingsTagsView.vue`** — route `/settings/tags`. List + edit/archive, group management tab, Zalo-sync tab.

### Composables mới
- **`use-crm-tags.ts`**, **`use-crm-tag-groups.ts`** — module-level reactive cache.

### Routing
- `/settings/tags` (children: tags, groups, zalo-sync). Guard owner/admin.

## 9. Implementation notes

### LOC estimate

| Phase | Area | LOC |
|-------|------|-----|
| A | Schema migration | ~80 |
| A | Backend routes (crm-tags, groups, sync-labels) | ~600 |
| A | Service layer (tag-service, dual-write, usageCount) | ~400 |
| A | Update `PUT /contacts/:id/tags` (new + legacy) | ~150 |
| A | Update `keyword-rule-service.applyRule` (dual-write) | ~50 |
| A | Zalo bridge `getLabels` wrapper | ~80 |
| A | Frontend TagPicker/TagChip + composables | ~500 |
| A | Frontend SettingsTagsView + sub-tabs | ~700 |
| A | Frontend updates (5 existing files) | ~400 |
| A | Integration tests | ~400 |
| A | Unit tests | ~200 |
| B | Pre-flight + backfill scripts | ~300 |
| B | Migration integration test | ~250 |
| B | Read-path switch | ~150 |
| C | Drop column migration | ~10 |
| C | Remove dual-write, update queries | ~200 |
| | **Total** | **~4,470 LOC** |

### Risk ranking

| Risk | Mức độ | Mitigation |
|------|--------|------------|
| Backfill làm mất hoặc nhân đôi tag references | **HIGH** | Idempotent upsert + unique constraint + per-org transaction. Pre-flight dry-run. Giữ JSON cache ≥ 1 sprint. |
| Drop column Phase C trước khi tất cả query đã migrate | HIGH | Tách thành PR riêng, deploy sau ≥ 1 sprint. Grep audit cho `contact.tags` trước. |
| Case-collision khi backfill | MEDIUM | Document trong pre-flight report, admin review. Rename sau qua UI. |
| Zalo sync conflict với CRM-only tag cùng tên | MEDIUM | Document "adopt" behavior. Admin có thể rename trước nếu muốn tách. |
| Performance regression | LOW | Index trên junction. Dual-write fallback. |
| Frontend break do schema body đổi | MEDIUM | Backend chấp nhận cả legacy lẫn mới trong Phase A. Remove ở Phase C. |
| Campaigns filter snapshot lưu tagIds cũ khi tag archive | LOW | Filter resolver tolerate missing/archived. |

### Suggested rollout

**Mạnh mẽ khuyến nghị: SPLIT thành 3 PR.**

| PR | Nội dung | Rollback an toàn? |
|----|---------|-------------------|
| **Phase A** | Schema + endpoints + frontend + dual-write. KHÔNG migrate data cũ. | ✅ Drop 4 bảng mới, revert FE/BE. |
| **Phase B** | Pre-flight + backfill + switch read path. Dual-write vẫn chạy. | ✅ TRUNCATE junction, switch read về JSON. |
| **Phase C** | Drop column + remove dual-write + update queries. | ⚠️ Rollback cần re-add column + reverse SQL backfill. |

**Lý do split:**
1. Destructive migration trên prod — không có "undo" cho 1 PR duy nhất chứa cả schema + backfill + drop column.
2. Quan sát được giữa các phase — Phase A ship, 3 ngày quan sát log, Phase B, quan sát tiếp, Phase C.
3. Feature flag không khả thi với schema — nhưng phase splitting đạt mục tiêu giảm blast radius.
4. Backfill có thể chạy off-peak độc lập.

### Out of scope (Phase 1)
- Push tag CRM-only lên Zalo (CRM → Zalo direction).
- Tag hierarchy (parent/child).
- Per-user tag visibility.
- Bulk tag operations.
- ML auto-categorize.
- Webhook outbound cho tag CRUD.
