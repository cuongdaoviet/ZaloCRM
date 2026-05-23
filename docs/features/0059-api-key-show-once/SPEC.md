# Feature 0059: API key "show once" UX

## 1. Mô tả

Sau khi #125 fix field-name mismatch, `/api-settings` đã hiển thị đúng plaintext khi click "Tạo key mới". Nhưng pattern hiển thị còn vấn đề:

1. Backend `GET /settings/api-key` trả về masked indicator — **đó là 1 fragment của SHA-256 hash**, không phải plaintext (xem `webhook-settings-routes.ts:115`). User reload page sẽ thấy `zcrm_aB3xK9...****HASH` — copy nó vào integration sẽ luôn 401 vì đó là hash của key chứ không phải key.
2. Component dùng cùng `apiKey` ref cho cả plaintext-fresh (sau POST) lẫn masked-loaded (sau GET) → copy icon luôn hiện → user không phân biệt được "copy này được" vs "copy này vô dụng".
3. Nút "Tạo key mới" không cảnh báo gì khi đã có key → user vô tình invalidate key đang dùng cho integration sản xuất.

Industry pattern (Stripe, GitHub, OpenAI):
- **Plaintext shown once**, with banner "Copy now — last time you'll see this"
- **On reload**: just an existence indicator, no copy icon (vì không có gì usable để copy)
- **Regenerate is destructive** → confirm dialog với warning "current key sẽ ngừng hoạt động ngay"

## 2. Business Rules

- **BR-0001**: API Key card có 3 trạng thái driven bởi 1 ref `keyState: 'none' | 'fresh' | 'exists'`.
  - `none`: chưa có key trong DB → empty state + CTA "Tạo API key"
  - `fresh`: vừa POST `/generate` thành công → hiển thị plaintext + copy icon + warning banner
  - `exists`: load từ GET, key có sẵn → hiển thị "Đã có 1 API key" + CTA "Tạo key mới (vô hiệu hoá key cũ)"
- **BR-0002**: Trong state `exists`, KHÔNG bind masked value vào input và KHÔNG render copy icon (vì mask là hash fragment, copy ra cũng vô dụng).
- **BR-0003**: Regenerate trong state `exists` luôn đi qua confirm dialog với cảnh báo: "Hành động này sẽ vô hiệu hoá ngay lập tức API key hiện tại. Mọi tích hợp đang dùng key cũ sẽ trả về 401 Unauthorized."
- **BR-0004**: Regenerate trong state `none` (chưa có key) hoặc `fresh` (vừa tạo) không cần confirm — không có key cũ để mất.
- **BR-0005**: Warning banner trong state `fresh` phải nổi bật (Vuetify `v-alert type="warning"`), text rõ ràng "Đây là lần duy nhất bạn nhìn thấy".

## 3. Acceptance Criteria

- [ ] **AC-0001**: Org chưa có key — vào `/api-settings`, thấy "Chưa có API key nào cho tổ chức này" + nút "Tạo API key" (primary).
- [ ] **AC-0002**: Click "Tạo API key" lần đầu — alert vàng hiện ra "Sao chép key ngay…" + field hiển thị plaintext `zcrm_...` + copy icon ở góc phải.
- [ ] **AC-0003**: Click copy icon — clipboard nhận plaintext, toast "Đã sao chép API key".
- [ ] **AC-0004**: Reload trang sau khi vừa tạo — alert + field biến mất, thay bằng "Đã có 1 API key cho tổ chức này. Plaintext không thể hiển thị lại." + nút "Tạo key mới (vô hiệu hoá key cũ)".
- [ ] **AC-0005**: Click "Tạo key mới" trong state `exists` — modal confirm hiện với warning. Click "Huỷ" → đóng modal, không tạo. Click "Tạo key mới" → tạo, modal đóng, view chuyển sang state `fresh` với plaintext mới.
- [ ] **AC-0006**: Không có path nào trong UI hiển thị masked hash fragment cho user.

## 4. Files thay đổi (2)

- `frontend/src/views/ApiSettingsView.vue` — toàn bộ logic + UI changes
- `docs/features/0059-api-key-show-once/SPEC.md` — file này

## 5. Why this is not "premature polish"

Trước fix này, user có thể:
1. Tạo key, copy plaintext, paste vào integration → OK
2. Hôm sau quay lại trang để verify → thấy field hiển thị `zcrm_aB3****HASH_FRAG`, copy nó để paste vào 1 server khác → integration mới sẽ luôn 401 vì copy nhầm hash fragment
3. Confuse, click "Tạo key mới" để thử lại → invalidate luôn key cũ đang chạy production → mọi integration sống xuống cùng lúc

Pattern "show once + destructive confirm" là chuẩn bảo mật cho API key UX. Implementation 30 phút, blast radius 1 file.
