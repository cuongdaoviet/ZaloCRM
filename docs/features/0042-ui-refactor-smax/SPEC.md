# Feature 0042: UI refactor — 3-page Smax layout (chat / contacts / friends)

## 1. Mô tả

PR #32 đã port Smax theme tokens (`--smax-*` CSS variables) nhưng chỉ là
color/typography swap. ZaloCRM-3.0 v3.0 release notes mention "UI refactor
3 trang — Chat / Contacts / Friends thiết kế Smax style, layout cố định,
badge số tin chưa đọc". Đó là layout pattern: fixed left rail, denser
table, unread badge prominent.

Feature này refactor layout (KHÔNG đụng business logic):

1. **Chat page** — fixed left rail (conversation list, không scroll
   horizontal), main message area, optional right panel for contact info.
2. **Contacts page** — denser table (smaller row heights, more columns
   visible without horizontal scroll), filter rail integrated.
3. **Friends page** (new) — list friends across all Zalo accounts, badge
   counts (linkable from Feature 0033 chartingNicksCount).

## 2. User Stories

- **US-0042-1:** Là Sale, tôi mở Chat page → conversation list cố định
  bên trái (không scrollable theo main panel), unread badge to + đậm
  hơn trên row.
- **US-0042-2:** Là Sale, tôi mở Contacts page → table dày hơn (40px row
  height thay vì 56px), thấy nhiều contact hơn trong 1 view.
- **US-0042-3:** Là Sale, tôi vào Friends page (mới) → grid friends across
  all nicks, search/filter, click → contact detail.

## 3. Business Rules

### Layout — Chat page

- **BR-0001:** Left rail width: 320px fixed (existing 280-360 may vary).
  KHÔNG resizable phase 1.
- **BR-0002:** Conversation row height: 64px (compact). Avatar 40px,
  primary text 14px medium, secondary 12px regular.
- **BR-0003:** Unread badge: red dot 20px diameter with white number
  inside (max "99+"). Vị trí top-right của avatar.
- **BR-0004:** Active conversation: full-row highlight (background
  `--smax-primary-100`), KHÔNG chỉ border.

### Layout — Contacts page

- **BR-0005:** Table row height: 40px (giảm từ 56px).
- **BR-0006:** Column priorities (visible without scroll on 1280px):
  Tên, Phone, Status, Tags, Last Contact, Assigned. Other columns toggle
  via column-show menu.
- **BR-0007:** Filter rail (Feature 0022 chip filters): persistent ở top
  với layout dày hơn.

### Layout — Friends page (new)

- **BR-0008:** Route: `/friends`. Auth: any authenticated user trong org.
- **BR-0009:** Grid layout: 3 columns desktop, 2 tablet, 1 mobile. Each
  card: avatar large, displayName, zaloAccount badge (which nick added),
  Contact link.
- **BR-0010:** Filter by zaloAccount (multi-select), search by displayName.
- **BR-0011:** Endpoint: `GET /api/v1/friends?accountId=X&search=Y` —
  paginated. Reuse Friend model query.

### Theme tokens

- **BR-0012:** Reuse existing `--smax-*` from PR #32. Add new tokens if
  needed (e.g. `--smax-row-height-dense`, `--smax-badge-unread-bg`).

## 4. Input / Output

### Schema

NO schema change. Friends already exist (Feature 0020). Endpoint already
exists (verify). Layout is FE-only.

### Endpoints

#### `GET /api/v1/friends` (existing or new)

If exists: extend with `search` query param + pagination.
If new: implement basic list endpoint.

```
GET /api/v1/friends?accountId=X&search=lan&page=1&perPage=24

Response 200:
{
  "data": [
    { "uid", "displayName", "avatarUrl", "zaloAccountId", "zaloAccountName", "contactId" },
    ...
  ],
  "pagination": { "page", "perPage", "total", "totalPages" }
}
```

### Frontend pages

- `frontend/src/views/ChatView.vue` — layout refactor.
- `frontend/src/views/ContactsView.vue` — density.
- `frontend/src/views/FriendsView.vue` — NEW.
- `frontend/src/components/chat/ConversationList.vue` — row layout.
- `frontend/src/components/friends/FriendCard.vue` — new card.

### Routing

- Add `/friends` route in router. Nav menu: thêm icon "Friends"
  (mdi-account-multiple).

## 5. Edge Cases

- **EC-0001:** No friends → empty state với CTA "Thêm Zalo account để
  add bạn bè".
- **EC-0002:** Friend không có Contact CRM tương ứng → card vẫn render,
  link to "Tạo Contact" prefill flow.
- **EC-0003:** Mobile breakpoint (< 768px): chat left rail full-screen
  với back button to switch panes.
- **EC-0004:** Existing user flows (campaigns, kpi, etc.) KHÔNG đụng —
  feature này là pure visual.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Chat page: left rail width 320px fixed.
- [ ] **AC-0002:** Chat conversation row: 64px, unread badge red dot.
- [ ] **AC-0003:** Contacts page: row 40px, 6 columns visible 1280px.
- [ ] **AC-0004:** Friends page (`/friends`) renders grid của friends.
- [ ] **AC-0005:** GET `/friends?search=lan` filter by displayName.
- [ ] **AC-0006:** Pagination works.
- [ ] **AC-0007:** Mobile responsive: chat full-screen pane switch.
- [ ] **AC-0008:** Existing screens KHÔNG regress (smoke test core flows).
- [ ] **AC-0009:** Build pass: vue-tsc + vite.

## 7. Dependencies

- `Friend` model — đọc only.
- `backend/src/modules/friendship/friendship-routes.ts` — extend list
  endpoint nếu cần.
- `frontend/src/views/ChatView.vue`, `ContactsView.vue`, `FriendsView.vue`
  (new).
- `frontend/src/router/index.ts` — add route.
- `frontend/src/components/friends/` — new dir.
- `frontend/src/assets/smax-tokens.css` (or wherever tokens live) — extend.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| BE friends list endpoint extend | ~40 |
| FE ChatView layout refactor | ~60 |
| FE ContactsView density | ~30 |
| FE FriendsView new page | ~120 |
| FE FriendCard component | ~60 |
| Router + nav | ~15 |
| FE tests basic | ~30 |
| **Tổng** | **~355 LOC** |

### Risk: LOW

Pure visual/layout refactor. Risk: regression in existing flows. Mitigate
with manual smoke test + screenshot diff if possible.

### Test strategy

- FE component snapshot test for new layouts.
- Manual smoke: walk through chat send/receive, contact CRUD, friends
  filter.

### Deviations from ZaloCRM-3.0

3.0 release note ngắn. We add /friends as new top-level page; 3.0 may
have it tab-style inside Chat. Page is cleaner for our nav.

### Out of scope (Phase 2)

- Drag-to-resize rail.
- Custom column ordering on Contacts page.
- Friends bulk actions (multi-select).
- Dark mode adjustments (smax tokens currently light-only).
