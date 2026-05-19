# Feature Specs

Mỗi feature có 1 thư mục `NNNN-<name>/` chứa ít nhất `SPEC.md` — đây là source of truth cho mọi quyết định thiết kế. Khi thêm feature mới, xem [AGENTS.md](../../) §2.17 cho template SPEC.

## Trạng thái

| # | Feature | SPEC | Trạng thái | Endpoint chính |
|---|---------|------|------------|----------------|
| 0001 | Đồng bộ lịch sử Zalo (offline catch-up + group history) | [SPEC.md](0001-sync-history/SPEC.md) | ✅ Shipped | `POST /api/v1/zalo-accounts/:id/sync-group-history` |
| 0002 | Bắt đầu cuộc trò chuyện mới | [SPEC.md](0002-new-chat/SPEC.md) | ✅ Shipped | `POST /api/v1/conversations` |
| 0003 | Gửi file & ảnh từ web chat | [SPEC.md](0003-send-attachments/SPEC.md) | ✅ Shipped | `POST /api/v1/conversations/:id/attachments` |
| 0004 | Tin nhắn mẫu (Quick replies) | [SPEC.md](0004-quick-replies/SPEC.md) | ✅ Shipped | `GET / POST / PUT / DELETE /api/v1/quick-replies` |
| 0005 | Auto-reply ngoài giờ | [SPEC.md](0005-auto-reply/SPEC.md) | ✅ Shipped | `GET / PUT / DELETE /api/v1/zalo-accounts/:id/auto-reply` |
| 0006 | Tìm kiếm tin nhắn nâng cao | [SPEC.md](0006-message-search/SPEC.md) | ✅ Shipped | `GET /api/v1/search/messages` |
| 0007 | KPI & Leaderboard | _(coming in PR #10)_ | 🚧 In PR | `GET /api/v1/kpi/{summary,leaderboard}` |

## Quy ước

- **ID 4 chữ số**, tự tăng từ `0001`. Không reuse khi cancel feature.
- Tên thư mục: `NNNN-<kebab-case>`
- SPEC bắt buộc các mục: Mô tả, User Stories, Business Rules, API contract (nếu có), Acceptance Criteria, Test plan, Out of scope.
- Khi feature ship, không xoá SPEC — nó là historical record cho việc tại sao thiết kế như vậy.

## Module mapping

Mỗi feature thường gắn với 1 backend module dưới `backend/src/modules/`:

| Feature | Module backend | Frontend route / component |
|---------|---------------|---------------------------|
| 0001 | `zalo/zalo-sync-routes.ts` + `zalo-listener-factory.ts` | Nút trong `ZaloAccountsView.vue` |
| 0002 | `chat/chat-routes.ts` (`POST /conversations`) | `NewChatDialog.vue` |
| 0003 | `chat/chat-routes.ts` (multipart upload) | `MessageThread.vue` paperclip + drag-drop |
| 0004 | `quick-replies/` | `QuickRepliesView.vue` + `QuickReplyPopover.vue` |
| 0005 | `auto-reply/` | `AutoReplyDialog.vue` |
| 0006 | `search/search-routes.ts` (`GET /search/messages`) | `MessageSearchView.vue` |
| 0007 | `kpi/` | `KpiView.vue` |

## Workflow

Theo [AGENTS.md](../../) §3:

1. **Plan** — Viết SPEC trước khi code. Mọi quyết định trade-off ghi rõ
2. **Implement** — Branch `feature/NNNN-<name>` from `main`, code theo SPEC
3. **Test** — Unit + integration. Suite phải green local trước khi push
4. **Review** — Open PR → CI chạy → review → merge
5. **Document** — Update README + HUONG-DAN-SU-DUNG nếu user-facing
