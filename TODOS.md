# TODOs — backlog from ZaloCRM-3.0 audit

Generated from the 2026-05-20 audit of features advertised in ZaloCRM-3.0
release notes that are **not yet in this codebase** (or only partially shipped).

Numbering continues from where shipped features stopped — last shipped is
0021 (message reactions). Each item below has a placeholder feature number
in the 0022+ block.

Status legend:
- ❌ Not started — needs a SPEC + implementation
- 🟡 Partially shipped — some scaffolding exists but doesn't match the 3.0
  feature description. Needs a "complete it" SPEC, smaller scope.

---

## Priority bands

These are subjective. Reorder freely.

- **P0 — fast unlocks** (small effort, daily-life impact)
- **P1 — feature parity with 3.0** (medium effort)
- **P2 — moonshots / strategic** (big investment, depends on product call)
- **P3 — nice-to-have polish**

---

## P0 — fast unlocks

### 0022 — Conversation filters (unread / no-reply / time / tags)
**Status:** ❌
**Source:** v2.1 release notes — "Bộ lọc hội thoại: chưa đọc, chưa trả lời,
thời gian, tags".
**Why now:** ConversationList today has only search + account filter.
Sales spend daily time scrolling looking for "what hasn't been answered".
**Rough scope:** ~150 LOC frontend (filter chip row above the list) +
small backend query enrichment if not already supported by GET
`/conversations`.

### 0023 — Hide / archive conversations (Tab "Khác")
**Status:** ❌
**Source:** v2.1 release notes — "Tab 'Khác': ẩn hội thoại không quan
trọng, chuyển tab bằng chuột phải".
**Why now:** Inbox bloat is a real productivity problem. Right-click to
move into a Hidden tab keeps the main list focused.
**Rough scope:** Add `Conversation.archivedAt` field, add tab UI, context-
menu in ConversationList. ~250 LOC + small schema migration.

### 0024 — Dual name display (CRM Name + Zalo Name)
**Status:** ❌
**Source:** v2.1 release notes — "Tên KH 2 lớp: CRM Name + Zalo Name, ưu
tiên CRM Name".
**Why now:** Today the contact's name is a single field. When the rep
edits `Contact.fullName` ("Anh Tuấn CFO XYZ"), they lose the original
Zalo display name that helps disambiguate cold-leads.
**Rough scope:** Add `Contact.zaloDisplayName` field (synced on
incoming-message-handler write). UI shows `crmName` primary, `zaloName`
muted secondary. ~120 LOC.

### 0025 — Inline video player
**Status:** ❌
**Source:** v3.0 release notes — "Tin nhắn video render trực tiếp với
controls trong bubble".
**Why now:** Today video messages render as the text `🎥 Video` and
require the rep to open Zalo on their phone to actually watch. Trivial
fix: `<video controls :src="msg.attachments[0].url" />`.
**Rough scope:** ~30 LOC in MessageThread.vue. CSS for max-width. Lazy-
load via `preload="metadata"`. Done in an afternoon.

### 0026 — Mention rendering + auto-complete
**Status:** ❌
**Source:** v3.0 release notes bug-fix — "@mention không bôi lố".
**Why now:** Group chats are unusable for reps without @mention.
**Rough scope:** Parse `@<uid>` tokens in message content, render as a
styled chip. Add `@` trigger in the composer that opens a member picker.
~250 LOC frontend + a tiny backend for member list.

---

## P1 — feature parity with 3.0

### 0027 — MinIO/S3 file storage + attachment mirror
**Status:** ❌
**Source:** v3.0 release notes — "MinIO/S3 storage", "Chat attachments
mirror lên MinIO".
**Why now:** Today, attachments forward to Zalo and we store only Zalo's
CDN URL. If Zalo's CDN expires the URL or rotates the file, our CRM loses
the file too. No local copy = no auditability + no historical search.
**Rough scope:**
- Add MinIO service to `docker-compose.yml`
- Backend: install `@minio/client`, async-upload-after-forward in the
  attachments POST route + the message-handler for inbound files
- Switch `Message.attachments[].url` to point at our MinIO URL
- Signed-URL endpoint for FE to render
- Retention policy decision (forever? N days?)
- ~400 LOC + ops decision on storage class + lifecycle

### 0028 — Sticker support (proxy `getStickersDetail` + picker)
**Status:** ❌
**Source:** v3.0 release notes — "Sticker animated".
**Why now:** Stickers render as text placeholder; reps can't use them.
**Rough scope:** Proxy endpoint that pipes Zalo's sticker detail through
our backend (avoids CORS). Sticker picker component in chat input.
Render animated stickers in message bubbles. ~300 LOC.

### 0029 — Bank/QR card render (zinstant cards)
**Status:** ❌
**Source:** v3.0 release notes — "Bank/QR card render".
**Why now:** Customers send bank-transfer cards; today they render as
plain text. Reps copy-paste manually.
**Rough scope:** Detect Zalo `zinstant` payloads in message content,
render as a styled card with click-to-copy account number / amount /
embedded QR code. ~200 LOC.

### 0030 — Zalo user info popup (avatar click in group)
**Status:** ❌
**Source:** v3.0 release notes — "Click vào avatar trong nhóm xem thông
tin user".
**Why now:** In group chats, reps can't tell who said what without
opening Zalo on their phone.
**Rough scope:** Popover on avatar click that fetches `getUserInfo` from
zca-js + shows display name, phone (if friend), Zalo ID. ~100 LOC.

### 0031 — Reply / quote message
**Status:** ❌
**Source:** v3.0 release notes bug-fix — "Reply preview JSON".
**Why now:** Reply is table-stakes for chat UX. The 3.0 fix existing
implies they have reply; we don't even have the feature.
**Rough scope:** Add `Message.replyToMessageId` field, render quote
bubble inside child message, add "Reply" action on hover. Outbound via
zca-js `sendMessage({ quoted })`. ~300 LOC.

### 0032 — Hd image preview (uploadAttachment first)
**Status:** ❌ (related to 0027 but cheaper standalone)
**Source:** v3.0 release notes bug-fix — "Image preview rỗng — Upload
uploadAttachment lấy hdUrl thật trước khi lưu Message".
**Why now:** Image messages today rely on the URL zca-js returns in the
`sendMessage` response, which is sometimes empty for our outbound
attachments. Switching to `uploadAttachment` first, then `sendMessage`
with the hdUrl, gives reliable previews even before MinIO mirror lands.
**Rough scope:** ~50 LOC change in the attachments route. Doesn't depend
on 0027.

### 0033 — Friend aggregates (chattingNicksCount, acceptedNicksCount)
**Status:** 🟡 partial (Feature 0020 has the rows, no aggregate fields)
**Source:** v3.0 release notes — "Friend model + aggregates ... đếm nick
CRM đang chăm khách".
**Why now:** Admin wants "how many leads is rep A actively chatting with"
at a glance. Today they'd have to write SQL.
**Rough scope:** Either denormalize aggregates onto User/Contact, OR add
a `GET /api/v1/friends/stats` endpoint that computes on demand. ~150 LOC.

### 0034 — Contact merge by Zalo globalId
**Status:** 🟡 partial (Feature 0018 has phone / uid / fuzzy-name; no
globalId)
**Source:** v3.0 release notes — "Gộp khách hàng cha-con tự động, policy
hard/soft merge".
**Why now:** Zalo's `globalId` is the canonical user ID that survives
across Zalo's own account-merging. Matching on it catches duplicates our
current heuristics miss.
**Rough scope:** Add `Contact.zaloGlobalId` field, add 4th detection
strategy in `duplicate-detection.ts`. ~100 LOC + schema migration.

### 0035 — Per-account proxy config (UI)
**Status:** ❌
**Source:** v3.0 release notes — "Cấu hình proxy HTTP/SOCKS5 cho từng
Zalo qua giao diện".
**Why now:** Reps in different regions sometimes need a regional Zalo
exit. Today there's no way to set a proxy per Zalo account.
**Rough scope:** Add `ZaloAccount.proxyUrl` field, pass through to
zca-js `agent` option, UI in Settings/Zalo Accounts. ~200 LOC.

---

## P2 — moonshots / strategic

### 0036 — AI reply suggestions (multi-provider)
**Status:** ❌
**Source:** v2.0 release notes — "AI Assistant: gợi ý trả lời", v3.0 —
"Multi-Provider AI: Anthropic, OpenAI, Qwen, Kimi".
**Why later:** Biggest WOW factor on the cherry-pick list. Adds external
API dependency + recurring per-token cost (~$0.75/day/org with Sonnet
4.5 at 500 suggestions/day × 500 tokens). Needs a product call on the
budget before spec'ing.
**Rough scope:** ~800 LOC backend (provider registry, prompt templates,
`AiConfig` + `AiSuggestion` models). FE chip in chat input. Each
provider is its own integration.

### 0037 — Workflow automation engine
**Status:** 🟡 very partial (Feature 0009 KeywordRule does single-step
auto-tag on inbound; full workflow engine doesn't exist)
**Source:** v2.0 release notes — "Workflow Automation: tự động gửi tin,
phân loại khách".
**Why later:** Goes from "if message contains X, tag it Y" to "after 24h
no reply, send template Z and assign to user W". Big surface area.
**Rough scope:** New `WorkflowDefinition` model with steps (trigger +
conditions + actions), step execution worker. ~800 LOC including UI.

### 0038 — Integration Hub framework (Sheets / Telegram / FB / Zapier)
**Status:** ❌
**Source:** v2.0 release notes — "Integration Hub".
**Why later:** Each connector is its own follow-up; framework is the
entry ticket. Each integration also opens an auth/permissions surface.
**Rough scope:** `Integration` model with type + config Json, OAuth
flows per provider, sync workers. ~600 LOC framework + ~200 LOC per
provider.

### 0039 — Mobile PWA (offline, responsive, installable)
**Status:** ❌
**Source:** v2.0 release notes — "Mobile PWA".
**Why later:** Big rewrite of the chat + contacts views with mobile-
first layout. Bottom nav, larger touch targets, gestures.
**Rough scope:** Add manifest.json + service worker (workbox), rewrite
ChatView + ContactsView mobile breakpoints, offline message queue. ~600
LOC + PWA infrastructure decisions.

### 0040 — Lead scoring + Contact Intelligence
**Status:** 🟡 very partial (auto-tag via KeywordRule exists; lead
scoring doesn't)
**Source:** v2.0 release notes — "Contact Intelligence: gộp trùng, lead
scoring, auto-tag".
**Why later:** "Lead score" needs a defined scoring model. Cheap version
(rules-based: `score = recencyOfLastMessage × engagementCount`) vs.
expensive version (ML on conversation embeddings).
**Rough scope:** Rules-based is ~200 LOC + a periodic worker. ML version
is its own product.

### 0041 — Advanced analytics (funnel / team perf / report builder)
**Status:** 🟡 partial (KPI + Reports exist; funnel and custom report
builder don't)
**Source:** v2.0 release notes — "Advanced Analytics".
**Why later:** "Report builder" implies a visual query designer (drag-
drop dimensions/measures) which is a big component. Funnel is smaller.
**Rough scope:**
- Funnel view: ~200 LOC (define stages, count contacts per stage).
- Team perf dashboard extension: ~150 LOC.
- Report builder: ~800+ LOC and its own product call.

---

## P3 — polish

### 0042 — UI refactor: 3-page Smax layout (chat / contacts / friends)
**Status:** 🟡 partial (PR #32 ported Smax theme tokens; layout
patterns not ported)
**Source:** v3.0 release notes — "UI refactor 3 trang — Chat / Contacts
/ Friends thiết kế Smax style, layout cố định, badge số tin chưa đọc".
**Why later:** Visual refinement, not a feature. Specific work: fixed
left rail on Chat, unread-count badge on conversation list rows, denser
Contacts table.
**Rough scope:** ~200 LOC across 3 views.

### 0043 — Perf: faster conversation switching
**Status:** Unverified
**Source:** v3.0 release notes — "Cải thiện độ trễ khi đổi hội thoại".
**Why later:** Need to measure first. Probably involves prefetching
messages on hover / virtualizing the message list.
**Rough scope:** Measure, then ~150-300 LOC depending on root cause.

---

## Not in scope here

These were on 3.0's list but we already shipped equivalents OR they're
listed under known follow-ups in [CHANGELOG.md](docs/operations/CHANGELOG.md):

| 3.0 item | Where it lives in our codebase |
|---|---|
| Chat attachments composer | Feature 0003 — upload + send works, only MinIO mirror missing → 0027 |
| Quick template `/` | Feature 0004 (QuickReply) |
| History sync 50 messages + selfListen dedup | Feature 0001 + zalo-sync-routes |
| Reaction 2-way sync | Feature 0021 (single emoji per user per message — Zalo style, intentional) |
| Duplicate detection (phone / uid / fuzzy) | Feature 0018 — globalId match deferred to 0034 |
| Dup-message-send fix | PR #21 |
| `Contact.tags` JSON dropped | Feature 0019 Phase C |
| Smax theme tokens | PR #32 |
| rType mapping verification | Passive log line, surfaces on first real reaction |
| Dockerfile destructive migration hardening | In flight as a separate PR |

---

## How to pick the next one

1. **For daily-life productivity:** 0022 (conversation filters) or 0025
   (inline video) ship in an afternoon.
2. **For feature-parity with 3.0:** 0027 (MinIO) is the most-talked-about
   gap. Needs storage decisions before scoping.
3. **For the WOW demo:** 0036 (AI suggestions) is the biggest visible
   feature; requires budget approval.

When you pick one, the workflow is:
1. Write SPEC at `docs/features/<id>-<slug>/SPEC.md` (or have a planner
   agent do it)
2. Commit + push + merge the SPEC to `main` BEFORE launching the
   implementer agent (worktree forks can't see uncommitted SPECs — we
   learned this the hard way with feature 0020)
3. Spawn implementer in a worktree
4. Integrate, CI, merge
