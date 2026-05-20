# Cherry-pick notes — ZaloCRM-3.0 (v3.1.2)

Generated 2026-05-20 by comparing this branch's `main` against
[cuongdaoviet/ZaloCRM-3.0](https://github.com/cuongdaoviet/ZaloCRM-3.0) at
`5a47da9` (release v3.1.2).

ZaloCRM-3.0 is **not a fork** — it's an independent rewrite published as a
single squashed release. Direct `git cherry-pick` is not possible. To port
a feature you need to:

1. Copy the schema bits from `backend/prisma/schema.prisma` (and run
   `prisma generate`).
2. Copy the relevant `backend/src/modules/<name>/` files.
3. Register the routes in `backend/src/app.ts`.
4. Copy the frontend view + composable + add the route + sidebar entry.
5. Add tests using the same patterns as features 0010–0014.

The repo cloned to `/tmp/zalocrm3` for the duration of the session that
generated this file — re-clone if you've rebooted.

---

## Already covered by current main

These exist in 3.0 but are **structurally equivalent** to what we built in
features 0008–0014. Porting would be a rewrite, not an addition:

| 3.0 module | What it maps to here |
| --- | --- |
| `automation/` (AutomationRule) | Our `auto-reply/` + `campaigns/` + `keyword-rules/` |
| `analytics/` + `reports/` | Our `kpi/` + `dashboard/` + `reports` route |
| `MessageTemplate` model | Our `QuickReply` model |
| `Note` model | Our `ConversationNote` model |

Don't port these unless you want to consolidate three modules into one
(possible but a separate architectural decision).

---

## Recommended cherry-picks — by impact ÷ effort

### Tier 1: High impact, small surface

#### Pinned conversations
- **What:** Per-Zalo-account list of pinned conversations that float to the
  top of the ConversationList.
- **Schema:** one model.
  ```prisma
  model PinnedConversation {
    id             String   @id @default(uuid())
    orgId          String
    zaloAccountId  String
    conversationId String
    pinnedAt       DateTime @default(now())
    @@unique([conversationId])
  }
  ```
- **Scope:** ~150 LOC. Backend: `POST/DELETE /api/v1/conversations/:id/pin`.
  Frontend: pin icon on each conversation row, sorted section at top.
- **Why now:** Daily users live in the chat screen; promoting their top
  threads is the cheapest UX win in the list.

#### User preferences
- **What:** Generic per-user KV store (theme, density, sound, default
  filters, anything else). Replaces the current scattered
  `localStorage` reads.
- **Schema:**
  ```prisma
  model UserPreference {
    id        String   @id @default(uuid())
    userId    String
    key       String
    value     Json     @default("null")
    updatedAt DateTime @updatedAt
    @@unique([userId, key])
  }
  ```
- **Scope:** ~200 LOC. `GET /api/v1/me/preferences` + `PUT
  /api/v1/me/preferences/:key`. Frontend composable that wraps any
  Vue ref + persists.
- **Why now:** Foundation for almost every future personalization
  feature. Cheap and gets cheaper to use the more you have.

#### Pre-made appointment fallback parser
- **What:** A rule-based parser that extracts appointment intent from
  message text in Vietnamese ("hẹn 2pm thứ 5", "9h sáng mai", "ngày
  20/5"). Used as a fallback when no LLM is configured.
- **Source:** `backend/src/modules/ai/appointment-fallback-parser.ts` —
  257 lines, **no external dependencies**, pure regex + date math.
- **Why now:** Even without porting the full AI module, this parser is
  useful standalone — wire it into the existing appointment-creation
  flow as a "suggest from message" button.

### Tier 2: High value, medium scope

#### Duplicate contact detection + merge
- **What:** Background job finds duplicate contacts (matched by phone,
  zalo_uid, or fuzzy name); UI lets admin review groups and merge them.
- **Schema:**
  ```prisma
  model DuplicateGroup {
    id         String   @id @default(uuid())
    orgId      String
    contactIds String[]
    matchType  String   // phone | zalo_uid | name
    confidence Float    @default(1.0)
    resolved   Boolean  @default(false)
    createdAt  DateTime @default(now())
  }
  ```
- **Scope:** ~500 LOC. Backend: detection cron + merge service +
  routes. Frontend: review/merge dialog.
- **Why:** Duplicates accumulate the longer the CRM runs. Without
  detection they're invisible until a rep contacts the same person
  twice from different threads.

#### CRM tags (proper model, replaces JSON array)
- **What:** Tags become first-class rows with color, emoji, groups,
  and per-org uniqueness. Replaces the current `contact.tags: Json`
  array. Also syncs from Zalo's own native labels.
- **Schema:** `CrmTag`, `CrmTagGroup`, `ZaloLabel` (three models). Migration
  needs a one-time backfill from existing `contact.tags`.
- **Scope:** ~800 LOC + a careful migration. Bigger than it looks because
  every place that reads or writes `contact.tags` has to change.
- **Why:** The current JSON array can't enforce consistency (typos,
  case variants), can't be sorted/grouped in the UI, and can't sync
  with Zalo's labels. If tags matter to your workflow, this is
  worth it. If they don't, skip.

#### Friend / friendship attempt tracking
- **What:** Tracks "kết bạn" lifecycle end-to-end — queue request, look
  up zalo_uid, send invitation, record accepted/declined/timeout.
- **Schema:** `Friend` + `FriendshipAttempt` models.
- **Why:** Reps spend real time on this flow daily. Currently it's
  manual + invisible to managers.

### Tier 3: Nice-to-have

| Feature | Cost | Notes |
| --- | --- | --- |
| Message reactions (`MessageReaction`) | ~200 LOC | Mostly cosmetic for CRM; valuable if you do customer-service from groups. |
| Group polls (`GroupPoll`) | ~300 LOC + needs zca-js poll API | Niche — only useful in group chats. |
| Saved reports (`SavedReport`) | ~250 LOC | Persists filter combos as named reports. Pair this with our Activity log. |
| Mobile-optimized views | ~600 LOC | Rewrite of ChatView + ContactsView with bottom nav + larger touch targets. Big effort, big payoff if mobile is a target. |
| Branding (org logo + theme override) | ~150 LOC | Only matters if you're going multi-tenant. |
| Integrations framework | ~600 LOC + per-provider work | Sheets/Telegram/Facebook/Zapier. Each provider is its own follow-up; the framework is the entry ticket. |

### Tier 4: High WOW, high cost

#### AI reply suggestions
- **What:** When viewing a conversation, the input area shows 2–3
  suggested replies pulled from an LLM (Anthropic or OpenAI). Click
  to insert.
- **Source:** `backend/src/modules/ai/{ai-routes.ts,ai-service.ts,prompts/,providers/,provider-registry.ts}` — ~800 LOC backend.
- **Schema:** `AiConfig` (one row per org with provider + model + daily
  cap) and `AiSuggestion` (logs every suggestion + whether accepted).
- **Dependencies:** Requires an API key for at least one provider.
  Cost is real — Sonnet runs ~$3 per million tokens; with ~500
  suggestions/day at ~500 tokens each → ~$0.75/day/org.
- **Why later:** Biggest user-visible feature in the diff, but adds
  external dependency, recurring cost, and prompt-tuning maintenance.
  Treat as its own product decision, not a quiet cherry-pick.

---

## Don't port

- **`AutomationRule` / `automation/`** — would deprecate our auto-reply
  + campaigns + keyword-rules. Possible but a major refactor, not a
  cherry-pick.
- **`Status` model + status feed** — Zalo "trạng thái" feed; minimal
  utility for sales.
- **`ParentCandidate`** — internal helper for duplicate detection; only
  port together with `DuplicateGroup`.

---

## Suggested next pick

If you want one thing that ships in an afternoon and improves daily
life: **Pinned conversations**. Tier 1, ~150 LOC, no schema risk.

If you want one thing that unlocks future personalization: **User
preferences**. Tier 1, ~200 LOC, every later feature becomes cheaper.

If you want the highest user-visible payoff and can afford the
maintenance: **AI reply suggestions** (Tier 4). Plan for ~1 week
including prompt tuning.
