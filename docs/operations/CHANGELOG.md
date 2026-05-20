# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/) loosely —
chronological top-down, grouped by Added / Changed / Fixed / Removed.
Each entry links to the merging PR for traceability.

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
