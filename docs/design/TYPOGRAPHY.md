# Typography — Scale chính thức

Audit ngày 2026-05-22 phát hiện UI đang render **6 cỡ body khác nhau** (10.7,
11.6, 12.5, 14.3, 16, 17.9px) chỉ vì các component dùng pha trộn `text-caption`,
`text-body-2`, `text-body-1`, `text-h6` và rất nhiều `font-size` inline. Đây là
"tai nạn", không phải scale.

Feature 0052b cố định **6 bậc duy nhất**, dùng class Vuetify chuẩn. Khi cần
thêm text mới — luôn pick 1 trong 6 dưới đây. Đừng tự khai báo `font-size`.

## Scale

| Token   | Class           | Size | Use for                                           |
|---------|-----------------|------|---------------------------------------------------|
| display | `text-h4`       | 28px | Page H1 / hero metric numbers                     |
| heading | `text-h5`       | 22px | Section H2                                        |
| title   | `text-h6`       | 18px | Card title / dialog title                         |
| body    | `text-body-1`   | 16px | Primary body text, form labels, table cells       |
| label   | `text-body-2`   | 14px | Secondary body, chip labels, dropdown items       |
| caption | `text-caption`  | 12px | Timestamps, hints, helper text, badges (12px floor) |

## Forbidden

- `text-caption-2` (11px) — quá nhỏ để đọc trên desktop ở 100% zoom. Nếu chỗ
  đang dùng nó là badge số (1-3 ký tự) thì OK → `text-caption`. Nếu là label
  → `text-body-2`.
- `style="font-size: …"` inline trong template — bypass scale, không grep được.
- `<style>` block khai báo `font-size: 10px / 11px / 0.7rem` cho text.
  Exception duy nhất: emoji button (`ReactionPicker` 18px) — đó là icon-size,
  không phải body text.

## Khi nào dùng inline font-size?

Chỉ 2 case:
1. **Component nội bộ render emoji / icon** mà cần size cụ thể (ví dụ
   `ReactionPicker .reaction-btn { font-size: 18px }` cho emoji).
2. **Badge số trên avatar** (`.conversation-unread-badge { font-size: 11px }`)
   — đây là badge số ≤ 3 ký tự trong vòng tròn 20px, không phải body text. Có
   comment giải thích lý do giữ.

Mọi case khác → dùng class scale.

## Rationale

Single canonical scale → grep-able, predictable, không cần thẩm mỹ "đoán mò"
khi chọn cỡ chữ. 6 bậc đủ phong phú cho dashboard nhưng đủ chật để forces
designer/dev pick có ý.

## Tham chiếu

- Audit 2026-05-22: regrade #1 — 6 sizes rendered.
- Implementation: Feature 0052b.
- SPEC: `docs/features/0052b-typography-scale/SPEC.md`.
