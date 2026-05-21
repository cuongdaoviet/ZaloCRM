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
- ✅ Shipped — links to SPEC + PR

## Status summary (updated 2026-05-21)

**Queue complete.** All 19 features in this backlog shipped: 0022,
0023, 0024, 0025, 0026, 0027, 0028, 0029, 0030, 0031, 0032, 0033, 0034,
0035, 0036, 0037, 0038, 0039, 0040, 0041, 0042, 0043.

**Product calls resolved during the cycle:**
- **0036** — BYOK (bring-your-own-key) per org, no recurring cost to us.
  Anthropic + OpenAI + Gemini + Qwen + Kimi + Ollama.
- **0038** — Phase 1 shipped Google Sheets one-way export + Telegram bot
  notifications. Framework supports adding FB Messenger / Zapier / Slack
  later as separate connectors.
- **0039** — Phase 1 shipped responsive layout only. PWA shell + offline
  queue + native app cut to phase 2/3 (PWA is a half-measure; native is
  the right answer if mobile matters strategically).

See [docs/operations/CHANGELOG.md](docs/operations/CHANGELOG.md) for the
release-by-release narrative and `docs/operations/2026-cycle-hardening.md`
for the pre-release QA + EXPLAIN ANALYZE checklist.

---

## Priority bands

These are subjective. Reorder freely.

- **P0 — fast unlocks** (small effort, daily-life impact)
- **P1 — feature parity with 3.0** (medium effort)
- **P2 — moonshots / strategic** (big investment, depends on product call)
- **P3 — nice-to-have polish**

---

## P0 — fast unlocks

### 0022 — Conversation filters (unread / no-reply / time / tags) ✅ SHIPPED
**Status:** ✅ Shipped — see [SPEC](docs/features/0022-conversation-filters/SPEC.md).
**Scope shipped:** 4 chip-row filters above the conversation list
(`unread`, `unreplied`, `dateFrom/dateTo`, `tags`) + new
`GET /api/v1/conversations/counts` aggregate endpoint for badge numbers.
State persisted via the user-preferences KV store (Feature 0016) under
key `chat.conversation_filters`. Wire-format params match ZaloCRM-3.0
`FilterRail` so a future Phase 2 sidebar swap doesn't change the API
contract. Tag filter uses UUIDs via the `ContactTag` junction (deviation
from 3.0 which used names — required post-Phase 0019-C).

### 0023 — Hide / archive conversations (Tab "Khác") ✅ SHIPPED
**Status:** ✅ Shipped — see [SPEC](docs/features/0023-hide-archive-conversations/SPEC.md).
**Scope shipped:** `Conversation.tab` string field (`'main' | 'other'`,
default `'main'`) + new index `[orgId, tab, lastMessageAt(Desc)]`. New
endpoint `PATCH /api/v1/conversations/:id/tab` (Vietnamese errors, `chat`
ACL). `GET /conversations` accepts `tab` query param (composes AND with
the Feature 0022 chip filters; omitted → both tabs returned for back-
compat). `GET /conversations/counts` extended with `mainUnread` +
`otherUnread`. Auto-promote (BR-0005): inbound contact messages on a
`tab='other'` conversation flip it back to `'main'` and emit Socket.IO
`chat:tab`. Frontend: tab bar (Chính / Khác) at the top of
ConversationList with per-tab unread badges; right-click row →
"Ẩn vào tab Khác" / "Đưa về tab Chính" with optimistic UI + rollback.
Field name matches ZaloCRM-3.0 — `archivedAt` was rejected in favor of
toggle-state `tab`.

### 0024 — Dual name display (CRM Name + Zalo Name) ✅ SHIPPED
**Status:** ✅ Shipped (PR #58) — see [SPEC](docs/features/0024-dual-name-display/SPEC.md).
**Scope shipped:** `Contact.zaloDisplayName` field, auto-synced from
inbound message handler with no-overwrite policy on rep-owned `fullName`.
FE: ConversationList, ChatHeader, and Customer360 show muted secondary
text via `use-contact-name` composable when CRM name differs from Zalo
name (case-insensitive trim compare). Backend strips `zaloDisplayName`
from PUT body (rep-read-only).

### 0025 — Inline video player ✅ SHIPPED
**Status:** ✅ Shipped — see [SPEC](docs/features/0025-video-player/SPEC.md).

### 0026 — Mention rendering + auto-complete ✅ SHIPPED
**Status:** ✅ Shipped (PR #77) — see [SPEC](docs/features/0026-mention-rendering/SPEC.md).
**Scope shipped:** Backend `GET /api/v1/conversations/:id/members` (5min
cache, `chat` ACL) sourced from zca-js `getGroupInfo`. FE parses
`@<uid>` tokens via regex, renders styled chip with muted fallback for
unknown UIDs. New `MentionPicker.vue` opens on `@` at word-start with
keyboard nav (↑/↓/Enter/Esc) and prefix filter. Wire format is raw
`@<uid>` tokens — zca-js native.

---

## P1 — feature parity with 3.0

### 0027 — MinIO/S3 file storage + attachment mirror
**Status:** ✅ shipped
**Source:** v3.0 release notes — "MinIO/S3 storage", "Chat attachments
mirror lên MinIO".
**SPEC:** [`docs/features/0027-minio-attachment-mirror/SPEC.md`](docs/features/0027-minio-attachment-mirror/SPEC.md)
**What shipped:**
- `minio` + `minio-init` services in `docker-compose.yml` and
  `docker-compose.dev.yml`, plus a `minio_data` volume.
- `backend/src/shared/storage/minio-client.ts` — official `minio` SDK
  wrapper. `uploadBuffer()` + `ensureBucket()`. Called from `app.ts`
  startup (process exits if MinIO unreachable — EC-0001).
- Outbound: `POST /api/v1/conversations/:id/attachments` uploads to
  MinIO BEFORE forwarding to Zalo. `Message.content` now stores the
  MinIO URL; `attachments[]` gets a `url` field. New error codes:
  `storage_failed` / `zalo_send_failed`.
- Inbound: `message-handler.ts` mirrors `image/video/file` Zalo CDN
  URLs to MinIO (best-effort). The JSON envelope's `href`/`hdUrl`/
  `thumb` fields are rewritten in place; mirror failure keeps the
  original URL (BR-0008).
- 6 env vars: `S3_ENDPOINT`, `S3_PUBLIC_URL`, `S3_BUCKET`,
  `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`.
- API.md documents the URL pattern + new error codes.
**Out of scope (deferred to phase 2):** retention policy, orphan sweep
job, signed URLs, per-org buckets, dedup, FE storage usage dashboard,
backfill of pre-0027 Zalo CDN URLs.

### 0028 — Sticker support (proxy `getStickersDetail` + picker) ✅ SHIPPED
**Status:** ✅ Shipped (PR #74) — see [SPEC](docs/features/0028-sticker-support/SPEC.md).
**Scope shipped:** Inbound sticker `contentType` detection + inline `<img>`
render. POST `/conversations/:id/stickers` calls zca-js `sendSticker`,
persists Message + emits Socket.IO event. Proxy GET endpoints for
`getStickersDetail` (24h cache) and a Phase-1 hardcoded catalogue. New
`StickerPicker.vue` triggered from composer button with parallel URL
hydration. Phase 2: full catalogue browser + custom stickers.

### 0029 — Bank/QR card render (zinstant cards) ✅ SHIPPED
**Status:** ✅ Shipped (PR #73) — see [SPEC](docs/features/0029-bank-qr-card-render/SPEC.md).
**Scope shipped:** Backend `detectContentType` recognises Zalo zinstant
payloads (marker or appId+params shape). FE `parseZinstant` tolerant
parser + new `ZinstantCard.vue` with click-to-copy account number /
amount / QR image (fullscreen preview). Falls back to muted "Thông tin
Zalo" chip on unknown shapes (EC-0001). Render mirrored into the
Feature 0043 virtual-scroll path. Phase 2: outbound composer.

### 0030 — Zalo user info popup (avatar click in group) ✅ SHIPPED
**Status:** ✅ Shipped (PR #69) — see [SPEC](docs/features/0030-zalo-user-popup/SPEC.md).
**Scope shipped:** `GET /api/v1/zalo/users/:uid?accountId=X` endpoint
(10min cache, `chat` ACL, query-param permission gate). Response cross-
references Contact table to expose `contactId` (or null). FE
`UserInfoPopover.vue` opens on avatar click in groups (self-skipped),
with outside-click + Esc dismiss. "Tạo Contact" button reuses existing
`ContactDetailDialog` via new optional `ContactPrefill` prop; "Xem trong
CRM" router-pushes to Customer360. Response augmented with `online` and
`cached` flags for FE transparency.

### 0031 — Reply / quote message ✅ SHIPPED
**Status:** ✅ Shipped (PR #79) — see [SPEC](docs/features/0031-reply-quote/SPEC.md).
**Scope shipped:** `Message.replyToMessageId` FK self-ref (SET NULL on
delete) + index. POST validates same-conversation/same-org, builds
zca-js `quoted` arg. GET projection eager-loads `replyToMessage` with
200-char content truncation. Inbound parser sets FK when local target
exists or falls back to `quotedMeta` envelope in content (BR-0006 /
EC-0006). FE hover Reply action, composer reply preview banner with ✕
clear, nested quote bubble with scroll-to-source + 1s highlight in both
v-for and VVirtualScroll render paths.

### 0032 — Hd image preview (uploadAttachment first) ✅ SHIPPED
**Status:** ✅ Shipped (PR #68) — see [SPEC](docs/features/0032-hd-image-preview/SPEC.md).
**Scope shipped:** Outbound Zalo-CDN fallback path now calls
`api.uploadAttachment` first, validates non-empty `hdUrl` (falls through
`hdUrl → normalUrl → fileUrl → url` for zca-js shape variance), and
only then calls `sendMessage`. Empty hdUrl → 502 `upload_failed`. Path
selection by new `MINIO_ENABLED` env (default true) so Feature 0027
strict contract is preserved on MinIO-opted deployments. `content.thumb`
+ `attachments[0].hdUrl` populated consistently for future export.

### 0033 — Friend aggregates (chattingNicksCount, acceptedNicksCount) ✅ SHIPPED
**Status:** ✅ Shipped (PR #57) — see [SPEC](docs/features/0033-friend-aggregates/SPEC.md).
**Scope shipped:** `GET /api/v1/friends/stats` returns `byAccount[]` +
`totals` + `windowDays`. Owner/admin see whole org; members see only
accounts with `ZaloAccountAccess`. Two `$queryRaw` aggregates (accepted
COUNT + chatting COUNT(DISTINCT contactId) over `friends ⋈ conversations
⋈ messages`). Configurable `FRIEND_ACTIVE_WINDOW_DAYS` env (default 7).
New composite index `messages (conversation_id, sender_type, sent_at
DESC)`. In-memory cache 60s per `(orgId, userId)`. FE adds 2 columns to
ZaloAccountsView. EXPLAIN ANALYZE confirms index usage.

### 0034 — Contact merge by Zalo globalId ✅ SHIPPED
**Status:** ✅ Shipped (PR #70) — see [SPEC](docs/features/0034-contact-merge-globalid/SPEC.md).
**Scope shipped:** `Contact.zaloGlobalId` + composite index. Inbound
handler reads `globalId` from cached `getUserInfo` profile (camelCase or
snake_case), applies no-overwrite policy on conflict. New
`globalId_exact` strategy in `duplicate-detection.ts` (confidence 1.0)
registered in `duplicate-service.ts`. Merge logic carries globalId to
primary; warns + keeps primary on conflict. FE `DuplicateGroupsView`
filter + chip label updated.

### 0035 — Per-account proxy config (UI) ✅ SHIPPED
**Status:** ✅ Shipped (PR #59) — see [SPEC](docs/features/0035-per-account-proxy/SPEC.md).
**Scope shipped:** `ZaloAccount.proxyUrl` (admin-only PUT/GET visibility,
stripped from non-admin responses). Validation accepts http/https/socks/
socks5; normalises `socks://` → `socks5://`. `buildProxyAgent` passes
agent to `new Zalo({agent})` via test-injectable seam. `maskProxyUrl`
helper redacts credentials in logs. `requiresReconnect` flag in PUT
response when changing on a connected account. Proxy-unreachable errors
preserve `disconnected` status (avoid clobbering session).

---

## P2 — moonshots / strategic

### 0036 — AI reply suggestions (multi-provider, BYOK) ✅ SHIPPED
**Status:** ✅ Shipped (PR #87) — see [SPEC](docs/features/0036-ai-reply-suggestions/SPEC.md).
**Scope shipped:** Per-org BYOK config — 6 providers: Anthropic, OpenAI,
Gemini, Qwen, Kimi (OpenAI-compat), Ollama. AES-256-GCM key encryption
via HKDF-derived per-org sub-keys. Suggestion content NEVER persisted;
only metadata logged in `AiSuggestionLog` (tokens, cost, latency).
On-demand generation with 5min cache + transactional quota check
(per-org daily + per-user hourly soft cap). Prompt-injection hardening
+ `escapeXmlBoundary` ported from 3.0. POST `/conversations/:id/ai-
suggestions` returns 3 suggestions as JSON array. FE chip strip below
composer + SettingsAiConfigView. **70 tests passing.** Did NOT replicate
3.0's Anthropic dual-auth-header bug (use `x-api-key` only).
**Phase 2 backlog:** tone presets, per-rep prompt override, streaming,
suggestion ranking ML, voice transcription, image understanding.

### 0037 — Workflow automation engine ✅ SHIPPED (phase 1)
**Status:** ✅ Shipped (PR #78) — see [SPEC](docs/features/0037-workflow-engine/SPEC.md).
**Scope shipped:** Two new Prisma models (`WorkflowDefinition`,
`WorkflowExecution`). Phase 1 trigger: `inbound_message` with sub-filters.
Step types: `send_message`, `add_tag`, `assign_user`, `wait`. Cron-style
worker ticks every 60s with `tickRunning` singleton flag. Trigger hook
fires from `zalo-listener-factory.ts` as fire-and-forget. Template var
substitution `{{contactName}}`, `{{repName}}`. 24h re-trigger cooldown.
FE `SettingsWorkflowsView.vue` + `WorkflowEditor.vue` with admin guard.
**Phase 2 backlog:** branching, time-based triggers, more step types,
`FOR UPDATE SKIP LOCKED` for multi-process worker.

### 0038 — Integration Hub framework + Sheets + Telegram ✅ SHIPPED (phase 1)
**Status:** ✅ Shipped (PR #86) — see [SPEC](docs/features/0038-integration-hub/SPEC.md).
**Scope shipped:** Generic `Integration` model + `IntegrationRun` audit
log. AES-256-GCM encrypted config (reused 0036's helper via
`encryptConfig/decryptConfig` shim). Connector interface (not switch-
dispatcher per 3.0 critique). 2 connectors:
- **Google Sheets**: OAuth 2.0 refresh-token flow, `googleapis@130`,
  chunked write at 1000 rows/batch, schedule cron `daily | hourly | manual`.
- **Telegram Bot**: token + chat ID + event subscriptions
  (contact.created, order.created, appointment.reminder). SSRF guard
  ported from 3.0's `zapier-webhook.ts:24-35` applied to apiEndpoint
  override.
Worker every 5 min with `tickRunning` singleton flag. Webhook event tee
fan-out from `emitWebhook()` (3.0 missed this coupling). FE
SettingsIntegrationsView + per-connector forms + composable. **All 12
ACs + 19 backend integration tests passing.**
**Phase 2 backlog:** Facebook Messenger, Zapier generic webhook, Slack,
WhatsApp Business, two-way Sheets sync, custom event templates, cron-
expression UI, couple with workflow engine (0037) actions.

### 0039 — Mobile responsive layout ✅ SHIPPED (phase 1, no PWA)
**Status:** ✅ Shipped (PR #85) — see [SPEC](docs/features/0039-mobile-responsive/SPEC.md).
**Scope shipped (scope-cut from original "Mobile PWA"):** Layout
switcher in `App.vue` using Vuetify `useDisplay().smAndDown` (ported
from 3.0 pattern, but swapped 3.0's custom `useMobile()` watcher for
Vuetify's). New `MobileLayout.vue` slim wrapper + `MobileBottomNav.vue`
(4 tabs: Chat / Khách / Bạn bè / Khác — kept Friends, dropped 3.0's
Lịch hẹn into the More drawer). ContactsView card-list mode at xs/sm
(ported 3.0's `MobileContactView.vue` markup — tonal cards + chip strip
+ debounced search + FAB at `bottom:88px`). 44px touch-target floor
enforced via `@media (max-width: 600px)` tokens (3.0 didn't enforce).
Safe-area-inset for iOS notch. Feature 0042's mobile chat pane switch
preserved. **170 FE tests pass, 20 new.**
**Phase 2/3 backlog:** PWA shell (manifest.json + service worker),
offline mode, outbound message queue with conflict reconciliation, web
push notifications, native iOS/Android app (separate product call).

### 0040 — Lead scoring + Contact Intelligence ✅ SHIPPED (rules-based)
**Status:** ✅ Shipped (PR #72) — see [SPEC](docs/features/0040-lead-scoring/SPEC.md).
**Scope shipped:** On-demand 0-100 score (no denormalize). Components:
recency (max 40) + engagement (max 30) + status (max 20) + appointment
(max 10), all configurable via `Organization.leadScoreConfig` JSON.
GET/PUT/DELETE `/api/v1/settings/lead-score-config` (admin-only). Batch
service uses 3 aggregate queries; 100 contacts + 1000 messages → 5ms
(target was 200ms). FE `LeadScoreBadge` + `SettingsLeadScoreView`,
contact list new "Lead" column.
**Phase 2 backlog:** ML embeddings, time-decay weights, score history,
threshold alerts.

### 0041 — Advanced analytics (funnel / team perf) ✅ SHIPPED (phase 1)
**Status:** ✅ Shipped (PR #76) — see [SPEC](docs/features/0041-advanced-analytics/SPEC.md).
**Scope shipped:** Two admin-only endpoints. `GET /analytics/funnel`
returns stage counts (`new → contacted → interested → converted`) +
next-stage conversion rates (snapshot semantics — no status-history
table). `GET /analytics/team-performance` returns per-rep avg response
time (window function), outbound count, converted count, active conv
count. Cross-org `orgId` filter always applied. Perf: funnel 4ms,
team-perf 71ms on 10k contacts + 30k messages (target 500ms). FE
`AnalyticsView` + `FunnelChart.vue` + `TeamPerfTable.vue`.
**Phase 2 backlog:** Report builder (visual query designer), cumulative
funnel with status history, CSV export, scheduled email reports.

---

## P3 — polish

### 0042 — UI refactor: 3-page Smax layout (chat / contacts / friends) ✅ SHIPPED
**Status:** ✅ Shipped (PR #75) — see [SPEC](docs/features/0042-ui-refactor-smax/SPEC.md).
**Scope shipped:** ChatView 320px fixed left rail + mobile pane switch.
ConversationList 64px rows + red unread badge. ContactsView 40px dense
rows + 7 visible columns (kept Feature 0040 Lead column in 1280px width).
New FriendsView grid + FriendCard with filter/search. Backend `GET
/api/v1/friends?accountId=&search=&page=` endpoint with ACL. Old "Kết
bạn" lifecycle view moved to `/friendship-attempts`; sidebar has both.
Tokens extended in `tokens.css`.

### 0043 — Perf: faster conversation switching ✅ SHIPPED
**Status:** ✅ Shipped (PR #71) — see [SPEC](docs/features/0043-perf-conversation-switch/SPEC.md).
**Scope shipped:** New `use-conversation-prefetch.ts` composable: 200ms
hover debounce → background fetch + 5min cache + in-flight dedupe.
`MessageThread.vue` switches between v-for (≤100 msgs) and
`VVirtualScroll` (>100 msgs, Vuetify-native, no new dep). Cache-miss
shows `MessageSkeleton.vue` bubbles instead of blank flash. Dev-only
`performance.mark` instrumentation logs perceived latency. Cached
switches measured at ≤16ms render (target 200ms).

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
