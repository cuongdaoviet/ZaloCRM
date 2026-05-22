# Feature 0054: Typography unification (variant C)

## 1. Mô tả

Trước đây toàn app chạy với 4 cỡ chữ lệch nhau cho cái mà người dùng thấy là "body text":

| Surface | Trước | Vấn đề |
|---|---|---|
| Page title (`<h1 class="text-h5">`) | Vuetify default 22px / 500 | Quá to so với body 14.3, không có weight thống nhất |
| Body text | `--smax-font-base: 14.3px` | OK, nhưng số lẻ |
| Input / Select / Textarea | Vuetify default **16px** | To hơn body, làm input trông như nổi hơn nội dung |
| Sidebar nav item | Vuetify default ~14px nhưng visually nhỏ vì compact density | Cảm giác nhỏ so với title H1 |
| Table cell | Vuetify default 14px (OK), table head 12px | Head quá nhỏ |
| `text-body-1` | Vuetify default **16px** | Lệch khi dùng trong paragraph dài |
| `text-subtitle-1` | Vuetify default **16px** | Lệch |

Người dùng feedback (2026-05-22, qua `/design-shotgun`):
> "font type is not standardize, sidebar font too small not match with others, font size in input are too big, title font too big, looks like there are different text class"

Sau design-shotgun với 3 biến thể HTML side-by-side, user pick **variant C** ("Standard 14/20 — more balance"):
- Title 20px / 600
- Body / input / sidebar / table cell ALL = 14px
- Table head 13px / 600
- Caption / chip 12px
- Stat numbers (KPI cards) = 26px (text-h4)

Ratio title:body = 1.43 (vs 1.54 trước đây).

Approved JSON: `~/.gstack/projects/cuongdaoviet-ZaloCRM/designs/typography-unify-20260522/approved.json`

## 2. Business Rules

- **BR-0001**: `--smax-font-base = 14px` (was 14.3px). Body / input / table cell / sidebar / button đều đọc từ token này → cùng một cỡ duy nhất.
- **BR-0002**: `--smax-font-title = 20px / 600`. Page H1 và `.v-toolbar-title` / `.v-app-bar-title` cùng dùng. Tỷ lệ với body = 1.43.
- **BR-0003**: `--smax-font-small = 13px` (was 12px). Dùng cho table head, helper labels, button size-small.
- **BR-0004**: `--smax-font-tiny = 12px` (was 11px). Dùng cho chip, caption, status pill, button size-x-small.
- **BR-0005**: Mọi Vuetify utility class (`text-h4..h6`, `text-body-1/2`, `text-caption`, `text-subtitle-1/2`, `text-overline`) được override trong `main.css` để map về scale này. Không có default 16px nào lọt ra ngoài.
- **BR-0006**: Stat numbers (KPI cards, campaign stats) dùng `.text-h4` = 26px / 700. Trước đây bị nhầm sang `text-h5` (20px sau override) làm số nhỏ đi.
- **BR-0007**: `.v-card-title` = 16px / 600. Trước default 20px/bold làm dialog title cạnh tranh với page H1.

## 3. Acceptance Criteria

- [ ] **AC-0001**: Trên `/orders`, `/kpi`, `/analytics`, `/dashboard`, `/contacts`, `/chat` — title H1 đều = 20px, weight 600. Đo bằng DevTools.
- [ ] **AC-0002**: Search box, status filter, date picker đều render font 14px (was 16px).
- [ ] **AC-0003**: Sidebar nav row, table row, body text đều render 14px. Đo bằng DevTools.
- [ ] **AC-0004**: KPI cards trên Dashboard + KpiView vẫn hiển thị số to (26px, text-h4) — không bị shrink xuống 20px.
- [ ] **AC-0005**: Dialog title (Tạo đơn, Cập nhật đơn hàng, …) = 16px, không cạnh tranh với page title.
- [ ] **AC-0006**: Không còn `style="font-size:..."` inline nào dưới 12px trong MessageThread (timestamp 0.7rem đã bỏ).
- [ ] **AC-0007**: 258 frontend tests pass. Frontend build green.

## 4. Implementation notes

Files thay đổi:
- `frontend/src/assets/tokens.css` — đổi 3 token + thêm `--smax-font-title`, `--smax-font-title-w`.
- `frontend/src/assets/main.css` — thêm block "Feature 0054 — unified typography scale (variant C)" với 16 rule override Vuetify defaults.
- `frontend/src/views/DashboardView.vue` — 1 stat number `text-h5` → `text-h4`.
- `frontend/src/components/campaigns/CampaignDetailDialog.vue` — 4 stat numbers `text-h5` → `text-h4`.
- `frontend/src/components/chat/MessageThread.vue` — bỏ inline `style="font-size: 0.7rem"` cho timestamp (10px, dưới sàn 12px).

Pattern: thay vì sweep 28 file `<h1 class="text-h5">`, ta override `.text-h5` trong `main.css` để remap về scale mới. Future devs vẫn viết `<h1 class="text-h5">` ra như cũ, nhưng visually nhận đúng 20px / 600 từ token. Centralized control, dễ tinh chỉnh sau.

## 5. What this does NOT change

- Vẫn dùng Plus Jakarta Sans (đã promote ở Feature 0052c).
- Font weight scale (300/400/500/600/700) không đổi.
- Color tokens, spacing, border-radius không đổi.
- MetricCard component không thay đổi behavior — chỉ thay đổi cỡ chữ qua override.
