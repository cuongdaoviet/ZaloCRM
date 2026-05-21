# Feature 0039: Mobile responsive layout (phase 1, no PWA shell)

## 1. Mô tả

Phase 1 scope hẹp lại từ original "Mobile PWA" — **không** add service
worker, **không** offline mode, **không** message queue. Chỉ làm
responsive layout: mobile breakpoints + bottom nav + touch-friendly
targets. Lý do: full PWA là 5-6 tuần và một nửa giải pháp; nếu thực sự
cần mobile-first thì làm native sau. Responsive layout là 80% giá trị
với 30% effort.

Reuse Feature 0042's mobile-chat-pane-switch pattern (đã ship) và mở
rộng cho Contacts, Friends, Settings.

## 2. User Stories

- **US-0039-1:** Là Sale, tôi mở CRM trên điện thoại (Chrome/Safari) →
  giao diện sử dụng được, không bị cắt nội dung, không phải pinch-zoom.
- **US-0039-2:** Là Sale, ở mobile (< 768px), tôi thấy bottom nav với
  4 tabs (Chat / Contacts / Friends / More) thay vì sidebar.
- **US-0039-3:** Là Sale, tap các button/row đủ to (≥ 44×44px touch
  target).
- **US-0039-4:** Là Sale, ở Chat (mobile), tôi vào 1 conversation →
  thread chiếm full screen, có nút back về list. (Feature 0042 đã
  có; verify còn hoạt động.)

## 3. Business Rules

### Breakpoints

- **BR-0001:** Vuetify breakpoints (existing):
  - `xs` < 600px (phone portrait)
  - `sm` 600-960px (phone landscape / small tablet)
  - `md` 960-1264px (tablet)
  - `lg/xl` ≥ 1264px (desktop)
- **BR-0002:** Mobile design targets `xs` + `sm`. `md` và lớn hơn giữ
  desktop layout đã có.

### Layout patterns

- **BR-0003:** Bottom nav xuất hiện ở `xs` + `sm`. 4 tabs: Chat,
  Contacts, Friends, More. "More" mở drawer với link tới Settings,
  Reports, Analytics.
- **BR-0004:** Sidebar (`DefaultLayout` rail) ẩn ở `xs` + `sm`. Top
  app bar giữ lại với user menu + notifications.
- **BR-0005:** Chat: pane switch (đã ship Feature 0042). Verify còn
  hoạt động + extend cho ContactDetail page (mobile: full-screen modal).
- **BR-0006:** Contacts: filter rail ẩn (collapse to icon button →
  bottom sheet). Table → card list ở mobile.
- **BR-0007:** Friends: grid 1 cột ở `xs`, 2 cột ở `sm`, 3 cột ở
  desktop.
- **BR-0008:** Settings: list-style (mỗi item full-width tap target).

### Touch targets

- **BR-0009:** Min 44×44 px cho mọi tap target (buttons, list rows,
  links). Sử dụng Vuetify density="comfortable" cho `xs/sm`,
  `compact` cho desktop.

### Out of scope (explicitly)

- **BR-0010:** KHÔNG add `manifest.json`. Không installable.
- **BR-0011:** KHÔNG add service worker. Không offline cache.
- **BR-0012:** KHÔNG add background sync / message queue.
- **BR-0013:** KHÔNG support iOS Safari < 14 (>5 years old).

## 4. Input / Output

### Schema

NO schema change.

### Backend

NO backend change.

### Frontend

#### Layout refactor

- `frontend/src/layouts/DefaultLayout.vue`:
  - Add `useDisplay()` from Vuetify.
  - Hide sidebar rail when `mobile.value === true`.
  - Render new `MobileBottomNav.vue` component when mobile.
  - Add `pa-bottom: 56px` style on `<main>` to clear bottom nav.

- New `frontend/src/components/layout/MobileBottomNav.vue`:
  - Vuetify `v-bottom-navigation` with 4 buttons.
  - Active state via route matching.
  - "More" opens `<v-navigation-drawer location="bottom">` with
    secondary nav.

#### Per-view refactors

- `ChatView.vue` — already has Feature 0042 mobile pane switch.
  Verify + add tests that the back button works on `xs`.

- `ContactsView.vue`:
  - At `xs/sm`, replace `v-data-table` with `v-list` of cards.
  - Each card: avatar + fullName + status chip + lead score badge.
  - Tap → router push to ContactDetail (full-screen on mobile).
  - Filter row → icon button + bottom sheet form.

- `FriendsView.vue`:
  - Grid cols: 1 / 2 / 3 (use `:cols="$vuetify.display.xs ? 12 : sm
    ? 6 : 4"`).
  - FriendCard already responsive — verify.

- `SettingsTab` views (multiple files):
  - Audit each Settings page — ensure forms readable on `xs`.
  - Tag chips wrap, no horizontal scroll.

#### Touch targets audit

- Buttons: minimum size="default" (44px). Avoid size="x-small" except
  for secondary icons.
- List rows: padding ensures ≥ 44px height.

#### CSS tokens

`frontend/src/assets/tokens.css`:
```css
@media (max-width: 600px) {
  --smax-row-height-dense: 56px; /* override 40px desktop */
  --smax-touch-target-min: 44px;
}
```

## 5. Edge Cases

- **EC-0001:** Landscape phone (`sm` ≈ 600-960px wide, but short
  height): bottom nav still useful but sidebar might fit. Stay with
  bottom nav for consistency.
- **EC-0002:** iPad portrait (`md`): use desktop layout (no bottom nav).
- **EC-0003:** Foldable phone (Galaxy Z Fold): treat as tablet
  (`md/lg`), uses desktop layout.
- **EC-0004:** User rotates phone mid-session: Vuetify reactive
  breakpoints handle this. Verify no janky state on rotate.
- **EC-0005:** Some Settings forms are dense (vd Workflows editor) →
  scrollable + sticky save button.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `xs/sm` viewport: sidebar hidden, MobileBottomNav
      visible.
- [ ] **AC-0002:** Bottom nav has 4 tabs (Chat / Contacts / Friends /
      More). Active route highlighted.
- [ ] **AC-0003:** "More" button opens drawer with Settings, Reports,
      Analytics links.
- [ ] **AC-0004:** Chat: tap conversation row → thread fills screen +
      back button. (Verify Feature 0042 still works post-refactor.)
- [ ] **AC-0005:** Contacts: `xs/sm` → list cards, not table. Each card
      has avatar + name + status + lead score + tap = navigate.
- [ ] **AC-0006:** Contacts filter button opens bottom sheet with
      current filter UI.
- [ ] **AC-0007:** Friends: 1-col grid on `xs`, 2-col on `sm`.
- [ ] **AC-0008:** All tap targets ≥ 44px via DOM measurement test.
- [ ] **AC-0009:** Rotate device → layout reflows without freeze.
- [ ] **AC-0010:** No new dependencies (no PWA libs).
- [ ] **AC-0011:** Existing desktop flows still work (smoke test 1280px+).
- [ ] **AC-0012:** Build pass: vue-tsc + vite.

## 7. Dependencies

- NO backend.
- `frontend/src/layouts/DefaultLayout.vue` — refactor.
- `frontend/src/components/layout/MobileBottomNav.vue` — new.
- `frontend/src/views/ContactsView.vue` — refactor mobile rendering.
- `frontend/src/views/FriendsView.vue` — verify grid.
- `frontend/src/views/Settings*.vue` (multiple) — audit + tweak.
- `frontend/src/assets/tokens.css` — mobile tokens.
- Vuetify `useDisplay` composable (already available).

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| MobileBottomNav component | ~120 |
| DefaultLayout refactor | ~50 |
| ContactsView card list mode | ~150 |
| Contacts filter bottom sheet | ~80 |
| Settings audit (avg 4 pages) | ~80 |
| Tokens / CSS | ~30 |
| FE tests (component + breakpoint) | ~100 |
| **Tổng** | **~610 LOC** |

### Risk: LOW-MEDIUM

Pure FE refactor. Main risk: breaking existing desktop UX. Mitigate
with explicit AC-0011 smoke at 1280px+ and visual regression manually.

### Test strategy

- Unit: MobileBottomNav route highlight, drawer open/close.
- Visual smoke at 360px (phone), 768px (tablet), 1280px (desktop) on
  every view.
- Real device test on iOS Safari + Android Chrome.

### Why we cut PWA scope

The "full PWA with offline message queue" original scope is:
- ~3 weeks for layout work (this SPEC).
- ~1 week service worker + manifest + install prompt.
- ~2-3 weeks offline queue + reconcile logic (the hard part — sync
  conflict resolution on reconnect).
- ~1 week testing offline scenarios.

Total ~6-8 weeks for a half-measure: PWA install prompts get dismissed
on iOS, sync conflicts are painful to test, users still expect a real
app store presence. If mobile matters strategically, build native
(React Native or Flutter) — better install rate, push notifications,
deep links.

Phase 1 (this SPEC) covers 80% of the daily-use need at 30% of the
effort. Phase 2 = native app (separate product call).

### Out of scope (Phase 2 / 3)

- PWA shell (manifest.json + service worker).
- Offline mode (cached API responses).
- Outbound message queue with conflict reconciliation.
- Push notifications (web push).
- Install-to-home-screen prompt.
- Native iOS / Android app (separate product).
- Camera/microphone permission flows.
- Gesture shortcuts (swipe to archive, etc.).
