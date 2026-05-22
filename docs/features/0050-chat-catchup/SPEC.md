# Feature 0050: Chat catch-up after socket drop / tab unfocus

## 1. Mô tả

Khi rep mở một cuộc trò chuyện trong ZaloCRM nhưng khách hàng (hoặc
teammate khác) gửi tin nhắn từ **app Zalo trên mobile** (channel khác,
không phải web channel này), tin nhắn đó đôi khi không xuất hiện trong
thread đang mở. Socket.IO hiện đã được wire (`use-chat.ts:455`), nhưng
nếu browser tab ngủ, network blip, hoặc socket drop trong lúc rep AFK
thì messages mới bị miss cho đến khi user F5.

Feature này thêm hai cơ chế reconciliation **silent background** để bắt
kịp messages bị miss mà không cần user reload.

## 2. User Stories liên quan

- US-0050: Là một sale rep, khi tôi quay lại tab CRM sau 5 phút AFK, tôi
  muốn thấy bất kỳ tin nhắn mới nào khách đã gửi qua app Zalo — không
  phải F5 hay click vào lại conversation.
- US-0051: Là một sale rep, khi network của tôi blip 30 giây rồi lên
  lại, tôi muốn thread đang mở tự động fetch tin nhắn đã miss trong
  khoảng đó.

## 3. Business Rules

### Backend

- **BR-0001 — Cursor `sinceMessageId` trên GET messages.** Thêm optional
  query param `?sinceMessageId=<uuid>`. Khi present, server lookup
  `sentAt` của message đó rồi filter `WHERE sent_at > <that>`. Returns
  tất cả tin nhắn mới hơn, không cần pagination.
- **BR-0002 — Cap catch-up window.** Cap số messages trả về (mặc định
  `limit=200`) để tránh edge case rep bỏ tab cả ngày rồi quay lại load
  10k messages một lúc. Nếu hit cap, FE biết phải full-reload thread
  (hoặc poll lại trong vòng vài giây).
- **BR-0003 — `sinceMessageId` không tồn tại → 400.** Nếu cursor không
  match một message của conversation đó, return 400 với hint "Cursor
  invalid — refetch full thread". FE handle bằng cách reload full.
- **BR-0004 — Cursor scoped per conversation.** Server validate
  `sinceMessageId.conversationId === path conversationId`. Không cho
  cross-conversation leak.

### Frontend

- **BR-0005 — Track `lastSyncedMessageId` trong use-chat.** Maintain
  refs map `Record<conversationId, lastMessageId>`. Update mỗi lần
  message mới đến qua initial fetch / socket / catch-up.
- **BR-0006 — Catch-up on socket reconnect.** Wire `socket.on('reconnect')`
  → call `catchUp(activeConvId, lastSyncedMessageId)`. Merge result
  với existing thread bằng dedupe theo `message.id`.
- **BR-0007 — Catch-up on visibility return after >30s.** Listen
  `document.visibilitychange`. Khi visibility = "visible" và last
  hidden timestamp >30s ago, fire catch-up on active conversation.
- **BR-0008 — Catch-up is idempotent + non-blocking.** Không show
  loading spinner; messages slide vào thread như qua socket event.
  Failures (network, 400) log thầm; user sẽ refresh thủ công nếu cần.
- **BR-0009 — Chỉ catch-up conversation đang OPEN.** Không refetch
  toàn bộ conversation list. Vế list của conversations đã có separate
  sync logic (Socket.IO `chat:tab` event + cron).

## 4. Input / Output

- **Input (BE):** GET `/api/v1/conversations/:id/messages?sinceMessageId=<uuid>&limit=200`
- **Output (BE):** `{ messages: Message[], total: number, page: 1,
  limit: 200, sinceCursor: <uuid> }` — `messages` sorted asc by sentAt
  (giống endpoint hiện tại).
- **Input (FE):** None — triggered automatically on reconnect /
  visibility events.
- **Output (FE):** New messages appear inline in the open thread.

## 5. Edge Cases

- **User reloads page mid-catchup:** mount → fetch full history → catch-up
  no-ops (no `lastSyncedMessageId` yet).
- **User switches conversation mid-catchup:** in-flight request response
  thuộc về old conversation, FE check `if (response.conversationId !== activeConvId) return`.
- **Cursor message was deleted:** BE returns 400; FE falls back to full
  reload of that conversation.
- **Cap hit (>200 missed messages):** BE returns 200 messages + meta
  `truncated: true`. FE shows subtle toast "Đã miss nhiều tin — đang
  load đầy đủ" then full-reloads.
- **Multiple tabs open same conversation:** each tab catches up
  independently. No deduplication needed across tabs.
- **Reconnect fires repeatedly (flapping network):** debounce catch-up
  to once per 5 seconds.

## 6. Acceptance Criteria

- [ ] AC-0001: GET `/conversations/:id/messages?sinceMessageId=<uuid>`
      returns only messages with `sentAt > sinceMessage.sentAt`.
- [ ] AC-0002: GET with invalid `sinceMessageId` returns 400.
- [ ] AC-0003: GET with `sinceMessageId` from a different conversation
      returns 400 (not 200 with empty / cross-conv data).
- [ ] AC-0004: FE: simulating `socket.disconnect()` then `socket.connect()`
      while a conversation is open triggers a catch-up GET to BE.
- [ ] AC-0005: FE: `document.visibilitychange` to visible after >30s
      hidden triggers a catch-up GET.
- [ ] AC-0006: FE: catch-up response is merged dedup by `id` — no
      duplicate messages even if socket also delivered them.
- [ ] AC-0007: FE: switching conversation mid-flight discards stale
      catch-up response (no cross-conversation leak in UI).
- [ ] AC-0008: Backend integration test covers the 4 BR-0001-0004 cases.
- [ ] AC-0009: Frontend unit test for the merge-dedupe logic.

## 7. Dependencies

- Socket.IO infrastructure (existing — chat:message event already wired).
- Prisma `Message` model — `sentAt` indexed (already is — confirmed in
  schema, used as primary order).
- No DB migration needed.

## 8. Implementation order

1. Backend: cursor query + validation + tests (~25 LOC + 4 tests)
2. Frontend: `lastSyncedMessageId` tracking + catch-up function + dedup
   merge (~45 LOC + 1 unit test)
3. Wire `socket.on('reconnect')` + `visibilitychange` listeners
   (~15 LOC)
4. Manual smoke test: disconnect socket via DevTools offline mode, send
   message from second account, restore — verify message appears
