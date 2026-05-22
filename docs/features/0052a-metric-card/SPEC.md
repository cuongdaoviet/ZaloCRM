# Feature 0052a: Shared `MetricCard.vue` + refactor 4 KPI surfaces

## 1. Mô tả

App đang render cùng một pattern "metric card" (con số to + label nhỏ,
đôi khi có delta) ở 4 chỗ khác nhau, mỗi chỗ implement inline với style
hơi lệch:

1. `KpiCards.vue` — Dashboard, 6 ô KPI (sạch nhất, đã bỏ icon-trong-vòng-tròn
   ở Feature 0049 F13).
2. `OrdersView.vue` — 4 ô stats với `mdi-cart` / `mdi-check-circle` / `$` /
   `calendar` icon trong card. Đây là pattern "icon-in-card" AI-slop đã bị
   Dashboard loại bỏ nhưng còn sót lại ở Orders.
3. `KpiView.vue` — 6 ô KPI có thêm dòng delta-vs-previous-period
   ("+353.9%" / "— —" + "so với kỳ trước"). Delta line cũng inconsistent.
4. `SettingsAiConfigView.vue` — panel "Sử dụng" bên phải, render dạng
   row (label trái — số phải), không phải card grid.

Hậu quả: 4 màn hình trông khác nhau dù về mặt thông tin chỉ là cùng một
thứ — "một con số + caption". User feedback: trông unprofessional, thiếu
nhất quán.

Feature này extract một component canonical `MetricCard.vue` và refactor
3/4 màn hình về dùng nó. Riêng SettingsAiConfigView panel "Sử dụng" giữ
nguyên vì nó là row-layout (left-label / right-number) chứ không phải
card grid — wrap nó vào MetricCard sẽ phá layout của panel chứ không
fix gì.

## 2. User Stories liên quan

- US-0055: Là một sale rep / admin, khi tôi đi qua Dashboard, Orders,
  KPI page, tôi muốn thấy các con số metric trông giống nhau về font
  weight, spacing, alignment — để cảm thấy app được làm chỉn chu, không
  lệch lạc.
- US-0056: Là một developer trên codebase, khi tôi cần thêm một metric
  surface mới, tôi muốn import một component có sẵn thay vì copy/paste
  cả khối card từ một view khác.

## 3. Business Rules

- **BR-0001 — Canonical shape.** Card outlined Vuetify, padding 16px,
  số là `text-h4 font-weight-bold tabular-nums`, label là
  `text-caption text-medium-emphasis`. Không icon trong card mặc định.
  Không left-border màu, không gradient, không icon-trong-vòng-tròn (AI-slop blacklist #2 và #8).
- **BR-0002 — Optional `attentionColor`.** Khi caller pass vd. `warning`,
  text của `value` thêm class `text-warning`. KpiCards dùng cho "Chưa
  trả lời" + "Chưa đọc" khi > 0.
- **BR-0003 — Optional `delta` block.** Khi pass, render thêm 1 dòng
  caption phía dưới label: text (vd. "+353.9%"), optional color
  (success/error/grey neutral), optional suffix (vd. " so với kỳ
  trước"). Không render gì khi delta = undefined.
- **BR-0004 — `#prepend` slot cho icon ngoại lệ.** Caller nào muốn 1
  icon nhỏ phía trên (vd. trang Orders trong tương lai) thì slot vào,
  không bake icon vào component.
- **BR-0005 — Tabular nums bắt buộc.** Số trong cột phải line up về
  digit width → `font-variant-numeric: tabular-nums`. Đây là lý do
  CSS sống trong component chứ không global.
- **BR-0006 — Refactor scope.**
  - `KpiCards.vue` → thay inline với `<MetricCard>`. Pass
    `attentionColor` cho 2 metric cảnh báo. Visual diff = 0 (reference).
  - `OrdersView.vue` → bỏ 4 icon `mdi-cart` / `mdi-check-circle` /
    `mdi-currency-usd` / `mdi-calendar-today` và colored squares. Refactor
    về `<MetricCard>` thuần text.
  - `KpiView.vue` → bỏ left-border `border-left: 3px solid` (AI-slop),
    refactor 6 card về `<MetricCard>`, đẩy delta vào prop `delta` của
    component để có 1 cách render duy nhất.
  - `SettingsAiConfigView.vue` → KHÔNG refactor. Panel "Sử dụng" là
    row-layout (text-trái / số-phải), không phải card grid. Wrap vào
    MetricCard sẽ phá layout. Decision document hoá ở mục 5.

## 4. Input / Output

### Component prop contract

```ts
defineProps<{
  value: string | number;          // Số / chuỗi đã format. Render text-h4 bold tabular-nums.
  label: string;                   // Caption ngắn dưới số.
  attentionColor?: string;         // Vuetify color name. Set thành class text-{color} cho số.
  delta?: {
    text: string;                  // "+353.9%" / "— —"
    color?: string;                // "success" / "error" / undefined (neutral grey)
    suffix?: string;               // " so với kỳ trước"
  };
}>();
```

Slot: `#prepend` — render trên số nếu caller cần.

### Output (rendered DOM)

```html
<v-card variant="outlined">
  <v-card-text class="pa-4">
    <!-- optional #prepend -->
    <div class="text-h4 font-weight-bold metric-value [text-{attentionColor}]">
      {{ value }}
    </div>
    <div class="text-caption text-medium-emphasis metric-label">
      {{ label }}
    </div>
    <!-- if delta -->
    <div class="d-flex align-center text-caption metric-delta">
      <span class="[text-{delta.color}]">{{ delta.text }}</span>
      <span v-if="delta.suffix" class="text-medium-emphasis ml-1">{{ delta.suffix }}</span>
    </div>
  </v-card-text>
</v-card>
```

## 5. Edge Cases / Decisions

- **`SettingsAiConfigView.vue` "Sử dụng" panel:** giữ nguyên row-layout.
  Lý do: panel này là 4 dòng `label-trái / value-phải` xếp dọc trong 1
  card duy nhất, không phải 4 card riêng. Pattern đúng ở đây là
  description-list (`<dl>`), không phải metric grid. Wrap vào MetricCard
  4 lần sẽ tạo ra 4 card chồng lên nhau trong 1 col-md-5 — vỡ visual
  hierarchy.
- **`value` accept string | number:** caller có thể pre-format (vd.
  `formatVND(123)` trả string `"123 ₫"`), component không cố parse.
- **`attentionColor` không validate enum:** Vuetify resolve class
  `text-warning`, `text-success`, `text-error` etc. tự nó. Pass string
  tự do — sai thì developer thấy ngay khi visual review.
- **`delta` không thay thế icon arrow:** spec cũ của KpiView có
  `mdi-arrow-up` / `mdi-arrow-down`. Bỏ — chữ `+` / `-` trong text
  đã đủ semantic và bớt 1 mức visual noise.

## 6. Acceptance Criteria

- [ ] AC-0001: `MetricCard.vue` tồn tại tại
      `frontend/src/components/shared/MetricCard.vue` với prop contract
      đúng như mục 4.
- [ ] AC-0002: Test unit `MetricCard.test.ts` ≥ 5 case (value+label,
      attentionColor → class, delta render/hide, delta.color → class,
      `#prepend` slot).
- [ ] AC-0003: `KpiCards.vue` import + dùng `<MetricCard>` cho 6 ô.
      Visual identical sau refactor.
- [ ] AC-0004: `OrdersView.vue` không còn `<v-icon>` trong 4 stats card.
      Dùng `<MetricCard>` thay thế.
- [ ] AC-0005: `KpiView.vue` dùng `<MetricCard>` với prop `delta`. Không
      còn `border-left: 3px` rule.
- [ ] AC-0006: `SettingsAiConfigView.vue` KHÔNG đổi (decision document
      hoá tại mục 5).
- [ ] AC-0007: `cd frontend && npm run build` xanh.
- [ ] AC-0008: `cd frontend && npm test -- --run` xanh, count ≥ 249 + new tests.

## 7. Dependencies

- Vuetify 4 typography classes (`text-h4`, `text-caption`,
  `text-medium-emphasis`, `text-{color}`).
- Feature 0049 F13 (Dashboard removed icon-in-circle) — định nghĩa
  shape canonical.

## 8. Implementation order

1. Tạo `MetricCard.vue` ở `components/shared/`.
2. Viết test `MetricCard.test.ts`.
3. Refactor `KpiCards.vue` (reference shape, dễ nhất, kiểm chứng API).
4. Refactor `OrdersView.vue` (loại icon-in-card).
5. Refactor `KpiView.vue` (sử dụng `delta` prop).
6. Build + test verify.
