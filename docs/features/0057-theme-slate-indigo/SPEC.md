# Feature 0057: Theme color rewrite — Slate + Indigo

## 1. Mô tả

User feedback (2026-05-22):
> "i need to change dark & light theme color to be more professional, i don't like current cyan color"

Codebase trước đây có 2 theme:
- `smax-light` — primary `#2962ff` (bright Material blue, hơi cyan)
- `legacy-dark` — primary `#00F2FF` (electric cyan), nền navy `#0A192F`, animated gradient + cyan glow + backdrop-blur "liquid morph" effects

Cả 2 đều quá "consumer-y" / loud cho 1 CRM B2B. Cyan trong dark mode đặc biệt visual noise.

Sau khi `/design-shotgun` render 3 hướng professional, user pick **variant A — Slate + Indigo**:
- Light: indigo `#4f46e5` trên nền slate `#f5f6fa`
- Dark: indigo `#818cf8` (lighter cho contrast) trên nền charcoal `#0b0d12`
- Cùng brand color family, chỉ shift lightness — không phải 2 theme tách biệt

Approved JSON: `~/.gstack/projects/cuongdaoviet-ZaloCRM/designs/theme-colors-20260522/approved.json`

## 2. Palette mới

### Light (smax-light)

| Role | Old | New |
|---|---|---|
| primary | `#2962ff` | `#4f46e5` (indigo-600) |
| primary-hover | `#1565c0` | `#4338ca` (indigo-700) |
| primary-soft | `#e3f2fd` | `#eef0ff` (indigo-50) |
| background | `#f5f6fa` | `#f5f6fa` (unchanged) |
| surface | `#ffffff` | `#ffffff` (unchanged) |
| text | `#212121` | `#212121` (unchanged) |

### Dark (legacy-dark — key kept but palette rewritten)

| Role | Old | New |
|---|---|---|
| primary | `#00F2FF` electric cyan | `#818cf8` indigo-400 |
| accent | `#00F2FF` | `#818cf8` |
| background | `#0A192F` navy | `#0b0d12` charcoal |
| surface | `#112240` navy-light | `#14171f` |
| surface-variant | `#1D2D50` | `#1a1e28` |
| border | rgba(0,242,255,0.1) glow | `#232834` flat |
| text | `#E6F1FF` | `#e6e8ee` |

## 3. Business Rules

- **BR-0001**: `--smax-primary` (= Vuetify `primary` ở light) = `#4f46e5`. Cùng giá trị giữa CSS tokens và Vuetify config.
- **BR-0002**: `--smax-primary-soft` = `#eef0ff`. Active row, chip primary, focus ring đều dùng token này.
- **BR-0003**: Dark theme bỏ toàn bộ: animated gradient `flow-bg`, `liquid-morph` border-radius, `ai-core-orb`, cyan box-shadow glow, backdrop-filter blur trên nav drawer + app bar.
- **BR-0004**: Theme key `legacy-dark` được giữ (không đổi sang `smax-dark`) để toggle wiring trong `DefaultLayout` (localStorage 'dark' → 'legacy-dark') không break.
- **BR-0005**: Chat self-bubble dùng `primary-soft` thay vì gradient blue. Contact-bubble dùng surface flat.

## 4. Acceptance Criteria

- [ ] **AC-0001**: Trên `/dashboard`, `/orders`, `/kpi`, `/chat` ở light mode — tất cả button primary, active sidebar row, chip primary đều hiện indigo `#4f46e5`. Không còn blue `#2962ff` nào.
- [ ] **AC-0002**: Bấm sun/moon → dark mode. Background charcoal `#0b0d12`, sidebar indigo active state, không có cyan glow, không có animated gradient background.
- [ ] **AC-0003**: Chat self-bubble (msg user gửi) trong dark mode hiện `--dark-primary-soft` không phải gradient blue.
- [ ] **AC-0004**: 258 frontend tests pass + build green.
- [ ] **AC-0005**: Toggle theme light/dark vẫn hoạt động bình thường (localStorage 'theme' key).

## 5. Files thay đổi (3)

- `frontend/src/assets/tokens.css` — Slate + Indigo brand palette
- `frontend/src/plugins/vuetify.ts` — `smax-light` + `legacy-dark` palette rewrite
- `frontend/src/assets/main.css` — Dark theme stripped of cyan glow + animated gradients, rebuilt with flat charcoal+indigo

## 6. Out of scope

- Không thay đổi semantic colors (success/warning/error/info — chip-blue token).
- Không thay đổi header-bar dark `#1f2330` (vẫn dùng cho tooltip + topbar).
- Không thêm "system" theme (theo OS preference) — vẫn manual toggle.
