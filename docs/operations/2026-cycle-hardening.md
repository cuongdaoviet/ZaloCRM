# 2026-05 Cycle — Hardening Checklist

Generated 2026-05-21 after shipping 16 features (0024–0043 minus the 3
held items). This document is the punch list for QA + perf verification
before the next release tag.

---

## Part 1 — Manual chat-surface QA

The chat thread is the hot zone. Six features now share `MessageThread.vue`
and `use-chat.ts`. Walk every path in **one** real conversation and
**one** real group conversation.

### Smoke path A — User-to-user conversation

- [ ] Open conversation. Header shows CRM name + muted Zalo name when
      they differ (Feature 0024 — `use-contact-name.secondaryZaloName`).
- [ ] Send a text message. Bubble appears immediately.
- [ ] Send an image attachment. Preview renders without spinner stuck.
      Verify URL is MinIO (or Zalo CDN when MINIO_ENABLED=false).
- [ ] Hover own message → Reply button visible. Click → composer banner
      appears with truncated content + ✕ to clear (Feature 0031).
- [ ] Send the reply. Quote bubble renders nested above text.
- [ ] Click quote bubble → list scrolls + 1s highlight (Feature 0031).
- [ ] Send a sticker via composer button (Feature 0028). Picker opens,
      filter empty, click a sticker → message renders inline.
- [ ] React to a message (Feature 0021). Reaction chip appears below.
- [ ] Switch to another conversation. Cached → instant render (Feature
      0043). Open DevTools console, look for
      `[perf 0043] conv switch render: <N>ms` — should be <50ms.
- [ ] Hover an unselected conversation row for 200ms+ → DevTools Network
      shows GET messages fired in background.
- [ ] Scroll to a conversation with >100 messages. DevTools Elements →
      message list uses `<v-virtual-scroll>` (data-testid
      `virtual-message-list`). DOM node count stays bounded as you scroll.

### Smoke path B — Group conversation

- [ ] Open a group conversation. Member roster loads on first open
      (Feature 0026 — fetch `/conversations/:id/members`).
- [ ] Look for a message that contains `@<uid>` token. It should render
      as a styled chip with the member's displayName. Unknown UID → muted
      fallback chip.
- [ ] Click a non-self avatar → UserInfoPopover opens with name + avatar
      (Feature 0030). Self avatar → no popover.
- [ ] If the user has a CRM contact: "Xem trong CRM" navigates to the
      contact detail.
- [ ] If the user has NO CRM contact: "Tạo Contact" opens
      `ContactDetailDialog` with prefill (zaloUid + avatar). Save creates
      a real contact.
- [ ] Esc closes popover. Click outside closes popover.
- [ ] Compose `@` at the start of a message → MentionPicker opens with
      top members. Type 2–3 chars → filter narrows. Enter or click →
      `@<uid>` injected with trailing space; caret after space.
- [ ] Compose an email-containing message like `user@example.com` →
      picker does NOT open (BR-0004 word-start guard).
- [ ] Send a message with a mention. Verify it appears in DB with raw
      `@<uid>` content and renders as a chip on receive.
- [ ] If a customer has sent a Zalo bank-transfer card recently:
      `ZinstantCard` renders with click-to-copy account number + QR
      image preview (Feature 0029). Unknown zinstant payload → "Thông
      tin Zalo" muted chip.

### Edge cases worth poking

- [ ] Open a conversation, hide it to the "Khác" tab (Feature 0023),
      send an inbound message → auto-promote back to "Chính" and badge
      counts refresh.
- [ ] Reply to a deleted message → fallback "không khả dụng" muted text.
- [ ] Mention a UID that's not in the group anymore → muted fallback chip.
- [ ] Composer in user-to-user conversation: `@` doesn't open picker
      (group-only per BR-0003).
- [ ] Send a sticker, then react to it, then reply-quote it. All three
      decorations stack correctly.

---

## Part 2 — Workflow worker singleton (Feature 0037)

The workflow runner uses a `tickRunning` module-level flag, not a
Postgres advisory lock. That's safe for the single-worker deployment we
ship today but **WILL break under multi-process**. Verify before scaling:

- [ ] Single process (current default) — start backend, create a
      workflow with `inbound_message` trigger and a `send_message` step.
      Send an inbound message. Step should fire within 60s. Run twice in
      24h cooldown window — second run should NOT create a new execution.
- [ ] Multi-process check (manual, before scaling): start 2 backend
      processes pointing at the same DB. Trigger the workflow. Confirm
      BOTH processes log `[workflow-runner] tick` but only ONE execution
      progresses (one will skip because `tickRunning` is true locally,
      but the SAME execution will be picked up by both because the row
      isn't locked). **This is the known phase-2 gap.** Document in
      runbook and gate scaling.

Phase-2 fix: replace `tickRunning` with `SELECT FOR UPDATE SKIP LOCKED`
in the findMany→update pattern. Tracked in 0037 SPEC §8 "Out of scope".

---

## Part 3 — Database EXPLAIN ANALYZE reruns

Re-run with prod-sized data (not the seed in tests). Goal: confirm
indexes hold up at scale and there are no Seq Scans on hot paths.

### Friend stats (Feature 0033)

Existing coverage: `backend/tests/integration/friend-stats.integration.test.ts:329`
runs EXPLAIN ANALYZE inline against a 3,000-message fixture and asserts
the composite `messages (conversation_id, sender_type, sent_at DESC)`
index is used.

- [ ] Re-run against production-shaped DB (50k+ contacts, 1M+ messages).
- [ ] Capture plan output. Confirm `Index Cond:
      conversation_id=$1 AND sender_type='contact' AND sent_at >= ...`
      hits. No `Seq Scan on messages`.
- [ ] If a Seq Scan appears → the index is missing or stale; rerun
      `prisma db push` or check the migration.

Query (paraphrased — see service file for exact):
```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT f.zalo_account_id, COUNT(DISTINCT f.contact_id) AS chatting
FROM friends f
JOIN conversations c ON c.contact_id = f.contact_id
  AND c.zalo_account_id = f.zalo_account_id
JOIN messages m ON m.conversation_id = c.id
  AND m.sender_type = 'contact'
  AND m.sent_at >= NOW() - INTERVAL '7 days'
WHERE f.org_id = $1
  AND f.zalo_account_id = ANY($2)
  AND f.contact_id IS NOT NULL
GROUP BY f.zalo_account_id;
```

### Analytics — team performance (Feature 0041)

`backend/src/modules/analytics/analytics-service.ts` runs two
`$queryRaw` queries that join contacts ⋈ users ⋈ messages with a
window function for first-response time. SPEC perf target was 500ms on
10k contacts + 100k messages; agent measured 71ms.

- [ ] Run against production-shaped DB (same volumes as friend stats).
- [ ] `EXPLAIN ANALYZE` the response-time CTE specifically. Confirm
      window function uses an existing index on
      `messages(conversation_id, sent_at)`.
- [ ] If response > 500ms, profile and consider materialized view for
      first-response per conversation (Phase 2 candidate).

### Lead scoring batch (Feature 0040)

Batch service runs 3 aggregate queries: contacts SELECT, messages JOIN
with `COUNT FILTER` + `MAX`, appointments. Measured at 5ms on 100
contacts + 1000 messages.

- [ ] Re-run on prod-shaped DB at the largest paginated `GET /contacts`
      call (e.g. perPage=100).
- [ ] Confirm < 200ms even at peak (SPEC BR-0010).
- [ ] If slow, the messages aggregate is the likely bottleneck — verify
      `messages (contact_id_via_conv, sent_at)` is indexed or that the
      query uses `messages (conversation_id, sent_at)` via the
      contacts→conversations join.

---

## Part 4 — Backend regression sanity

- [ ] Run `pnpm test` in `backend/`. Expect ~900+ tests passing across
      ~55 files. Note any flaky tests.
- [ ] Run `pnpm typecheck` (or `pnpm build`) in `backend/`. Clean.
- [ ] Run `pnpm type-check` + `pnpm build` in `frontend/`. Clean.
- [ ] Spot-check `docs/design/API.md` mentions all new endpoints
      (probably stale for: `/friends/stats`, `/conversations/:id/members`,
      `/zalo/users/:uid`, `/zalo/stickers/...`, `/conversations/:id/stickers`,
      `/analytics/funnel`, `/analytics/team-performance`,
      `/settings/lead-score-config`, `/workflows`, `/zalo-accounts/:id`
      proxy PUT, **`/conversations/:id/ai-suggestions`**,
      **`/settings/ai-config`**, **`/settings/ai-usage`**,
      **`/integrations`** + sub-routes, **`/integrations/oauth/google/callback`**).
      Update API.md as a follow-up PR if missing.

---

## Part 4b — Cycle-2 features (0036 / 0038 / 0039)

Three features shipped after the original cycle close. They share new
load-bearing infrastructure that needs explicit verification:

### Shared crypto helper (`encrypt-config.ts`)

Both 0036 (AI keys) and 0038 (integration configs) encrypt secrets via
the same AES-256-GCM helper with HKDF-derived per-org sub-keys. **Losing
`AI_CONFIG_MASTER_KEY` = losing every BYOK key + every OAuth refresh
token + every Telegram bot token.**

- [ ] **Production env:** `AI_CONFIG_MASTER_KEY` is set to a real
      64-char hex value (NOT the placeholder zeros). Verify with
      `printenv AI_CONFIG_MASTER_KEY | wc -c` → 65.
- [ ] **Backup location documented in RUNBOOK.** Master key rotation
      strategy is captured as a phase-2 task (currently requires bulk
      re-encrypt migration; no in-place rotation yet).
- [ ] **Master key NOT in git.** Grep `git log -p -S "AI_CONFIG_MASTER_KEY"`
      to confirm no plaintext value was ever committed.
- [ ] **Logs don't leak keys.** Sample backend logs for `AI_CONFIG`,
      `apiKeyCipher`, `configCipher` strings — should appear only in
      `[***]` form or not at all.

### 0036 — AI reply suggestions

- [ ] **At least one provider tested end-to-end** in staging with real
      key. Verify chip strip renders + click fills composer + send
      works.
- [ ] **Per-org daily quota enforced.** Configure low cap (e.g. 5), make
      6 requests, observe 429 on the 6th.
- [ ] **Per-user hourly soft cap enforced.** Same test pattern.
- [ ] **Anthropic provider sends ONLY `x-api-key`.** Inspect outbound
      request with `tcpdump` or proxy log on test env. Bug-not-reproduced
      is the goal (3.0 sent both `x-api-key` AND `Authorization: Bearer`).
- [ ] **No suggestion content in DB.** `SELECT * FROM ai_suggestion_logs
      LIMIT 5` — confirm columns are metadata only (tokens, cost, error_code).
- [ ] **Provider switch works.** Switch from Anthropic to OpenAI in
      Settings, verify next suggestion fetch hits the new provider.
- [ ] **Rate-limit gaming guard.** Disable + re-enable AI does NOT reset
      the quota counter (it's by `(orgId, date)` in DB, not config).

### 0038 — Integration Hub (Sheets + Telegram)

- [ ] **Google Sheets OAuth flow** — admin authorizes, real Sheet is
      exported with correct headers + filter applied.
- [ ] **Sheets chunking at 1000 rows/batch** — seed > 2000 contacts,
      observe two batched writes in the IntegrationRun log.
- [ ] **Refresh token invalidation surfaced** — manually revoke the
      Google grant, observe next sync writes `lastError` and FE banner
      appears.
- [ ] **Telegram bot test message** — admin pastes token + chat ID,
      "test connection" button delivers a message to the channel.
- [ ] **Webhook event tee** — create a contact via API, observe Telegram
      channel receives `🆕 KH mới: <fullName>...` within 5 seconds.
- [ ] **Event subscription filter** — uncheck `order.created` for the
      integration, create an order, confirm NO Telegram message fires.
- [ ] **SSRF guard active** — manually set Telegram apiEndpoint to
      `http://127.0.0.1:8080` (or any private IP) → save should reject.
- [ ] **Worker singleton** — start 2 backend processes, observe only one
      tick proceeds per cycle (known phase-2 gap: process-level singleton,
      not Postgres advisory lock).
- [ ] **Disabled integration skipped** — toggle off, create contact,
      confirm Telegram + Sheets sync skip.

### 0039 — Mobile responsive

- [ ] **Three viewports** (360 / 768 / 1280px) — chat send/receive,
      contacts list (card mode at xs/sm), friends grid (1/2/3 cols).
- [ ] **iOS Safari smoke** on real device — bottom nav clears notch,
      tap targets feel right.
- [ ] **Android Chrome smoke** on real device.
- [ ] **Rotate device mid-session** — layout reflows cleanly, no frozen
      state.
- [ ] **44px touch-target audit** — DevTools "inspect" each bottom-nav
      button, list row, and primary CTA at 360px viewport. Min hit area
      ≥ 44×44 px.
- [ ] **Feature 0042 chat pane switch** still works (tap conversation
      → thread fills screen → back button visible).
- [ ] **Settings flows on mobile** — open each Settings page at 360px,
      forms readable, save buttons reachable (sticky at bottom on long
      forms per EC-0005).

---

## Part 5 — Phase 2 backlog (captured here so we don't lose them)

Each shipped feature has a "Phase 2" section in its SPEC. Highlights:

- **0027** — retention policy, orphan sweep, signed URLs, per-org buckets,
  dedup, FE storage dashboard.
- **0028** — full sticker catalogue browser, custom uploads, favorites,
  search.
- **0029** — outbound bank card composer, non-bank zinstants, QR scan.
- **0031** — forward message, quote thread expansion, group reply with
  @mention auto-add.
- **0033** — denorm aggregates if perf drops; trend chart; per-user
  breakdown.
- **0034** — auto-merge on globalId match, backfill historical contacts.
- **0035** — proxy health check, failover pool, org-level default,
  audit log, encryption-at-rest.
- **0037** — branching, time-based triggers, more step types, multi-
  process worker (`SKIP LOCKED`).
- **0040** — ML embedding score, time-decay weights, score history,
  threshold alerts.
- **0041** — report builder, cumulative funnel, CSV export, scheduled
  email reports.
- **0042** — drag-to-resize rails, custom column order, friends bulk
  actions.
- **0043** — service-worker offline cache, persistent prefetch across
  reload, predictive prefetch.
- **0036** — tone presets, per-rep prompt override, streaming responses,
  suggestion ranking ML, voice transcription, image understanding,
  master-key rotation tooling.
- **0038** — Facebook Messenger, Zapier generic webhook, Slack,
  WhatsApp Business, two-way Sheets sync, custom event templates,
  cron-expression UI, couple workflow engine (0037) with integrations.
- **0039** — PWA shell (manifest.json + service worker), offline mode +
  outbound queue with conflict reconciliation, web push notifications,
  native iOS/Android app (separate product call required).

### Cross-cutting phase-2 work

- **Master-key rotation** — `AI_CONFIG_MASTER_KEY` rotation requires
  bulk re-encrypt migration today. Build tooling.
- **Multi-process worker locks** — Features 0037 and 0038 both use
  module-level `tickRunning` singleton flag. Migrate to Postgres
  `SELECT FOR UPDATE SKIP LOCKED` when we scale to >1 backend process.
- **API.md refresh** — many new endpoints from this cycle aren't in
  the design doc yet.

---

## Sign-off

Once all parts pass on staging, tag the release. **All 19 features
from the original audit are now shipped.** Phase 2 work above is the
next prioritization conversation.
