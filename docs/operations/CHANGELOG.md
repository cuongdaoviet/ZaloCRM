# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/) loosely —
chronological top-down, grouped by Added / Changed / Fixed / Removed.
Each entry links to the merging PR for traceability.

---

## [Unreleased] — 2026-05-21

A multi-day drain of the entire ZaloCRM-3.0 audit backlog plus three
phase-2 operational items and a security hardening pass. **27 features
shipped** (0022–0046), all merged through PR review with CI green.
Backend test count grew from 675 → 1083+; frontend tests from ~35 →
183+.

### Added

#### Daily-life features (P0)

- **Conversation filters** (feature 0022, PR #44) — chip-row filter
  (`unread` / `unreplied` / date range / tags) above conversation list
  + new `GET /api/v1/conversations/counts` aggregate. State persisted
  via user-preferences KV.
- **Hide / archive conversations** (feature 0023, PR #46) — `Conversation.tab`
  string field (`main | other`) + Chính/Khác tab UI, right-click context
  menu, auto-promote on inbound contact message.
- **Dual name display** (feature 0024, PR #58) — `Contact.zaloDisplayName`
  auto-synced from inbound; CRM name primary, Zalo name muted secondary.
- **Inline video player** (feature 0025) — `<video controls>` with
  Zalo-provided thumbnail as poster (~30 LOC).
- **@mention rendering + auto-complete** (feature 0026, PR #77) —
  `GET /api/v1/conversations/:id/members` (5min cache), styled chip
  render in MessageThread, `@` trigger MentionPicker in composer.

#### Feature parity with 3.0 (P1)

- **MinIO/S3 attachment mirror** (feature 0027, PR #49) — outbound +
  inbound mirror, 6 env vars, anonymous-read bucket policy, retry on
  fail.
- **Sticker support** (feature 0028, PR #74) — inbound render +
  composer picker (phase-1 hardcoded catalogue) + proxy endpoints.
- **Bank/QR zinstant card render** (feature 0029, PR #73) — tolerant
  parser + ZinstantCard component with click-to-copy + QR preview.
- **Zalo user info popup** (feature 0030, PR #69) — `GET /api/v1/zalo/users/:uid`
  (10min cache), popover on avatar click with "Tạo Contact" prefill flow.
- **Reply / quote message** (feature 0031, PR #79) — `Message.replyToMessageId`
  FK self-ref + zca-js `quoted` outbound + nested quote bubble with
  scroll-to-source.
- **HD image preview** (feature 0032, PR #68) — outbound fallback path
  calls `api.uploadAttachment` first, validates non-empty `hdUrl` before
  `sendMessage`. Closes 3.0 v3.0 bug-fix "Image preview rỗng".
- **Friend aggregates** (feature 0033, PR #57) — `GET /api/v1/friends/stats`
  with `acceptedNicksCount` + `chattingNicksCount` per ZaloAccount,
  60s cache, EXPLAIN ANALYZE-tested.
- **Contact merge by Zalo globalId** (feature 0034, PR #70) —
  `Contact.zaloGlobalId` + 4th duplicate detection strategy at
  confidence 1.0.
- **Per-account proxy config** (feature 0035, PR #59) — `ZaloAccount.proxyUrl`
  with HTTP/HTTPS/SOCKS5 support, encrypted at rest (extended in
  feature 0044), masked in logs.

#### Moonshots (P2)

- **AI reply suggestions (BYOK)** (feature 0036, PR #87) — 6 providers
  (Anthropic, OpenAI, Gemini, Qwen, Kimi, Ollama), AES-256-GCM
  encrypted keys, 5min cache, prompt-injection hardening ported from
  3.0, per-org + per-user rate limits.
- **Workflow automation engine** (feature 0037, PR #78) —
  `WorkflowDefinition` + `WorkflowExecution`, 1 trigger type
  (`inbound_message`), 4 step types, cron worker.
- **Integration Hub** (feature 0038, PR #86) — generic Integration
  model + Google Sheets (OAuth) + Telegram bot (webhook tee from
  emitWebhook).
- **Mobile responsive layout** (feature 0039, PR #85) — phase-1
  cut from PWA: layout switcher, MobileBottomNav, MobileContactView,
  44px touch targets. NO service worker / offline.
- **Lead scoring** (feature 0040, PR #72) — on-demand 0-100 score with
  configurable weights (recency / engagement / status / appointment).
- **Advanced analytics** (feature 0041, PR #76) — funnel + team
  performance dashboards with admin-only endpoints.

#### Polish (P3)

- **UI refactor 3-page Smax layout** (feature 0042, PR #75) — ChatView
  320px fixed rail + 64px conversation rows + Friends grid page.
- **Conversation switching perf** (feature 0043, PR #71) — hover
  prefetch with 5min cache + Vuetify VVirtualScroll for >100-message
  threads.

#### Operational unblockers (phase-2 cross-cutting)

- **Master-key rotation tooling** (feature 0044, PR #92) — dual-key
  read window via `AI_CONFIG_MASTER_KEY_PREVIOUS`, CLI
  `pnpm rotate-master-key`, proxyUrl encryption-at-rest (closes 0035's
  deferred plaintext gap), RUNBOOK §10 procedure.
- **Multi-process worker locks** (feature 0045, PR #93) — workflow-runner
  + integration-runner refactored to use Postgres `FOR UPDATE SKIP
  LOCKED`. Behavior-preserving; `tickRunning` flag kept as within-process
  belt-and-suspenders.
- **Security hardening** (feature 0046, PR #96) — closes all 8 CSO
  findings: fast-jwt CVE chain via `npm audit fix`, JWT_SECRET boot
  guard, MinIO bound to 127.0.0.1 + nginx proxy + required non-default
  credentials, public API keys SHA-256-hashed with lazy migration,
  OAuth state via `timingSafeEqual`, per-email login rate limit,
  Dockerfile USER directive.

### Changed

- **`docker-compose.yml`** MinIO ports — was bound to `0.0.0.0:9000`
  (publicly accessible with `minioadmin/minioadmin` defaults), now
  bound to `127.0.0.1:9000` with required non-default credentials and
  nginx reverse proxy at `/attachments/`.
- **JWT session validity** — Feature 0046 introduces a `JWT_SECRET`
  boot guard. Operators MUST set a real value before redeploying;
  existing tokens signed with the dev placeholder become invalid and
  users re-authenticate.
- **`docs/design/API.md`** — refreshed in PR #94 with ~25 new endpoints
  documented across 11 feature sections; added Feature index with
  anchors at the top.

### Fixed

- **fast-jwt CVE chain** (feature 0046) — upgraded `@fastify/jwt`
  10.0.0 → 10.1.0 pulling `fast-jwt` 6.1.0 → 6.2.4; closes
  CVE-2023-48223 incomplete-fix (CVSS 9.1 algorithm confusion via
  whitespace-prefixed RSA), cache-confusion identity mixup, RFC 7515
  crit-header violation.
- **Fastify body-validation bypass** (feature 0046) — upgraded
  `fastify` 5.8.4 → 5.8.5 closing CVE GHSA-247c-9743-5963 (CVSS 7.5).
- **OAuth state HMAC compare** (feature 0046) — was `expected !== sig`
  (timing-leak), now `crypto.timingSafeEqual`.
- **Login brute-force window** (feature 0046) — login endpoint now
  rate-limited per email (5 failures / 15 min → 429 with `Retry-After`),
  applied before bcrypt.compare so failed attempts don't waste CPU.

### Skipped (deliberate scope cuts)

- **Native iOS / Android app** — Feature 0039 phase-2 backlog. PWA shell
  + offline mode explicitly NOT shipped (half-measure). Separate product
  call required.
- **External KMS integration** (Vault / AWS KMS) — Feature 0044 phase-2.
  Phase-1 stays env-var-based.
- **Multi-process worker spawn test harness** — Feature 0045 phase-2.
  Phase-1 has single-process correctness tests + manual concurrent-tx
  lock test; full spawn-2-processes test deferred to horizontal-scaling
  rollout.

### Operational notes for upgraders

Before deploying this cycle:
1. Generate fresh `JWT_SECRET`: `openssl rand -base64 48`.
2. Generate fresh `MINIO_ROOT_USER` + `MINIO_ROOT_PASSWORD` —
   docker-compose now refuses defaults.
3. Generate fresh `AI_CONFIG_MASTER_KEY`: `openssl rand -hex 32`.
4. Update `S3_PUBLIC_URL` to nginx path (was raw MinIO port).
5. Deploy. **All users will be re-authenticated** (intentional —
   invalidates tokens signed with the dev placeholder).

See `docs/operations/RUNBOOK.md` §0046 for the full migration checklist
and `docs/operations/2026-cycle-hardening.md` Parts 4–4b for the
pre-release manual QA punch list.

---

## [Unreleased] — 2026-05-20

A single-day batch landing nine features, four bug fixes, a design-language
migration, and the full CRM tags relational rewrite (4 phases). 31 PRs
merged. Backend test count grew from 287 → 675.

### Added

#### Features

- **Activity log + audit trail** (feature 0012) — every user-driven action
  (campaigns, notes, keyword rules, etc.) writes an immutable row to
  `activity_logs`. Admin sees the whole org; members see only their own.
  New `/activity` page with entity-type + action-code + date-range
  filters. [#18]
- **Customer 360 view** (feature 0013) — one endpoint returns profile +
  lifetime stats + primary conversation snippet + orders + appointments +
  notes + activity in a single request. Member access gated by assignment
  or Zalo ACL. Lifetime revenue excludes `new` and `cancelled` orders.
  Route: `/contacts/:id`. [#19]
- **Webhook test/debug panel** (feature 0014) — `WebhookDelivery` model
  persists every outbound webhook attempt. Admin debug API lists
  attempts, shows payload + HMAC signature, and replays failures
  (re-signed with the *current* secret so partner verification works
  after key rotation). Auto-prunes to 1000 rows per org. [#20]
- **Pinned conversations** (feature 0015) — per-org "pin to top" flag for
  conversations. Pinned section in the chat list sorts by `pinnedAt DESC`.
  Pin/unpin button in the chat header and on each row. [#26]
- **User preferences KV store** (feature 0016) — per-user JSON key-value
  store so UI prefs (theme, density, filters) follow the user across
  devices instead of being trapped in `localStorage`. Validation by key
  allowlist, not value shape. `ui.theme` migrated to the new store as
  proof-of-concept. [#27]
- **Vietnamese appointment parser** (feature 0017) — pure regex parser
  extracts appointment intent from message text (`"hẹn 2pm thứ 5"`,
  `"ngày 20/5 lúc 14h"`, `"chiều mai 3 giờ"`). A chip above the chat
  input offers to create the appointment with the parsed date pre-filled.
  No external dependencies. [#28]
- **Duplicate contact detection + merge** (feature 0018) — admin scans
  contacts for duplicates by phone (normalized), Zalo UID, or fuzzy name
  (Levenshtein ≤ 2 on names ≥ 5 chars). Side-by-side review UI; merge
  re-points all conversations, orders, appointments, notes, and campaign
  targets onto a primary contact in one transaction. One-shot merge, no
  undo. [#30]
- **CRM tags as a relational model** (feature 0019, four phases) —
  replaces the freeform `Contact.tags` JSON array with proper rows
  (`CrmTag`, `CrmTagGroup`, `ZaloLabel`, `ContactTag` junction). Case-
  folded uniqueness, color + emoji per tag, group hierarchy, native Zalo
  label sync.
    - **Phase A** [#34] — schema + endpoints + frontend + dual-write to
      the legacy column so existing readers keep working.
    - **Phase A.1** [#35] — `POST /zalo-accounts/:id/sync-labels` pulls
      the Zalo native label catalog and adopts/archives CRM tags
      accordingly.
    - **Phase B** [#36] — pre-flight + backfill scripts; switched all
      contact + Customer 360 reads from the JSON column to the junction
      with enriched `{id, name, color, emoji}` payload.
    - **Phase C** [#39] — dropped the JSON column, migrated the
      remaining 7 readers (campaigns, duplicates, public API, plus the
      4 the implementer agent found in scope), deleted the now-obsolete
      backfill scripts.
- **Friend / FriendshipAttempt lifecycle** (feature 0020) — 8-state
  machine tracks the "kết bạn" flow per Zalo account: queued →
  looking_up → sent → accepted | declined | timeout | error |
  cancelled. Background worker drains the queue every 30s (lookup +
  send), respects the Zalo rate limiter, and reconciles with zca-js
  `'friend_event'` listener for accepts/declines. Auto-creates an empty
  Conversation when accepted so the rep can open chat immediately.
  New `/friends` page and bulk-enqueue action from ContactsView. [#31]
- **Message reactions** (feature 0021) — sales react to messages with
  one of 6 emojis (❤️ 👍 😆 😮 😭 😡). Outbound via zca-js
  `addReaction`; inbound via `'reaction'` listener event, pushed live to
  open chats via Socket.IO. Toggle-off semantics (same emoji twice =
  remove), override on different emoji, all matching Zalo native UX.
  Self-listen race deduped client-side. [#38]

#### Infrastructure

- **`background-tasks.ts`** utility — `trackBackground()` registers a
  fire-and-forget promise in a module-scope Set; `flushBackgroundTasks()`
  drains them. Used by tests to avoid Postgres deadlocks between
  `logActivityAsync` INSERTs and `TRUNCATE CASCADE`. [#24]
- **API reference docs** at `docs/design/API.md` — covers every
  /api/v1/* endpoint introduced by features 0012–0021. [#22, then
  expanded by every feature PR after]

### Changed

- **Design language migrated to Smax-light** [#32] — the default theme
  is now a clean enterprise-SaaS light palette (`#2962ff` primary
  instead of the previous neon cyan, `#f5f6fa` background instead of
  dark navy). The old dark "liquid" theme is preserved as
  `legacy-dark`; users with an explicit dark preference keep their
  setting. Adds `tokens.css` with the full Smax design tokens
  (palette, type scale, radii, CRM label chip colors). `main.css`
  rewritten from 320 → 230 lines, with all the cyan-glow chrome
  scoped behind `.v-theme--legacy-dark`.
- **Page-title size unified** to `text-h5` across all 18 views — was
  inconsistent (12 used `text-h4`, 6 used `text-h5`), so the heading
  visibly resized when navigating. [#23]
- **Hardcoded brand hex swapped for Vuetify theme tokens** [#23] —
  `#00F2FF` (primary), `#4CAF50` (success), `#FFB74D` (warning)
  appeared 14 times inline; all replaced with semantic tokens or
  Vuetify color props.
- **Inline section card titles** normalized to `text-body-1
  font-weight-medium` (was a mix of `text-h6`, `text-h5`, bare
  defaults). Modal dialog titles intentionally kept their larger
  default. [#23]

### Fixed

- **Chat duplicate-send** [#21] — typing in Vietnamese could send the
  same message twice. Three causes combined:
  1. Socket/HTTP race in `use-chat.ts` — both paths pushed without
     deduping. Fixed by id-based dedup on both.
  2. Vietnamese IME firing Enter on composition end. Fixed by
     `isComposing` / `keyCode=229` guard.
  3. Rapid button + Enter could re-emit before parent finished.
     Fixed with `props.sending` early-return in `handleSend`.
- **Test deadlock** [#24] — `campaigns.integration.test.ts` AC-0003
  flaked intermittently in CI. Root cause: `logActivityAsync` (and
  `emitWebhook`) start INSERTs that hold `RowShareLock` via FK
  validation; the next test's `beforeEach` ran `TRUNCATE ... CASCADE`
  wanting `AccessExclusiveLock` on the same tables, causing circular
  wait. Fixed by introducing `trackBackground()` + `flushBackgroundTasks()`
  in `resetDb()`.
- **Tier-1 follow-ups** [#33] — two carry-overs:
  - Parser regex `"thứ 2 tuần sau"` was parsing as "+2 weeks" instead
    of "Monday next week" (the `(\d+) tuần sau` regex matched the digit
    in `thứ 2`). Fixed with a weekday-keyword guard that skips the
    N-weeks branch when `thứ X` / `T2-T7` / `chủ nhật` is present.
    Also rewrote `nextWeekday` to anchor to next Monday for the
    "next-week" hint instead of `diff + 7`.
  - Pinned conversation section was sorting by `lastMessageAt DESC`
    instead of `pinnedAt DESC` — newly pinned chats didn't float to the
    top. Fixed by exposing `pinnedOrder` from the composable and
    sorting the inline section by it.

### Removed

- **`Contact.tags` JSON column** [#39] — replaced by the `ContactTag`
  junction. One-way schema migration. Forward-only fix if anything
  regresses; backup recovery required to restore.
- **`tagNames: string[]` backward-compat field** [#39] — Phase B added
  it alongside the enriched tag array; Phase C removed it now that
  every consumer uses the enriched shape.
- **`db:preflight-tags` and `db:backfill-tags` npm scripts** [#39] —
  their corresponding tests + scripts deleted; the JSON column they
  audited no longer exists.

### Documentation

- **`docs/CHERRY-PICK-NOTES.md`** [#25] — shortlist from ZaloCRM-3.0
  v3.1.2 with tiered recommendations (Tier 1 — small + high value;
  Tier 2 — worth the work; Tier 3 — bigger investment; Tier 4 —
  parked). Most Tier 1+2 items shipped in this session.
- **Tier-2 SPECs** [#29] — `0018-duplicate-detection/SPEC.md`,
  `0019-crm-tags/SPEC.md`, `0020-friendship-lifecycle/SPEC.md`.
- **Feature 0021 SPEC** [#37] — message reactions.

### Stats

- **31 PRs** merged.
- **Backend tests:** 287 → 675 passing (+388 net; CRM tags rollout
  added 51 + tests across other features; some obsolete tests
  retired in Phase C).
- **Frontend tests:** stable at 35 passing.
- **Features:** 0012 through 0021 (skipping 0011 which was already
  shipped). All Tier 1 + Tier 2 from cherry-pick notes complete;
  Tier 3 began with message reactions.

### Known follow-ups

- **Verify rType mapping** for message reactions (feature 0021,
  BR-0009) on the first live Zalo reaction event. The listener logs
  `{ rType, rIcon, mappedEmoji }` at INFO. Convention used: 1=HEART,
  2=LIKE, 3=HAHA, 4=WOW, 5=CRY, 6=ANGRY, 0=NONE. Fix is ~5 LOC if
  the table is wrong.
- **Phase 2 of message reactions** — `'old_reactions'` reconciliation
  on listener reconnect; reaction-detail modal (see who reacted with
  what); custom emoji UI rendering.
- **AI reply suggestions** (Tier 3, cherry-pick notes) — parked
  pending product call on per-token cost (~$0.75/day/org).
- **Group polls, integrations framework, mobile views** (Tier 3) —
  parked.
