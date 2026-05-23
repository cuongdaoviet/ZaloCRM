# Feature 0061: Login brand voice (variant C)

## 1. Mô tả

Carry F8 từ design-regrade #2 — `/login` page utilitarian, không có brand voice. Pre-Feature-0057 còn dùng cyan-blue orb (`#00F2FF → #0077B6`) và English tagline "Liquid Silicon • Multi-Account Zalo Management" không match Vietnamese-first product.

Sau khi `/design-shotgun` render 3 hướng (split brand panel / centered + dashboard peek / full gradient + glass form), user pick **variant C — Full gradient + glass form**:
- Diagonal gradient `#4f46e5 → #4338ca → #1e1b4b → #0b0d12` phủ full page
- 2 radial glow accents (indigo-400 + indigo-500) ở góc trên-trái + dưới-phải
- Glass form (white 96% opacity) float ở giữa
- Logo monogram `Z` indigo (thay orb cyan)
- Hero line "Bán hàng qua Zalo, có hệ thống."
- Wordmark `Zalo<indigo-200>CRM</>` text-h4 weight-bold
- Footer: "© 2026 ZaloCRM — CRM cho đội Sales bán hàng qua Zalo"

Approved JSON: `~/.gstack/projects/cuongdaoviet-ZaloCRM/designs/login-brand-20260523/approved.json`

## 2. Business Rules

- **BR-0001**: `AuthLayout.vue` chứa toàn bộ backdrop gradient + glow accents. Class `liquid-bg` legacy được thay bằng `auth-bg`.
- **BR-0002**: Gradient diagonal `135deg`, 4 stops: #4f46e5 0% → #4338ca 32% → #1e1b4b 68% → #0b0d12 100%. Indigo family family hợp với Feature 0057 Slate+Indigo theme.
- **BR-0003**: Glow accents qua `::before` + `::after` pseudo-elements với `filter: blur(80px)`, opacity 0.45, vị trí ngoài viewport (-100 đến -160 px) để soft-frame trung tâm.
- **BR-0004**: `LoginView.vue` hero block (logo + wordmark + tagline) đặt ABOVE the v-card (không phải trong card), text trắng để contrast với gradient.
- **BR-0005**: Form card dùng `background: rgba(255,255,255,0.96)` (gần white solid) + shadow lớn `0 24px 60px rgba(13,12,34,0.45)` để float trên gradient.
- **BR-0006**: SetupView.vue không thay đổi — render với cùng AuthLayout backdrop, plain white v-card float trên indigo, không cần copy/branding (page lần đầu khi setup org).

## 3. Acceptance Criteria

- [ ] **AC-0001**: Vào `/login`, full page là gradient indigo→charcoal, không còn cyan-blue.
- [ ] **AC-0002**: Logo `Z` trong rounded-square indigo, không còn `mdi-robot` icon.
- [ ] **AC-0003**: Hero line "Bán hàng qua Zalo, có hệ thống." hiển thị trắng trên gradient.
- [ ] **AC-0004**: Form card float ở giữa, white 96% opacity, có shadow drop.
- [ ] **AC-0005**: Đăng nhập flow vẫn hoạt động (email + password + button), không break logic.
- [ ] **AC-0006**: Vào `/setup` lần đầu, vẫn render đúng (cùng gradient backdrop, plain white card).
- [ ] **AC-0007**: 258 frontend tests pass + build green.

## 4. Files thay đổi (2)

- `frontend/src/layouts/AuthLayout.vue` — gradient backdrop + glow accents
- `frontend/src/views/LoginView.vue` — full rewrite: glass form + hero + indigo monogram

## 5. Out of scope

- Không thêm "Quên mật khẩu?" link (chưa có flow backend).
- Không animate gradient (intentional — static feels professional, không lấp lánh consumer-y).
- Không thay SetupView (cùng AuthLayout backdrop là đủ).
- Không thêm dark mode variant cho login (page này luôn dùng dark gradient — content áp dụng cho cả light + dark app theme).
