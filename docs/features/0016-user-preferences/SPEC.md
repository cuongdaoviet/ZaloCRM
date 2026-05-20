# Feature 0016: User preferences KV store

## 1. Mô tả
UI hiện chỉ lưu sở thích người dùng (theme, mật độ, sidebar, bộ lọc gần nhất)
vào `localStorage` — không follow user khi đổi thiết bị/đăng nhập máy khác.

Tính năng này thêm 1 bảng KV phẳng `user_preferences` để FE persist preferences
server-side. **Quyết định thiết kế quan trọng:** giá trị là JSON tuỳ ý
(string/number/object/array), validate theo **danh sách khoá cho phép**, không
theo shape — tránh phải tạo migration mỗi lần FE muốn lưu thêm 1 setting nhỏ.

## 2. User Stories liên quan
- US-0016-1: Là sale, tôi đổi theme sang light ở laptop, mở Zalo CRM trên máy
  nhà sau đó, vẫn thấy theme light (không phải dark mặc định).
- US-0016-2: Là sale, tôi lưu bộ lọc danh sách contact đang dùng (status, source)
  → lần sau mở contacts vẫn thấy bộ lọc cũ.
- US-0016-3: Là dev FE, tôi muốn thêm 1 preference mới (ví dụ "ẩn cột giá trên
  dashboard") chỉ bằng cách thêm khoá vào `ALLOWED_KEYS` rồi gọi `usePref()`.

## 3. Business Rules
- BR-0001: Mọi preference scope theo `userId` của người gọi. Không leak qua
  user khác (kể cả cùng org).
- BR-0002: Validate **theo allowlist khoá** (`ALLOWED_KEYS`), không theo giá
  trị. Cho phép lưu string/number/object/array/null.
- BR-0003: Khoá phải match regex `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/`
  (snake_case dotted namespaces). Khoá hợp lệ nhưng không có trong allowlist
  vẫn bị reject — chặn typo trở thành dữ liệu rác âm thầm.
- BR-0004: Giá trị (sau JSON.stringify) ≤ 4096 ký tự. Vượt → 400.
- BR-0005: DELETE idempotent — gọi 2 lần cùng khoá vẫn trả 204, không lỗi.
- BR-0006: PUT là upsert. Cập nhật `updatedAt` mỗi lần ghi (Prisma `@updatedAt`).
- BR-0007: GET map trả về `{ [key]: value }` rỗng `{}` khi user chưa có
  preference nào.
- BR-0008: Không có realtime sync giữa các thiết bị — FE fetch 1 lần lúc app
  load. App có thể opt-in `reloadPreferences()` (vd: trên window focus).

## 4. Schema

```prisma
model UserPreference {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  key       String
  value     Json     @default("null")
  updatedAt DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, key])
  @@map("user_preferences")
}
```

Back-reference trên `User`: `preferences UserPreference[]`.

Model được thêm ở **cuối** `schema.prisma` trong block `─ Feature 0016 ─` để
hạn chế xung đột merge với các nhánh khác đang sửa schema.

## 5. API

| Method | Path | Mục đích |
|--------|------|----------|
| GET | `/api/v1/me/preferences` | Map `{ [key]: value }` của caller. `{}` nếu chưa set. |
| GET | `/api/v1/me/preferences/:key` | `{ key, value }` hoặc 404. |
| PUT | `/api/v1/me/preferences/:key` | Body `{ value: <any JSON> }`. Upsert. Trả row. |
| DELETE | `/api/v1/me/preferences/:key` | Idempotent. 204. |

Auth: `authMiddleware` (JWT). Không cần check `orgId` vì
`userId = req.user.id` đã khoá row theo caller.

### Allowed keys (initial)
```
ui.theme
ui.density
ui.sidebar_collapsed
ui.sound_on
chat.default_account_filter
contacts.last_filter
dashboard.refresh_interval
```

### Mã lỗi
- `400 Key không hợp lệ` — khoá malformed hoặc không trong allowlist.
- `400 Body phải có field value` — PUT thiếu field `value`.
- `400 Giá trị vượt quá 4096 ký tự` — sau JSON.stringify quá to.
- `404 Không tồn tại` — GET 1 key chưa được set (hoặc khoá invalid).

## 6. Edge Cases
- PUT `{ value: null }` → lưu `null` (cho phép explicit clear).
- PUT `{ value: undefined }` → coerce sang `null` (Prisma JSON không nhận
  `undefined`).
- DELETE key invalid (vd `UI.theme`) → vẫn 204 (idempotent, key không thể
  tồn tại trong DB nên không cần báo lỗi).
- GET 1 key invalid → 404 (cùng response như "chưa set" để không leak shape
  của allowlist).
- Cùng `(userId, key)` upsert nhiều lần → `id` không đổi, `updatedAt` tăng,
  chỉ 1 row.
- Cross-user: user A PUT, user B GET cùng key → user B vẫn nhận `{}` /
  404. (Có integration test.)

## 7. Acceptance Criteria
- [ ] AC-0001: GET map trống → `{}` khi chưa set.
- [ ] AC-0002: PUT rồi GET round-trip giá trị string + object.
- [ ] AC-0003: PUT key ngoài allowlist → 400.
- [ ] AC-0004: PUT key malformed (uppercase, leading digit, ...) → 400.
- [ ] AC-0005: PUT value > 4096 chars → 400.
- [ ] AC-0006: DELETE + DELETE lại → cả 2 đều 204.
- [ ] AC-0007: Cross-user isolation.
- [ ] AC-0008: Upsert update giá trị + `updatedAt`, không tạo row mới.
- [ ] AC-0009: FE `usePref()` debounce 300ms ghi server.
- [ ] AC-0010: FE `toggleTheme()` migrated sang `usePref('ui.theme', ...)`,
      vẫn keep `localStorage` làm fast-path read tránh flash.

## 8. Frontend

`frontend/src/composables/use-user-preferences.ts`:
- Module-level state share giữa caller — 2 component bind cùng key thấy cùng ref.
- Fetch lazy 1 lần ở first call. `reloadPreferences()` re-fetch.
- `usePref<T>(key, defaultValue)` trả `Ref<T>` two-way:
  - Read: seed từ default → khi fetch xong nếu key có trong cache thì gán lại.
  - Write: deep-watch ref, debounce 300ms, PUT lên server.
- `flushPreferences()` flush ngay các debounced PUT đang pending.
- Lỗi network khi ghi → log + nuốt (không break UI).

Migrate: `DefaultLayout.vue#toggleTheme` chuyển từ `localStorage`-only sang
`usePref('ui.theme', initialFromLocalStorage)`. `localStorage` vẫn được mirror
mỗi lần đổi để initial render không flash trước khi API trả về.

## 9. Test plan
- **Unit** (`tests/unit/user-preference-helpers.test.ts`):
  - `validateKey`: allowlist pass, malformed reject, well-formed-but-not-allowed
    reject, non-string reject.
  - `validateValueSize`: short pass, at-cap pass, over-cap reject, big object
    reject, null/undefined pass.
- **Integration** (`tests/integration/user-preferences.integration.test.ts`):
  - Empty GET → `{}`.
  - PUT then GET (string + complex object).
  - PUT key ngoài allowlist → 400.
  - PUT key malformed (uppercase, digit-leading) → 400.
  - PUT value > 4096 → 400.
  - PUT body thiếu `value` → 400.
  - GET single key chưa set → 404.
  - DELETE rồi DELETE → 204 + 204.
  - Cross-user isolation.
  - Upsert giữ id, tăng `updatedAt`.

## 10. Out of scope (cho lần ship đầu)
- Realtime push từ server cho preferences đổi ở tab khác.
- Diff/merge khi 2 tab cùng ghi cùng key (last-write-wins là đủ).
- Migration tự động khi đổi shape của 1 key (caller tự xử lý compat).
- Export/import preferences profile.
- Audit log cho preference changes (KV này thay đổi rất nhiều, log sẽ noise).

## 11. Dependencies
- Bảng `users` (đã có) — FK `user_id` cascade delete.
- `authMiddleware` (đã có).
