# API Reference — Zalo CRM

This document covers the **internal admin/CRM endpoints** under `/api/v1/`. All
require a JWT bearer token in `Authorization: Bearer <token>` and are scoped
to the caller's organization via `req.user.orgId`. Public partner endpoints
under `/api/public/` are documented separately in [API & Webhook][api-settings]
inside the app.

[api-settings]: ../../frontend/src/views/ApiSettingsView.vue

## Conventions

- **Org isolation:** every query filters by `req.user.orgId`. Cross-org access
  returns `404 Not Found` (not 403) so org existence isn't leaked.
- **Role gradient:** `owner` ≥ `admin` ≥ `member`. Member-level scoping is
  applied at the route level (e.g. activity log filters to own userId, contact
  detail requires assignment or zalo-account read access).
- **Error shape:** `{ "error": "human-readable message in Vietnamese" }`.
- **Time fields:** ISO 8601 strings (e.g. `2026-05-15T10:00:00.000Z`).
- **Pagination:** standard envelope `{ <items>, total, page, limit, totalPages }`
  where `page` is 1-indexed.

---

## Feature 0012 — Activity log

Audit trail for user-driven actions across the CRM. Internal services call
`logActivityAsync()` from `backend/src/modules/activity/activity-service.ts`
to append; this section documents the read API.

### GET `/api/v1/activity`

List activity records, newest first.

**Query parameters:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `entityType` | string | no | Filter by entity (`campaign`, `contact`, `conversation_note`, `keyword_rule`, `zalo_account`). |
| `action` | string | no | Exact match on action code (e.g. `campaign.cancelled`). |
| `userId` | UUID | no | **Owners/admins only** — filter by actor. Members are silently forced to their own id; passing a different value yields zero rows. |
| `from` | ISO date | no | Inclusive lower bound on `createdAt`. |
| `to` | ISO date | no | Inclusive upper bound on `createdAt`. |
| `page` | integer | no | Default 1. |
| `limit` | integer | no | Default 50, max 200. Negative → 400. |

**Validation errors (400):**
- `limit phải là số dương` — limit < 1 (passing `limit=0` falls back to default).
- `from không phải ISO date hợp lệ` — unparseable date.
- `from phải <= to` — inverted range.

**Response 200:**

```json
{
  "activities": [
    {
      "id": "uuid",
      "action": "campaign.cancelled",
      "entityType": "campaign",
      "entityId": "uuid",
      "details": { "reason": "rate_limit" },
      "createdAt": "2026-05-15T10:00:00.000Z",
      "user": { "id": "uuid", "fullName": "..." } | null
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 50,
  "totalPages": 1
}
```

`user` is `null` for system-driven actions (worker, auto-reply, keyword rule).

### Action catalog

| Action | Triggered from | `details` shape |
| --- | --- | --- |
| `campaign.created` | `POST /campaigns` | `{}` |
| `campaign.started` | transition to `running` | `{}` |
| `campaign.paused` | manual or rate-limit auto-pause | `{ reason? }` |
| `campaign.resumed` | manual resume | `{}` |
| `campaign.cancelled` | manual cancel | `{}` |
| `campaign.completed` | worker drains queue | `{}` |
| `contact.status_changed` | `PUT /contacts/:id` with status diff | `{ from, to }` |
| `contact.assigned` | `PUT /contacts/:id` with assignedUserId diff | `{ from, to }` |
| `note.created` | `POST /conversations/:id/notes` | `{ conversationId }` |
| `note.updated` | `PUT /conversations/notes/:noteId` | `{ conversationId }` |
| `note.deleted` | `DELETE /conversations/notes/:noteId` | `{ conversationId }` |
| `keyword_rule.fired` | inbound message matched a rule | `{ ruleId, conversationId, contactId }` |

---

## Feature 0013 — Customer 360 overview

One request returns everything the Customer 360 page needs (profile, lifetime
stats, primary conversation snippet, orders, appointments, notes, activity).

### GET `/api/v1/contacts/:id/overview`

**Path params:** `id` — contact UUID.

**Permission:**
- Owners/admins: any contact in their org.
- Members: contact must be assigned to them **OR** they must have a `read`
  permission on the Zalo account hosting the contact's primary conversation.
- Otherwise → `403`.

**Response 200:**

```json
{
  "contact": {
    "id": "uuid",
    "fullName": "...",
    "phone": "...",
    "email": "...",
    "avatarUrl": "...",
    "source": "FB",
    "status": "interested",
    "tags": ["VIP"],
    "nextAppointment": "ISO-date | null",
    "assignedUser": { "id": "uuid", "fullName": "..." } | null,
    "createdAt": "ISO-date",
    "firstContactDate": "ISO-date | null"
  },
  "stats": {
    "lifetimeRevenue": 1800000,
    "orderCount": 6,
    "completedOrderCount": 4,
    "appointmentCount": 5,
    "upcomingAppointmentCount": 1,
    "totalMessages": 47
  },
  "primaryConversation": {
    "id": "uuid",
    "zaloAccountId": "uuid",
    "lastMessageAt": "ISO-date | null",
    "unreadCount": 2,
    "recentMessages": [
      { "id": "uuid", "senderType": "self|contact",
        "content": "...", "contentType": "text",
        "sentAt": "ISO-date" }
    ]
  } | null,
  "orders":       [ /* sorted createdAt DESC */ ],
  "appointments": [ /* sorted appointmentDate DESC */ ],
  "notes":        [ /* on primary conversation, sorted createdAt DESC */ ],
  "activity":     [ /* this contact only, 50 most recent */ ]
}
```

**Business rules (BR):**

- **BR-0004**: `lifetimeRevenue` only counts orders with status
  `confirmed | paid | shipped | completed`. Status `new` and `cancelled` are
  excluded.
- **BR-0005**: `recentMessages` is capped at 5; each `content` is truncated to
  200 characters with a trailing `…`.
- **BR-0006**: `activity` only includes rows where `entityType='contact' AND
  entityId=contact.id`. Activity that touches related entities (orders,
  appointments) is not joined in — that's intentional to keep the timeline
  about the contact themselves.

**Errors:**
- `404`: contact does not exist in caller's org.
- `403`: member without assignment + zalo access.

---

## Feature 0014 — Webhook debug

The org's outbound webhook now persists every attempt to the
`webhook_deliveries` table. Admins read attempts and replay failures.

### GET `/api/v1/settings/webhook/deliveries`

List recent attempts, newest first.

**Permission:** owner/admin only. Member → `403`.

**Query parameters:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | enum | no | `all` (default), `success` (2xx), `failed` (4xx/5xx **or** transport error). |
| `page` | integer | no | Default 1. |
| `limit` | integer | no | Default 50, max 200. |

**Response 200:** envelope with each row containing
`{ id, event, url, responseStatus, durationMs, errorMessage, createdAt }`.
**Payload and signature are intentionally omitted** from the list response —
fetch the detail endpoint to get them.

### GET `/api/v1/settings/webhook/deliveries/:id`

Full row including `payload` (raw JSON string sent) and `signature` (the HMAC
that was on the `X-Webhook-Signature` header at delivery time).

**Permission:** owner/admin only. Member → `403`. Cross-org → `404`.

### POST `/api/v1/settings/webhook/deliveries/:id/replay`

Re-send the original payload to the **currently-configured** webhook URL.

**Permission:** owner/admin only.

**Behavior:**
- The original delivery row is **left untouched**. A **new row** is created
  for this attempt and its id is returned.
- The signature is **regenerated** from the current `webhook_secret` value in
  app settings — important after a key rotation so the partner's verifier
  still works.

**Errors:**
- `400`: `Webhook URL chưa được cấu hình` — no `webhook_url` setting.
- `404`: delivery row not in caller's org.

**Response 200:**

```json
{
  "id": "uuid (the NEW row)",
  "responseStatus": 200,
  "durationMs": 145,
  "errorMessage": null
}
```

### Pruning

A best-effort prune runs after every insert: each org keeps at most **1000**
delivery rows; older rows are deleted in `createdAt ASC` order. Failures here
are swallowed so a prune problem can't break delivery.

### Headers sent to the partner

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Webhook-Event` | The event name (e.g. `contact.created`). |
| `X-Webhook-Signature` | HMAC-SHA256(secret, body) as lowercase hex, or empty string if no secret is configured. |

Timeout per attempt is **10 seconds** (`AbortSignal.timeout`). On timeout or
network error, `responseStatus` is `null` and `errorMessage` carries the JS
error like `AbortError: This operation was aborted`.

---

## Feature 0015 — Pinned conversations

Per-org "pinned to top" flag for conversations. Pins are **org-shared** (one
row per conversation, every user in the org with access to the underlying
Zalo account sees the same pinned state), not per-user. Backed by the
`pinned_conversations` table; see
[features/0015-pinned-conversations/SPEC.md](../features/0015-pinned-conversations/SPEC.md).

### POST `/api/v1/conversations/:id/pin`

Pin a conversation. **Idempotent** — calling twice never errors.

**Permission:** `requireZaloAccess('chat')` (owner/admin bypass).

**Body:** none.

**Responses:**

| Status | Meaning |
| --- | --- |
| `201` | New pin created. |
| `200` | Already pinned — existing row is returned unchanged. |
| `403` | Caller has no Zalo account access or only `read`. |
| `404` | Conversation does not exist in caller's org (cross-org-safe). |

**Response 201 / 200 body:**

```json
{
  "id": "uuid",
  "orgId": "uuid",
  "zaloAccountId": "uuid",
  "conversationId": "uuid",
  "pinnedAt": "2026-05-20T08:00:00.000Z"
}
```

### DELETE `/api/v1/conversations/:id/pin`

Unpin a conversation. **Idempotent** — returns `204` whether or not a pin
existed previously.

**Permission:** `requireZaloAccess('chat')` (owner/admin bypass).

**Responses:**

| Status | Meaning |
| --- | --- |
| `204` | No content — pin is gone (or was never present). |
| `403` | Insufficient Zalo account access. |
| `404` | Cross-org. |

### GET `/api/v1/conversations/pinned`

List pinned conversations for the caller's org, sorted by `pinnedAt DESC`.

**Permission:** auth-only.
- **Owner / admin** → every pin in the org.
- **Member** → only pins on Zalo accounts the member has any ACL on (i.e.
  filtered to `zaloAccountId IN (...accessible)`).

**Response 200:**

```json
{
  "conversations": [
    {
      "id": "uuid",
      "orgId": "uuid",
      "zaloAccountId": "uuid",
      "contactId": "uuid | null",
      "threadType": "user | group",
      "externalThreadId": "string | null",
      "lastMessageAt": "ISO8601 | null",
      "unreadCount": 0,
      "isReplied": true,
      "createdAt": "ISO8601",
      "contact": { "id": "uuid", "fullName": "string", "phone": "string", "avatarUrl": "string | null", "zaloUid": "string | null" },
      "zaloAccount": { "id": "uuid", "displayName": "string | null", "zaloUid": "string | null" },
      "messages": [ { "content": "...", "contentType": "text", "senderType": "self", "sentAt": "ISO8601", "isDeleted": false } ],
      "pinnedAt": "ISO8601"
    }
  ]
}
```

Items are flattened — the `pinnedAt` field is hoisted onto the conversation
object so the frontend can render Pinned and regular conversation cards with
the same component.

### Route ordering note

`/api/v1/conversations/pinned` is registered as a literal static path while
`/api/v1/conversations/:id` (in `chat-routes.ts`) uses a parameterized
segment. Fastify's radix-tree router matches static segments before
parameters, so the literal `pinned` route always wins — even though both are
3-segment GETs.

---

## Feature 0016 — User preferences

Per-user JSON KV store for UI preferences (theme, density, sidebar state,
last-used filters, ...) so they follow the user across devices. All routes
authenticate via JWT and scope to `req.user.id` — there is no `orgId`
filter because preferences are strictly user-scoped.

**Validation:** by **key allowlist**, not by value shape. Values can be any
JSON (string/number/object/array/null). The allowlist lives in
`backend/src/modules/auth/user-preference-helpers.ts`:

```
ui.theme
ui.density
ui.sidebar_collapsed
ui.sound_on
chat.default_account_filter
contacts.last_filter
dashboard.refresh_interval
```

A key must (a) match `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/` AND (b) appear
in the allowlist. A well-formed key that isn't in the allowlist is rejected
on PUT to prevent typos becoming silent data. Value size is capped at
**4096 chars** after `JSON.stringify`.

### GET `/api/v1/me/preferences`

Returns the full map for the caller.

**Response 200:**
```json
{
  "ui.theme": "dark",
  "contacts.last_filter": { "status": ["new"], "pageSize": 50 }
}
```

Returns `{}` if the user has no preferences yet.

### GET `/api/v1/me/preferences/:key`

Single value lookup.

**Response 200:**
```json
{ "key": "ui.theme", "value": "dark" }
```

**Errors:**
- `404 Không tồn tại` — key not set, or key is malformed / not in allowlist.
  (We intentionally surface both as 404 so the allowlist shape isn't leaked
  to read traffic.)

### PUT `/api/v1/me/preferences/:key`

Upsert. Body must be `{ "value": <any JSON> }`.

**Response 200:**
```json
{
  "id": "uuid",
  "userId": "uuid",
  "key": "ui.theme",
  "value": "dark",
  "updatedAt": "2026-05-20T10:00:00.000Z"
}
```

`value: null` is a valid payload and stores SQL `null`. Omitting `value` from
the body is **not** the same as `value: null` — it returns 400.

**Errors:**
- `400 Key không hợp lệ` — malformed key or not in allowlist.
- `400 Body phải có field value` — body missing `value`.
- `400 Giá trị vượt quá 4096 ký tự` — `JSON.stringify(value).length > 4096`.

### DELETE `/api/v1/me/preferences/:key`

Idempotent — always returns `204` whether or not the row existed. Invalid
keys also return `204` (they can't be in the table anyway).

---

## Feature 0017 — Appointment parser

A pure-compute endpoint that extracts appointment intent from free-form
Vietnamese chat text using a rule-based regex parser. No DB writes, no FK
lookups — safe to call frequently from the chat UI.

### POST `/api/v1/appointments/parse`

**Auth:** JWT required.

**Request body:**

```json
{ "text": "9h sáng mai gặp em nhé" }
```

- `text` (string, required, ≤ 5000 chars).

**Response 200 — intent found:**

```json
{
  "date": "2026-05-21T09:00:00.000Z",
  "confidence": 0.65,
  "matchedPhrase": "9h sáng mai gặp em nhé",
  "type": "meeting"
}
```

`date` is the combined date+time as ISO-8601. `confidence` is in `[0.35, 1]`.
`type` is optional; when present it is one of `call | message | meeting |
follow_up`.

**Response 200 — no intent detected:**

```json
{ "result": null }
```

**Errors:**

- `400` — `text` is missing, not a string, or longer than 5000 characters.
- `401` — token missing/invalid.

### Supported patterns
Same as feature 0014's webhook section, this is a quick reference. The full
list with examples lives in
[`docs/features/0017-appointment-parser/SPEC.md`](../features/0017-appointment-parser/SPEC.md).

- Relative days: `hôm nay`, `mai`, `kia`, `N ngày nữa`.
- Weekdays: `thứ 2..7`, `T2..T7`, `chủ nhật`, `CN` (with optional
  `tuần sau\|tới` for next week).
- Absolute dates: `DD/MM(/YYYY)`, `ngày DD tháng MM (năm YYYY)`.
- Weeks/months: `tuần sau`, `N tuần nữa\|sau`.
- Times: `HH:MM`, `Xh`, `Xh sáng\|chiều\|tối`, `Xpm`, `Xam`, period-only
  (`sáng` → 09:00, `trưa` → 12:00, `chiều` → 14:00, `tối` → 19:00).
- Type hints: `gọi` → call, `nhắn` → message, `gặp`/`cafe`/`hẹn` → meeting.

---

## Feature 0018 — Duplicate detection + merge

On-demand scan that detects contact duplicates by phone, Zalo UID, and
fuzzy-name match, then exposes admin endpoints to merge or dismiss each
detected group. Merge is one-way (no undo); FK rewrite (conversations,
orders, appointments, campaign targets) happens inside a single Prisma
transaction. See [`docs/features/0018-duplicate-detection/SPEC.md`](../features/0018-duplicate-detection/SPEC.md)
for business rules.

### POST `/api/v1/contacts/scan-duplicates`

Trigger a duplicate scan for the caller's org.

**Permission:** owner/admin only (member → 403).

**Request body** (all fields optional):

```json
{ "levels": ["phone_exact", "zaloUid_exact", "name_fuzzy"] }
```

- `levels` — subset of detection levels to run. Default: all three.

**Sync response 200** (org ≤ 5000 live contacts):

```json
{
  "status": "completed",
  "groupsCreated": 12,
  "groupsExisting": 3,
  "contactsScanned": 487,
  "durationMs": 1240,
  "nameSkipped": false
}
```

`nameSkipped` is `true` when the org exceeds 20k contacts (the O(n²) name
fuzzy step is skipped; phone + uid still run).

**Async response 202** (org > 5000 live contacts):

```json
{ "status": "queued", "jobId": "uuid", "estimatedSeconds": 20 }
```

**Errors:**

- `400` — `levels` provided but every entry is invalid.
- `403` — member.
- `429` — another scan for this org started within the last 60s (in-memory
  debounce per org).

### GET `/api/v1/duplicate-groups`

List duplicate groups for the caller's org, newest first.

**Permission:** owner/admin.

**Query parameters:**

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | string | no | `pending` (default) / `merged` / `dismissed` / `all`. |
| `level` | string | no | `phone_exact` / `zaloUid_exact` / `name_fuzzy`. |
| `page` | integer | no | Default 1. |
| `limit` | integer | no | Default 50, max 200. |

---

## Feature 0020 — Friendship lifecycle

Tracks the Sale → Lead → Friend flow on Zalo. A `FriendshipAttempt` is the
state machine row (`queued → looking_up → sent → accepted | declined |
timeout | error | cancelled`); a `Friend` is the durable relation once
accepted. A node-cron worker picks queued rows every 30 seconds, calls
`findUser` and `sendFriendRequest` through zca-js (respecting the same
`zaloRateLimiter` quota as send-message), and a socket listener flips
attempts to `accepted` / `declined` when Zalo pushes the event.

All endpoints are JWT-protected and org-scoped. Members see only their own
attempts; owners and admins see the whole org (BR-0003).

### POST `/api/v1/contacts/:id/friendship`

Enqueue a single attempt.

**Auth:** JWT + at least one of (owner/admin role, owns the Zalo account,
or `ZaloAccountAccess.permission ∈ {chat, admin}` for the target account).

**Request body:**

```json
{ "zaloAccountId": "uuid", "message": "Chào {{firstName}}" }
```

- `zaloAccountId` (string, required).
- `message` (string, optional, ≤ 200 chars). Supports `{{contactName}}` and
  `{{firstName}}`.

**Response 201 —** the new `FriendshipAttempt` row, `state = "queued"`.

**Errors:**

- `400 contact_missing_phone` — Contact has no `phone`.
- `400 invalid_message` — message exceeds 200 chars or wrong type.
- `403 forbidden` — caller lacks BR-0001 permission.
- `404 contact_not_found` / `zalo_account_not_found` — cross-org or missing row.
- `409 attempt_already_active` — there's already an active attempt for this
  `(contactId, zaloAccountId)` pair.

### POST `/api/v1/friendship-attempts/bulk`

Bulk enqueue with partial success. Skips contacts that are missing phone or
already have an active attempt — the response itemizes both buckets.

**Request body:**

```json
{
  "zaloAccountId": "uuid",
  "contactIds": ["uuid", "uuid", "..."],
  "message": "Hi"
}
```

- `contactIds` (≥ 1, ≤ 500 unique values).

**Response 201:**

```json
{
  "queued": [{ "contactId": "uuid", "attemptId": "uuid" }],
  "skipped": [
    { "contactId": "uuid", "reason": "contact_missing_phone" },
    { "contactId": "uuid", "reason": "attempt_already_active:sent" }
  ],
  "totalQueued": 1,
  "totalSkipped": 2
}
```

`reason` values include `contact_not_found`, `contact_missing_phone`,
`attempt_already_active:<state>`, `insert_failed`.

**Errors:** `400`, `403` (same as single enqueue, applied to the whole batch).

### GET `/api/v1/friendship-attempts`

List with filters + pagination.

**Query params:**

- `state` — CSV of states (e.g. `state=sent,looking_up`).
- `zaloAccountId`, `contactId` — exact match.
- `from`, `to` — ISO dates, filter on `queuedAt`.
- `page`, `limit` — defaults 1 and 20; `limit` capped at 100.

**Response 200:**

```json
{
  "groups": [
    {
      "id": "uuid",
      "level": "phone_exact",
      "confidence": 1.0,
      "status": "pending",
      "contactCount": 2,
      "contactsPreview": [
        { "id": "uuid", "fullName": "Nguyễn Văn A", "phone": "84901234567" },
        { "id": "uuid", "fullName": "Nguyen Van A", "phone": "+84 901 234 567" }
      ],
      "detectedAt": "2026-05-20T03:00:00.000Z",
      "resolvedAt": null,
      "primaryContactId": null
    }
  ],
  "total": 12,
  "page": 1,
  "limit": 50
}
```

`contactsPreview` filters out contacts already merged in a different group
(EC-0001) so the preview never lists tombstones.

### GET `/api/v1/duplicate-groups/:id`

**Permission:** owner/admin. Cross-org → 404.

**Response 200:**

```json
{
  "id": "uuid",
  "level": "name_fuzzy",
  "confidence": 0.75,
  "status": "pending",
  "contacts": [
    {
      "id": "uuid",
      "fullName": "Nguyễn Văn A",
      "phone": "84901234567",
      "email": "a@example.com",
      "source": "FB",
      "status": "interested",
      "tags": ["vip"],
      "createdAt": "...",
      "assignedUser": { "id": "uuid", "fullName": "..." },
      "stats": { "conversations": 2, "orders": 5, "appointments": 1, "notes": 7 }
    }
  ],
  "detectedAt": "...",
  "resolvedAt": null,
  "resolvedBy": null,
  "primaryContactId": null
}
```

EC-0001 — if the underlying contacts of a `pending` group have all been
resolved in other groups (≤ 1 live contact remains), this endpoint also
auto-flips the group to `dismissed` and returns the new status.

### POST `/api/v1/duplicate-groups/:id/merge`

Merge every secondary contact in the group into the chosen primary.

**Permission:** owner/admin.

**Body:**

```json
{
  "primaryContactId": "uuid",
  "fieldsToKeep": {
    "fullName": "uuid-of-source-contact",
    "phone": "uuid-of-source-contact",
    "email": "uuid-of-source-contact",
    "source": "uuid-of-source-contact",
    "assignedUserId": "uuid-of-source-contact"
  }
}
```

- `primaryContactId` (required) — must be one of the group's contact ids.
- `fieldsToKeep` (optional) — each value is a contact id in the group; the
  named field on the primary is overwritten with that contact's value.
  Default behaviour (no override) is to keep the primary's fields unchanged
  except for `tags` (union), `notes` (concat with separator), and `metadata`
  (shallow merge, primary wins).

**Response 200:**

```json
{
  "status": "merged",
  "primaryContactId": "uuid",
  "mergedContactIds": ["uuid", ...],
  "moved": {
    "conversations": 3,
    "orders": 8,
    "appointments": 2,
    "notes": 7,
    "campaignTargets": 1,
    "skippedDuplicateTargets": 0,
    "mergedConversations": 0
  }
}
```

`skippedDuplicateTargets` counts secondary `CampaignTarget` rows that were
deleted because the primary was already a target of the same campaign
(EC-0005). `mergedConversations` counts secondary conversations that were
collapsed into a primary conversation sharing the same
`(zaloAccountId, externalThreadId)` (EC-0006).

**Errors:**

- `400` — `primaryContactId` missing/invalid, `fieldsToKeep` value not in
  the group, primary already merged, or the group has no remaining
  secondaries to merge.
- `403` — member.
- `404` — group not in caller's org.
- `409` — another admin merged or dismissed the group between read and
  write (concurrency guard).

One `contact.merged` activity log row is written per secondary AFTER the
transaction commits (`entityType=contact`, `entityId=secondary.id`,
`details={ mergedInto, groupId, level }`).

### POST `/api/v1/duplicate-groups/:id/dismiss`

Mark the group as a false positive so the next scan does not re-create it.

**Permission:** owner/admin.

**Body:**

```json
{ "reason": "Hai khách thật khác nhau dùng chung SĐT" }
```

- `reason` (optional, ≤ 500 chars).

**Response 200:**

```json
{ "status": "dismissed", "resolvedAt": "..." }
```

**Errors:**

- `400` — group already resolved (merged or dismissed) / reason too long.
- `403` — member.
- `404` — group not in caller's org.

### Side effects on existing endpoints

- `GET /api/v1/contacts` and `GET /api/v1/contacts/pipeline` filter out
  contacts with `mergedIntoId` set by default. The merged-secondary rows
  remain in the DB for audit (`mergedIntoId`, `mergedAt`, `status='merged'`).
- `GET /api/v1/contacts/:id/overview` (feature 0013) — if the requested
  contact has been merged, the response is the **primary's** overview with
  `mergedInto = primary.id` and `mergedFrom = original.id` so the FE can
  redirect the URL.

---

  "attempts": [
    {
      "id": "uuid",
      "state": "sent",
      "zaloUidFound": "9999",
      "contact": { "id": "uuid", "fullName": "KH", "phone": "...", "avatarUrl": null },
      "zaloAccount": { "id": "uuid", "displayName": "Sale Hương" },
      "createdBy": { "id": "uuid", "fullName": "..." },
      "queuedAt": "2026-05-20T10:00:00Z",
      "sentAt": "2026-05-20T10:00:32Z"
    }
  ],
  "total": 23,
  "page": 1,
  "limit": 20,
  "totalPages": 2
}
```

### GET `/api/v1/friendship-attempts/:id`

Same shape as the list element. `404` for cross-org access or when a member
tries to view someone else's attempt.

### POST `/api/v1/friendship-attempts/:id/cancel`

**Permission:** creator OR owner/admin (BR-0002).

Only valid when the attempt is in `queued` or `looking_up` — once we hit
`sent` the invite has left the server and Zalo provides no recall mechanism
(BR-0008).

**Response 200:** updated attempt with `state = "cancelled"`.

**Errors:**

- `403 forbidden` — caller is not the creator and not owner/admin.
- `404 not_found` — cross-org or missing.
- `409 cannot_cancel` — attempt is not in a cancellable state.

### Activity events

Every transition emits an `ActivityLog` row via `logActivityAsync`:

| Action | Trigger | userId |
|---|---|---|
| `friendship.queued` | enqueue / bulk enqueue | caller |
| `friendship.lookup_failed` | findUser said no Zalo | null (system) |
| `friendship.sent` | sendFriendRequest succeeded | null |
| `friendship.accepted` | listener ADD or already-friends shortcut | null |
| `friendship.declined` | listener REJECT_REQUEST | null |
| `friendship.timeout` | sweep > FRIENDSHIP_TIMEOUT_DAYS | null |
| `friendship.cancelled` | manual cancel | caller |
| `friendship.error` | worker failed | null |

---

## Feature 0019 — CRM tags (Phase A)

Promotes `Contact.tags` from a free-text JSON array to a proper relational
model. Phase A ships the new schema + CRUD endpoints + a backward-compatible
`PUT /contacts/:id/tags` and keeps the legacy JSON column populated via
dual-write so campaigns / KPI / Customer 360 don't break.

**Naming:** `normalizedName = name.trim().normalize('NFC').toLowerCase()`.
Two display names that collapse to the same normalized form collide on the
`(orgId, normalizedName)` unique constraint → `409 TAG_DUPLICATE`.

### GET `/api/v1/crm-tags`

List all tags in the org. Default hides archived tags.

**Query:**

| Param | Type | Default | Description |
|---|---|---|---|
| `groupId` | string | — | Filter to a single group. |
| `managedBy` | `'crm' \| 'zalo_sync'` | — | `'crm'` = `managedBy IS NULL`. |
| `includeArchived` | bool | `false` | Include rows with `archivedAt` set. |
| `search` | string | — | Substring match on `name` (case-insensitive). |

**Response 200:** `{ "tags": CrmTag[] }`.

### POST `/api/v1/crm-tags`

Create a tag. **Any authenticated user** in the org can call this (BR-0004) —
sales staff need to create tags inline while chatting.

**Body:**

```json
{ "name": "VIP", "color": "#FF0000", "emoji": "⭐", "groupId": null }
```

- `name` — required, 1-50 chars after trim.
- `color` — optional, defaults to `#9E9E9E`. Must match `/^#[0-9A-Fa-f]{6}$/`.
- `emoji` — optional, free-form.
- `groupId` — optional; must reference an existing group in the same org.

**Response 201:** the created `CrmTag` row.

**Errors:**

- `400 INVALID_NAME` — empty / whitespace / > 50 chars / not a string.
- `400 INVALID_COLOR` — color is not `#RRGGBB`.
- `400 INVALID_GROUP` — `groupId` doesn't exist in this org.
- `409 TAG_DUPLICATE` — another tag with the same normalized name exists.
  Body includes `"existingTagId": "<uuid>"` so the FE can offer "use existing".

### PUT `/api/v1/crm-tags/:id`

Patch a tag. **Owner/admin only** (BR-0005). `managedBy='zalo_sync'` tags
only allow `order` and `groupId` mutations — anything else returns
`400 ZALO_MANAGED` (BR-0008).

**Body:** any subset of `{ name, color, emoji, description, groupId, order, archivedAt }`.

`archivedAt: null` un-archives a previously archived tag (BR-0013).

**Errors:** `400 INVALID_NAME / INVALID_COLOR / INVALID_GROUP / ZALO_MANAGED`,
`403`, `404`, `409 TAG_DUPLICATE`.

### DELETE `/api/v1/crm-tags/:id`

Soft-delete (sets `archivedAt`). **Owner/admin only.** Idempotent — calling
twice returns the row in both calls without raising. `ContactTag` links are
preserved (BR-0012). Zalo-sync tags reject with `400 ZALO_MANAGED`.

### GET `/api/v1/crm-tag-groups`

List groups in the org. Default hides archived groups.

**Query:** `includeArchived?: bool`.

**Response 200:** `{ "groups": CrmTagGroup[] }`.

### POST `/api/v1/crm-tag-groups`

Create a group. **Owner/admin only** (BR-0007).

**Body:** `{ "name": "Khách quan trọng" }` (1-50 chars).

**Errors:** `400 INVALID_NAME`, `403`.

### PUT `/api/v1/contacts/:id/tags` *(updated in Phase A)*

Replace the contact's tag set. Accepts BOTH body shapes during Phase A:

- **New:** `{ "tagIds": ["uuid", "uuid"] }`
- **Legacy:** `{ "tags": ["VIP", "vip"] }` — backend upserts names to tags
  (case-folded), then converts. Logs a single deprecation warning per call.
  Callers should migrate to the new shape.

Behavior:

- Computes `add` / `remove` diff against the contact's current `ContactTag`
  links and only writes the difference.
- Increments / decrements `CrmTag.usageCount` accordingly.
- **Dual-write:** mirrors the resulting tag NAMES into `contact.tags` (Json)
  so legacy readers (campaigns / KPI / Customer 360 / keyword-rules) keep
  working without a join. Phase C will drop this mirror.

**Errors:**

- `400 INVALID_TAG_ID` — one of the `tagIds` doesn't belong to the org.
- `400 TAG_ARCHIVED` — applying an archived tag is rejected.
- `404` — contact doesn't exist or is cross-org.

### GET `/api/v1/contacts` — tag filter (new in Phase A)

The contact list endpoint accepts a new `tagIds` query param. Accepts a
comma-separated string or repeated `?tagIds=A&tagIds=B` form. Filter is
**OR** across the supplied IDs (any contact carrying at least one of the
tags matches).

### POST `/api/v1/zalo-accounts/:id/sync-labels` *(Phase A.1)*

Pull the Zalo native label catalog for the given account, upsert it into
`ZaloLabel` + a per-account `CrmTagGroup` + `CrmTag(managedBy='zalo_sync')`
rows. Returns counters for what changed.

**Permission:** owner / admin only. Member → 403. Cross-org → 404.

**Body:** empty.

**Response 200:**

```json
{
  "synced": {
    "groupId": "uuid",
    "labelsCreated": 2,
    "labelsUpdated": 5,
    "labelsArchived": 1,
    "adopted": 0
  }
}
```

- `adopted` counts CRM-only tags whose name collides with an incoming Zalo
  label — they get `managedBy='zalo_sync'` + `sourceZaloLabelId` set. A
  warning is logged per adoption.
- `labelsArchived` counts Zalo-managed tags whose `sourceZaloLabelId` is no
  longer in the upstream catalog. They get `archivedAt` set + `isActive=false`;
  **existing `ContactTag` links are preserved** (archive ≠ delete).
- The `ZaloLabel` mirror table is hard-deleted for rows no longer in Zalo's
  catalog (the mirror tracks current truth).

**Errors:**

- `400 ZALO_NOT_LOGGED_IN` — account exists but isn't connected.
- `502 ZALO_BRIDGE_ERROR` — zca-js `getLabels()` threw.
- `404` — account not in caller's org.

### Out of scope for Phase A / A.1

- **Backfill of existing string tags** — Phase B (separate PR).
- **Dropping `contacts.tags` Json column** — Phase C (after ≥ 1 sprint
  observing the dual-write).
- **Push CRM-only tags back to Zalo** — out of Phase 1 scope entirely.
  Sync is one-way (Zalo → CRM).
