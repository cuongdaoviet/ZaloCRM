# Feature 0055: Icon tooltips on every screen

## 1. Mô tả

User feedback (2026-05-22):
> "every icons on every screens need to have tooltip"

Audit codebase tìm thấy 30+ icon-only v-btn trên 20 file. Hiện tại có 3 trạng thái khác nhau:
1. ~22 button không có gì (user phải đoán icon nghĩa là gì)
2. ~10 button dùng HTML `title="..."` attribute (browser native, ~500ms delay, plain styling)
3. 2 button trong MobileLayout có `aria-label` cho a11y nhưng không có visual tooltip

Chuẩn hóa toàn bộ về **`<v-tooltip activator="parent" location="..." text="..." />`** đặt làm child của v-btn — Vuetify 3 pattern, không cần wrapper template, animation/style nhất quán.

## 2. Pattern áp dụng

**Trước (hai biến thể):**
```vue
<!-- (a) Không tooltip — user phải đoán -->
<v-btn icon variant="text" @click="openEdit(o)">
  <v-icon size="16">mdi-pencil</v-icon>
</v-btn>

<!-- (b) HTML title -->
<v-btn icon variant="text" title="Chỉnh sửa" @click="openEdit(o)">
  <v-icon>mdi-pencil</v-icon>
</v-btn>
```

**Sau (1 pattern duy nhất):**
```vue
<v-btn icon variant="text" @click="openEdit(o)">
  <v-icon size="16">mdi-pencil</v-icon>
  <v-tooltip activator="parent" location="top" text="Chỉnh sửa" />
</v-btn>
```

`activator="parent"` để Vuetify bind tooltip vào button cha — không cần `<template #activator>` wrapper.

## 3. Location convention

| Vị trí button | Location |
|---|---|
| Row action trong table | `top` |
| Top-bar / app-bar | `bottom` |
| Dialog header (close) | `bottom` |
| Side-panel close | `left` |
| Page header reload | `bottom` |

## 4. Files thay đổi (20)

**Views (7):**
- AnalyticsView.vue (1 nút reload)
- AppointmentsView.vue (1 nút close dialog)
- DuplicateGroupDetailView.vue (1 nút back)
- KpiView.vue (1 nút reload)
- OrdersView.vue (2 nút edit/delete)
- SettingsAiConfigView.vue (1 nút show/hide API key)
- SettingsView.vue (3 nút edit/reset/delete user)
- ZaloAccountsView.vue (8 nút row action — 5 đã có title + 3 phụ phát hiện thêm: history, auto-reply, proxy)

**Components (10):**
- NotificationBell.vue (1 nút bell)
- WebhookDebugPanel.vue (4 nút: detail, replay, prev, next)
- campaigns/CampaignDetailDialog.vue (3 nút: close, prev, next)
- chat/ChatAppointments.vue (1 nút edit)
- chat/ChatContactPanel.vue (1 nút close)
- chat/ConversationNotes.vue (2 nút edit/delete)
- chat/MessageThread.vue (3 nút: download×2, clear pending)
- contacts/ContactDetailDialog.vue (1 nút close)
- settings/TeamManagement.vue (2 nút edit/delete)
- settings/ZaloAccessDialog.vue (1 nút remove access)

**Layouts (3):**
- DefaultLayout.vue (2 nút: theme toggle, logout)
- MobileLayout.vue (2 nút: theme toggle, logout — giữ `aria-label`, thêm v-tooltip)

## 5. Acceptance Criteria

- [ ] **AC-0001**: Hover bất kỳ icon-only v-btn nào trên app, thấy tooltip Vuetify hiện ra sau ~200ms.
- [ ] **AC-0002**: Không còn HTML `title` attribute trên v-btn (audit bằng grep).
- [ ] **AC-0003**: 258 frontend tests pass + build green.
- [ ] **AC-0004**: 30+ tooltip text đều bằng tiếng Việt, action verb rõ ràng (Chỉnh sửa, Xóa, Đóng, Tải lại, …).
- [ ] **AC-0005**: Mobile (`MobileLayout`) giữ `aria-label` cho screen reader + thêm v-tooltip cho mouse user.

## 6. Out of scope

- Không thêm tooltip cho button có text label (text label IS the tooltip).
- Không thêm tooltip cho `v-icon` không nằm trong button (chỉ trang trí, không clickable).
- Không thay đổi v-btn có sẵn `<v-tooltip>` qua `<template #activator>` wrapper (đã đúng pattern).
