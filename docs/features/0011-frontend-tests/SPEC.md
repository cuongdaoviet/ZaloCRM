# Feature 0011: Frontend tests (Vitest)

## 1. Mô tả

Frontend hiện chỉ có TypeScript type-check + Vite production build trong CI — không có behavioral tests. Bug logic ở composables (snippet escaping, dedup conversation, placeholder substitution) chỉ phát hiện được khi user click.

Feature này thêm:
1. **Vitest setup** cho frontend với jsdom environment
2. **Unit tests** cho composables quan trọng: `use-message-search`, `use-chat`, `use-quick-replies`
3. **Component tests** cho 2 critical UI parts: `QuickReplyPopover` (slash command filter), `NewChatDialog` (form validation)
4. **CI integration** — workflow `Frontend` chạy thêm `npm run test`

## 2. User Stories

- **US-0001:** Dev mới vào project chạy `npm test` ở `frontend/` để confirm setup OK
- **US-0002:** Khi sửa logic trong composable, test fail ngay → tiết kiệm thời gian QA manual
- **US-0003:** CI block merge khi frontend test fail (chung với backend)

## 3. Scope

### In scope (v1)
- Vitest config với jsdom
- Vue Test Utils cho component tests
- Tests cho:
  - `composables/use-message-search.ts` — `snippetToHtml` escape behavior (XSS safety)
  - `composables/use-quick-replies.ts` — `substitutePlaceholders` (mirror BE logic)
  - `composables/use-kpi.ts` — `formatVND`, `formatCount` formatters
  - `components/chat/QuickReplyPopover.vue` — filter computed + keyboard nav
- CI workflow: thêm step `npm run test` vào `Frontend` job

### Out of scope (v1)
- E2E tests (Playwright) — feature riêng
- Visual regression tests
- Full Vue component tests cho mọi view (chỉ critical components)
- Coverage gate (chỉ chạy + pass; coverage % để sau)

## 4. Files

### New
- `frontend/vitest.config.ts` — Vitest config với jsdom + Vue plugin
- `frontend/src/composables/__tests__/use-message-search.test.ts`
- `frontend/src/composables/__tests__/use-quick-replies.test.ts`
- `frontend/src/composables/__tests__/use-kpi.test.ts`
- `frontend/src/components/chat/__tests__/QuickReplyPopover.test.ts`

### Modified
- `frontend/package.json` — thêm script `test`, devDeps `vitest`, `@vue/test-utils`, `jsdom`, `@vitest/coverage-v8`
- `.github/workflows/ci.yml` — thêm step `npm test` vào Frontend job

## 5. Acceptance Criteria

- [ ] **AC-0001:** `cd frontend && npm test` chạy được, pass tất cả tests
- [ ] **AC-0002:** Tests cover `snippetToHtml` với XSS payload (`<script>`, `<img onerror>`)
- [ ] **AC-0003:** Tests cover `substitutePlaceholders` (giống backend)
- [ ] **AC-0004:** Tests cover keyboard nav trong `QuickReplyPopover` (filter, highlight)
- [ ] **AC-0005:** CI workflow `Frontend` job có step `Run tests` và pass
- [ ] **AC-0006:** Type-check vẫn pass (`vue-tsc -b`)

## 6. Test plan

`npm test` ở `frontend/` chạy ~5 giây.

## 7. Out of scope (làm sau)

- E2E với Playwright cho user flows (login → chat → send message → check)
- Tests cho mọi views/components (~15 files)
- Coverage gate (vd: >80%)
- Visual regression với Percy/Chromatic
