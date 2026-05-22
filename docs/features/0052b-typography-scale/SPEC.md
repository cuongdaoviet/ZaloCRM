# Feature 0052b: Enforce typography scale

## 1. Mô tả

Loại bỏ tình trạng font-size "tự phát" trong toàn bộ frontend (Vue 3 + Vuetify 4).
Audit ngày 2026-05-22 cho thấy 6 cỡ chữ body được render trong UI (10.7, 11.6, 12.5,
14.3, 16, 17.9px) — không phải scale, mà là hệ quả của việc dùng lẫn lộn
`text-caption` / `text-body-2` / `text-body-1` / `text-h6` + nhiều khai báo
`font-size` rời rạc.

Feature này:
1. Cố định một **scale 6 bậc** dùng class Vuetify chuẩn.
2. Bỏ class ngoài scale (`text-caption-2`, 11px tự khai báo).
3. Sửa các trường hợp đã bị user báo cáo: chip lọc trạng thái ở `FriendshipAttemptsView`
   và label/delta ở `KpiView`.
4. Document scale tại `docs/design/TYPOGRAPHY.md` làm "single source of truth".

## 2. User Stories liên quan

- US-0052b-1: As a sale, I want all status chips on the Friendship page to be
  readable at a glance, so that I don't have to lean toward the monitor.
- US-0052b-2: As an engineer, I want one canonical typography scale so I never
  have to guess between `font-size: 0.7rem` and `text-caption`.

## 3. Business Rules

- BR-0001: Mọi text render trong app PHẢI map về 1 trong 6 token của scale.
- BR-0002: Bỏ class `text-caption-2` và mọi `font-size` inline ≤ 11px.
- BR-0003: Không refactor cấu trúc component, không đổi prop contract — chỉ swap
  class / xoá style override redundant.

## 4. Scale (6 bậc)

| Token   | Class         | Size | Use for                                           |
|---------|---------------|------|---------------------------------------------------|
| display | `text-h4`     | 28px | Page H1 / hero metric numbers                     |
| heading | `text-h5`     | 22px | Section H2                                        |
| title   | `text-h6`     | 18px | Card title / dialog title                         |
| body    | `text-body-1` | 16px | Primary body text, form labels, table cells      |
| label   | `text-body-2` | 14px | Secondary body, chip labels, dropdown items      |
| caption | `text-caption`| 12px | Timestamps, hints, helper text, badges            |

Drop: `text-caption-2` (11px). Bump lên `caption` (12px) hoặc `label` (14px) tuỳ
context. Inline `font-size: 11px / 0.65rem / 0.7rem` đều phải bỏ — replace bằng
class scale.

## 5. Acceptance Criteria

- AC-0001: 0 occurrences of `text-caption-2` trong `frontend/src/`.
- AC-0002: 0 occurrences của inline `style="font-size: …"` trong template
  `frontend/src/views|components|layouts/**.vue` (trừ các judgment call có
  comment lý do).
- AC-0003: `frontend/src/views/FriendshipAttemptsView.vue` — chip lọc trạng thái
  có font ≥ 12px.
- AC-0004: `frontend/src/views/KpiView.vue` — label + delta-vs-previous đã được
  ép về scale (text-caption cho label, text-caption cho delta — không có px tự khai báo).
- AC-0005: `docs/design/TYPOGRAPHY.md` tồn tại, mô tả 6-step scale.
- AC-0006: `npm run build` clean, `npm test -- --run` pass 100%.

## 6. Out of Scope

- Vuetify font-family config (scope của 0052c).
- Trích xuất shared MetricCard component (scope của 0052a).
- Backend.

## 7. Dependencies

Không có. Feature CSS-only, chạy độc lập với 0052a / 0052c.
