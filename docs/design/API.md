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

## Feature 0021 — Message reactions

Sales reps thả 6 emoji reaction (❤️ 👍 😆 😮 😭 😡) lên từng message trong chat —
gửi luôn ra Zalo qua `api.addReaction` của zca-js, lưu lịch sử trong CRM, và push
live qua Socket.IO. Một `(messageId, reactorId)` chỉ tồn tại **một** reaction tại
một thời điểm: cùng emoji = toggle off, khác emoji = override (BR-0004/0005).

Inbound reactions từ phía khách hàng được listener `'reaction'` của zca-js bắt
và upsert tự động. Phase 1 **không** subscribe `'old_reactions'` (reconcile burst
khi reconnect) và **không** ghi `ActivityLog` cho reactions (BR-0011).

### Permissions

Mọi endpoint scope theo org của caller + Zalo account access:

- **POST / DELETE** yêu cầu `requireZaloAccess('chat')` (owner/admin bypass).
- **GET** yêu cầu `read` trở lên trên Zalo account.
- Cross-org → `404` (không leak existence).

### POST `/api/v1/messages/:id/reactions`

Thả hoặc đổi reaction. Logic:

1. Nếu chưa có row → tạo mới + gọi `api.addReaction(<enum>, dest)` → **201**.
2. Có row với emoji **khác** → update emoji + `api.addReaction(<enum-new>, dest)` → **201**.
3. Có row với emoji **trùng** → xóa row + `api.addReaction(NONE, dest)` → **200 toggledOff**.

Cuộc gọi zca-js nằm trong cùng transaction với DB write — partner fail → rollback (AC-0013).

**Request body:**

```json
{ "emoji": "❤️" }
```

`emoji` phải thuộc set 6 standard: `"❤️" | "👍" | "😆" | "😮" | "😭" | "😡"`.

**Response 201:**

```json
{
  "id": "uuid",
  "messageId": "uuid",
  "reactorId": "user-uuid",
  "reactorSource": "crm",
  "reactorName": "Nguyễn Văn A",
  "emoji": "❤️",
  "createdAt": "2026-05-20T10:00:00.000Z"
}
```

**Response 200 (toggle off):**

```json
{ "toggledOff": true, "messageId": "uuid", "emoji": "❤️" }
```

**Errors:**

- `400 invalid_emoji` — emoji không thuộc 6 standard.
- `400 message_deleted` — message đã `isDeleted=true` (đã thu hồi).
- `400 message_missing_zalo_msg_id` — outbound message chưa kịp ack từ Zalo (FE retry sau ~500ms).
- `403 forbidden` — không có ACL `chat` trên Zalo account.
- `404 message_not_found` — message không tồn tại hoặc cross-org.
- `502 zalo_reaction_failed` — `api.addReaction` ném ra (account disconnected, network fail…). DB rollback đã chạy → state nhất quán.

### DELETE `/api/v1/messages/:id/reactions`

Idempotent — xóa reaction của caller cho message này, gọi `api.addReaction(NONE, dest)` nếu account còn connected. Không có body. Trả `204` ngay cả khi không có row.

**Errors:** `403`, `404` (giống POST).

### GET `/api/v1/messages/:id/reactions`

Liệt kê tất cả reactions trên message. Trong main chat flow FE **không** dùng endpoint này — reactions được trả về inline trên mỗi `Message` của `GET /api/v1/conversations/:id/messages`. Endpoint riêng để debug / future reaction-detail modal.

**Response 200:**

```json
{
  "reactions": [
    {
      "id": "uuid",
      "reactorId": "...",
      "reactorSource": "crm" | "zalo",
      "reactorName": "..." | null,
      "emoji": "❤️" | "👍" | "😆" | "😮" | "😭" | "😡" | "custom:<rType>",
      "createdAt": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

### Socket.IO event

Mỗi thay đổi (inbound listener hoặc outbound POST/DELETE) emit:

```json
// chat:reaction
{
  "accountId": "uuid",
  "conversationId": "uuid",
  "messageId": "uuid",
  "reaction": { /* row giống GET shape */ } | null,
  "removed": { "reactorSource": "crm|zalo", "reactorId": "..." } | undefined
}
```

`reaction = null` + `removed` set → row đã bị xóa. FE merge theo
`(reactorSource, reactorId)` để dedupe self-listen race (EC-0004).

### Inline trên list-messages

`GET /api/v1/conversations/:id/messages` từ feature 0021 trả về:

```json
{
  "messages": [
    {
      "id": "...",
      // …các field cũ…
      "reactions": [ /* MessageReaction[] giống GET shape */ ]
    }
  ],
  "total": 50,
  "page": 1,
  "limit": 50
}
```

Reactions luôn được sort theo `createdAt asc`. Backward-compatible: clients
cũ bỏ qua field này không bị ảnh hưởng.

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

### PUT `/api/v1/contacts/:id/tags`

Replace the contact's tag set. Accepts BOTH body shapes:

- **New:** `{ "tagIds": ["uuid", "uuid"] }`
- **Legacy:** `{ "tags": ["VIP", "vip"] }` — backend upserts names to tags
  (case-folded), then converts. Logs a single deprecation warning per call.
  Callers should migrate to the new shape.

Behavior:

- Computes `add` / `remove` diff against the contact's current `ContactTag`
  links and only writes the difference.
- Increments / decrements `CrmTag.usageCount` accordingly.
- **Phase C (shipped):** the legacy `contact.tags` Json column has been
  dropped. The `ContactTag` junction is the single source of truth — every
  reader (campaigns filter, duplicate detection, keyword rules, Customer 360,
  public API) now queries through the junction.

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

### Out of scope for Phase A / A.1 / B / C

- **Push CRM-only tags back to Zalo** — out of Phase 1 scope entirely.
  Sync is one-way (Zalo → CRM).

## Feature 0019 — CRM tags (Phase C: drop legacy column)

Phase C drops the legacy `contact.tags` Json column and migrates every
remaining reader to the `ContactTag` junction. The relational model is now
the single source of truth — no dual-write, no JSON cache.

### Contact tag response shape

Endpoints that include a contact's tags return them as an enriched array
of objects:

```json
{
  "tags": [
    { "id": "uuid", "name": "VIP", "color": "#FFD700", "emoji": "⭐" }
  ]
}
```

The Phase B `tagNames: string[]` shim has been **removed**. Clients should
read the enriched objects directly.

Affected endpoints:

- `GET /api/v1/contacts/:id` — `tags: [{id, name, color, emoji}]`.
- `PUT /api/v1/contacts/:id/tags` — response matches `GET /:id`.
- `GET /api/v1/contacts/:id/overview` — `contact.tags` is the enriched array.
- `GET /api/v1/duplicate-groups/:id` — each contact's `tags` is enriched.

Archived tags are filtered out of these responses by default.

### Migrated readers

- **Campaign filter (`filter.tags`)**: now resolves names → `CrmTag.normalizedName`
  via the junction (case-folded, OR semantics). The wire shape is unchanged
  (`filter.tags: string[]`) so existing `CampaignCreateDialog` snapshots and
  external campaign callers keep working — the dialog still posts tag names
  and the server matches them against `CrmTag.normalizedName`.
- **Duplicate detection (list + merge)**: list payload returns enriched
  tags; merge unions ContactTag rows from secondaries into the primary
  (BR-0008), then removes secondary links so `usageCount` stays exact.
- **Keyword rule action `addTag`**: upserts CrmTag by case-folded name and
  links via ContactTag (no longer touches a Json column).
- **`POST /api/public/contacts`** and **`PUT /api/public/contacts/:id`**:
  still accept `tags: string[]` in the body for external partner
  back-compat. The server upserts those names into `CrmTag` rows and
  attaches via the junction. Responses return `tags: string[]` (names) so
  the public wire shape is preserved.

### Removed

- `npm run db:preflight-tags` / `npm run db:backfill-tags` and the
  corresponding scripts under `prisma/scripts/0019-*-tags.ts` — these were
  one-shot Phase B migrations and no longer apply.
- `tagNames: string[]` field on every response that previously carried it.

---

## Feature 0022 — Conversation filters

Adds chip-row filters to `ConversationList` (chưa đọc / chưa trả lời /
thời gian / tag) plus an aggregate counts endpoint for badge numbers.
Wire-format param names match ZaloCRM-3.0 `FilterRail` so a future
sidebar swap doesn't change the API contract. See
[features/0022-conversation-filters/SPEC.md](../features/0022-conversation-filters/SPEC.md).

### GET `/api/v1/conversations` — added query params

| Param | Type | Description |
|---|---|---|
| `unread` | `'1' \| 'true' \| ''` | Only conversations with `unreadCount > 0` |
| `unreplied` | `'1' \| 'true' \| ''` | Only conversations with `isReplied = false` |
| `dateFrom` | `YYYY-MM-DD` | `lastMessageAt >= start of dateFrom` (UTC) |
| `dateTo` | `YYYY-MM-DD` | `lastMessageAt <= end of dateTo` (UTC) |
| `from` | `YYYY-MM-DD` | Legacy alias for `dateFrom` (3.0 back-compat) |
| `to` | `YYYY-MM-DD` | Legacy alias for `dateTo` |
| `tags` | `CSV of CrmTag UUIDs` | OR-match against `ContactTag` junction |

Filters compose AND with each other and with the existing `search` and
`accountId` params. Empty / missing → no-op (back-compat preserved).

Invalid dates return **400** with a Vietnamese error message:

```json
{ "error": "dateFrom không hợp lệ" }
```

#### Deviation from ZaloCRM-3.0

3.0's `tags` param carried tag **names** because it pre-dated the
ContactTag junction (Phase 0019-C). After the junction migration we
switched to tag **UUIDs**. The `TagPicker` component already returns
`string[]` of IDs so the FE wire payload is unchanged from FE
implementation perspective.

3.0 filters that are NOT yet implemented (deferred to future features):
`tab`, `accountIds[]` (multi), `statusId`, `assignedUserId`, `hasZalo`,
`scoreMin/scoreMax`, `relationshipKindAny`, `threadType`, `groupInbox`.

### GET `/api/v1/conversations/counts`

Aggregate badge counts for the chip row.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `accountId` | `UUID` | (Optional) scope to one Zalo account |

**Response 200:**

```json
{ "unread": 12, "unreplied": 7, "total": 84 }
```

ACL: same as `/conversations` — members see counts only across Zalo
accounts they have access to; cross-org returns `{ 0, 0, 0 }`.

Counts are unfiltered by `dateFrom/dateTo/tags` — they're whole-inbox
totals so the chip badge represents "X tin chưa đọc tổng cộng",
independent of the currently-active filter chips.

#### Route ordering note

`/api/v1/conversations/counts` is registered **before**
`/api/v1/conversations/:id` to prevent Fastify from interpreting
`counts` as a `:id` param (same pattern as Feature 0015's
`/conversations/pinned`).

### User preference key

`chat.conversation_filters` is added to the user-preferences allowed-key
list. The frontend persists the filter chip state via `usePref(...)`:

```ts
interface ConversationFilters {
  unread: boolean;
  unreplied: boolean;
  dateFrom: string;
  dateTo: string;
  tagIds: string[];
}
```

## Feature 0023 — Hide / archive conversations (Tab "Khác")

Splits the conversation list into two tabs: **Chính** (`main`) and **Khác**
(`other`). Right-click a row → "Ẩn vào tab Khác" / "Đưa về tab Chính".
Inbound contact messages on a hidden conversation auto-promote it back to
`main` (BR-0005). Wire format mirrors ZaloCRM-3.0's `tab` field. See
[features/0023-hide-archive-conversations/SPEC.md](../features/0023-hide-archive-conversations/SPEC.md).

### PATCH `/api/v1/conversations/:id/tab`

Move a single conversation between the `main` and `other` tabs.

**Permission:** `requireZaloAccess('chat')` — owner/admin bypass; members
need `chat` or `admin` on the underlying Zalo account.

**Body:**

```json
{ "tab": "main" }
```

`tab` must be `"main"` or `"other"`. Anything else → **400**.

**Response 200:**

```json
{ "success": true, "tab": "other" }
```

**Errors:**

| Status | When |
|---|---|
| 400 | `tab` missing or not in `["main","other"]` — `{ "error": "tab phải là \"main\" hoặc \"other\"" }` |
| 403 | Caller lacks `chat` ACL on the Zalo account |
| 404 | Cross-org or unknown conversation id — `{ "error": "Không tìm thấy cuộc trò chuyện" }` |

**Side effects:** emits Socket.IO `chat:tab` with payload
`{ conversationId, tab, reason: 'manual' }` so other open tabs / clients
can move the row in their local list.

#### Route ordering

`/api/v1/conversations/:id/tab` is registered **before**
`/api/v1/conversations/:id` so Fastify doesn't swallow the literal `/tab`
segment as part of `:id` (same pattern as Feature 0015 `/pinned` and
Feature 0022 `/counts`).

### GET `/api/v1/conversations` — added `tab` query param

| Param | Type | Description |
|---|---|---|
| `tab` | `'main' \| 'other' \| ''` | Filter by tab. Omitted → returns conversations from **both** tabs (back-compat for callers like campaigns, dashboard, search). |

Composes AND with existing filters (`unread`, `unreplied`, `dateFrom`,
`dateTo`, `tags`, `search`, `accountId`).

### GET `/api/v1/conversations/counts` — extended response

Two new integer fields are added; existing fields are unchanged.

**Response 200:**

```json
{
  "unread": 12,
  "unreplied": 7,
  "total": 84,
  "mainUnread": 9,
  "otherUnread": 3
}
```

- `mainUnread` = count of conversations with `tab='main' AND unreadCount > 0`.
- `otherUnread` = count of conversations with `tab='other' AND unreadCount > 0`.
- Existing `unread` is the sum across both tabs (preserves Feature 0022
  back-compat).

### Auto-promote (BR-0005)

When `handleIncomingMessage` persists an inbound message
(`senderType='contact'`, i.e. customer-sent) on a conversation whose
`tab='other'`, the conversation is flipped back to `tab='main'` in the
same transaction-pair as the unread-count bump. The Zalo listener then
broadcasts:

```json
{
  "accountId": "uuid",
  "conversationId": "uuid",
  "tab": "main",
  "reason": "inbound_message"
}
```

over Socket.IO event `chat:tab`. Self-sent (`isSelf=true`) messages do
**not** trigger auto-promote — a rep replying inside the Khác tab should
not yank the row back to Chính.

### Schema change

```prisma
model Conversation {
  // ...
  tab String @default("main") @map("tab")  // "main" | "other"

  @@index([orgId, tab, lastMessageAt(sort: Desc)])
}
```

Migration is additive with a safe default — existing rows automatically
get `tab='main'`. No data backfill script needed.

### User preference

The `chat.conversation_filters` user-pref key (introduced in Feature
0022) gains an optional `tab` field:

```ts
interface ConversationFilters {
  unread: boolean;
  unreplied: boolean;
  dateFrom: string;
  dateTo: string;
  tagIds: string[];
  tab: 'main' | 'other'; // Feature 0023 — defaults to 'main'
}
```

Legacy persisted prefs without `tab` are upgraded transparently — the
frontend treats missing `tab` as `'main'`.

### Deviation from ZaloCRM-3.0

Same field name, same values, same wire format. The only extension is
the auto-promote behavior — 3.0's reference implementation has the tab
field + PATCH + filter param but no auto-promote on inbound. Documented
in the feature SPEC's Deviations section.

---

## Feature 0027 — MinIO/S3 attachment mirror

Attachments uploaded via `POST /api/v1/conversations/:id/attachments`
are now mirrored to a MinIO bucket before being forwarded to Zalo. The
endpoint's request shape, validation, and response status codes are
**unchanged** — only the URL pattern stored in `Message.content` has
moved from Zalo CDN to our bucket.

### Response shape — `POST /api/v1/conversations/:id/attachments`

The returned `Message` row is the same Prisma shape as `GET .../messages`.
What changed is the value of `content`:

| Field | Before (feature 0003) | After (feature 0027) |
| --- | --- | --- |
| `content` | Original filename, e.g. `"photo.png"`. | Public MinIO URL: `http(s)://<S3_PUBLIC_URL>/<S3_BUCKET>/YYYY-MM-DD/<uuid>.<ext>`. |
| `attachments[0]` | `{ filename, size, mimeType }`. | `{ filename, size, mimeType, url }` — `url` is the same MinIO URL. |
| `contentType` | `image` for image MIMEs, `file` for everything else. | Same. |

The frontend's `getImageUrl()` helper (in `MessageThread.vue`) detects
the new shape via `msg.content.startsWith('http')` and renders the URL
directly inside an `<img>` tag — no parsing required. The legacy JSON-envelope
shape (`{ href, thumb, ... }`) used by inbound messages continues to work.

### URL pattern (BR-0001 / BR-0002)

```
http(s)://<S3_PUBLIC_URL>/<S3_BUCKET>/YYYY-MM-DD/<uuid><.ext>
```

- Date prefix is the UTC date the object was created. Helps with
  manual bucket navigation (`mc ls`) and future lifecycle rules.
- Bucket is configured with anonymous-read so `<img src>` and
  `<video src>` tags work without auth headers.
- File extension is derived from the original filename when present,
  otherwise from MIME (`image/jpeg → .jpg`, etc.).

### Error responses (new failure modes)

| Status | `code` | When |
| --- | --- | --- |
| 502 | `storage_failed` | MinIO upload threw. Zalo was NOT called and no Message row was created — safe to retry. |
| 502 | `zalo_send_failed` | MinIO upload succeeded but zca-js threw. The MinIO object is left as an orphan (acceptable per EC-0006). No Message row. |

Both errors return `{ error: "<vietnamese message>", code: "<code>" }`.

### Inbound mirror

Inbound messages with `contentType in ['image', 'video', 'file']` and a
parseable Zalo CDN URL inside `content` are mirrored asynchronously
during `handleIncomingMessage`. The mirror is **best-effort** (BR-0008):

- On success → the JSON envelope's `href`, `hdUrl`, and `thumb` fields
  are rewritten to MinIO URLs (other fields preserved).
- On failure → the message persists with the original Zalo URL and a
  warn-level log line. No retry queue in Phase 1.

### Configuration

Backend reads six env vars (`backend/src/config/index.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `S3_ENDPOINT` | `http://minio:9000` | Backend → MinIO (docker-internal). |
| `S3_PUBLIC_URL` | `http://localhost:9000` | What browsers see in `<img src>`. |
| `S3_BUCKET` | `zalocrm-attachments` | Bucket name. |
| `S3_ACCESS_KEY` | `minioadmin` | MinIO access key. |
| `S3_SECRET_KEY` | `minioadmin` | MinIO secret key. |
| `S3_REGION` | `us-east-1` | Required by the SDK but unused by MinIO. |

`docker-compose.yml` ships a `minio` service plus a one-shot
`minio-init` container that creates the bucket and sets the
anonymous-download policy. Backend calls `ensureBucket()` at startup
and refuses to start if it fails — failing loud is better than
silently accepting uploads that vanish (EC-0001).

---

## Feature 0026 — Mention rendering

Backend endpoint that powers the `@mention` chip rendering and composer
auto-complete inside group conversations. See
[features/0026-mention-rendering/SPEC.md](../features/0026-mention-rendering/SPEC.md).

### GET `/api/v1/conversations/:id/members`

List the members of a group conversation so the FE can render
`@<uid>` chips and feed the composer's auto-complete picker.

**Path params:** `id` — conversation UUID.

**Permission:** `requireZaloAccess('chat')` — owner/admin bypass;
members need `chat` or `admin` on the underlying Zalo account.

**Response 200:**

```json
{
  "members": [
    { "uid": "2347234782", "displayName": "Lan Anh", "avatarUrl": "https://..." },
    { "uid": "9988776655", "displayName": "Minh",    "avatarUrl": "" }
  ]
}
```

`avatarUrl` may be an empty string when the Zalo profile has no avatar.

**Behaviour:**

- Source of truth is `api.getGroupInfo(<externalThreadId>)` from
  zca-js. The first call hits Zalo; subsequent calls within 5 minutes
  are served from an in-process Map keyed by `conversationId`
  (SPEC §3 BR-0009).
- **BR-0010 graceful degradation** — when the underlying Zalo
  account is offline (no `instance.api`) the endpoint still returns
  `200` with `members: []` so the UI can disable auto-complete
  without showing an error toast.
- Same shape is returned if `api.getGroupInfo` throws (privacy or
  network error) — the FE simply works without auto-complete.

**Errors:**

| Status | When |
|---|---|
| 400 | Conversation is not a group — `{ "error": "not_a_group" }` (BR-0003 of SPEC §3). |
| 403 | Caller lacks `chat` ACL on the Zalo account. |
| 404 | Cross-org or unknown conversation id — `{ "error": "Conversation not found" }`. |

---

## Feature 0028 — Sticker support

Sticker send + render. The backend proxies zca-js's sticker APIs so
the FE never has to talk to Zalo CDN directly (CORS-safe). See
[features/0028-sticker-support/SPEC.md](../features/0028-sticker-support/SPEC.md).

### POST `/api/v1/conversations/:id/stickers`

Send a sticker into a conversation. The handler persists a
`Message` row with `contentType='sticker'` and `content` set to a
JSON envelope `{ stickerId, catId, type, cdnUrl }`, then emits the
usual `chat:message` Socket.IO event.

**Path params:** `id` — conversation UUID.

**Permission:** `requireZaloAccess('chat')` — owner/admin bypass;
members need `chat` or `admin` on the Zalo account.

**Body:**

```json
{ "stickerId": 2125, "catId": 50, "type": 1, "cdnUrl": "https://..." }
```

`cdnUrl` is optional — when omitted the backend looks it up via
`api.getStickersDetail` so the persisted Message carries a renderable
URL (BR-0003 of SPEC §3).

**Validation errors (400):**

- `{ "error": "stickerId, catId, type là bắt buộc", "code": "invalid_body" }`
  — any of the three IDs is missing or not a finite number.

**Other errors:**

| Status | `code` | When |
|---|---|---|
| 400 | _(none)_ | Zalo account not connected for that conversation. |
| 404 | _(none)_ | Cross-org or unknown conversation id. |
| 429 | _(none)_ | Per-account send rate limit hit (existing `zaloRateLimiter`). |
| 502 | `sticker_unsupported` | The pooled zca-js instance has no `sendSticker()` method. |
| 502 | `zalo_send_failed` | zca-js `sendSticker` threw — no Message persisted. |

**Response 200:** the freshly-persisted `Message` row plus the
sticker envelope. Frontend renders by reading
`JSON.parse(message.content)`.

```json
{
  "messageId": "uuid",
  "sticker": { "stickerId": 2125, "catId": 50, "type": 1, "cdnUrl": "https://..." }
}
```

Side effect: emits Socket.IO `chat:message` with the Message row
(payload identical to `POST /messages`).

### GET `/api/v1/zalo/stickers/:stickerId`

Resolve a sticker id to its CDN URL via zca-js
`api.getStickersDetail([stickerId])`. Used by the FE when the
incoming sticker message lacks an embedded `cdnUrl` (e.g. legacy
inbound rows persisted before this feature).

**Path params:** `stickerId` — numeric Zalo sticker id.

**Query params:**

| Name | Type | Required | Notes |
|---|---|---|---|
| `accountId` | UUID | yes | Which Zalo account to call the SDK on. |
| `catId` | number | no | Category hint; falls back to the value returned by the SDK. |

**Permission:** caller must be owner/admin OR have a
`ZaloAccountAccess` row with `chat`/`admin` on `accountId`. The
endpoint resolves the ACL inline (mirrors `requireZaloAccess('chat')`
but reads `accountId` from the query string instead of params).

**Validation errors (400):**

- `{ "error": "stickerId không hợp lệ" }` — non-numeric path param.
- `{ "error": "accountId là bắt buộc", "code": "missing_account" }` — missing query.

**Other errors:**

| Status | `code` | When |
|---|---|---|
| 403 | _(none)_ | Caller lacks `chat` access on the account — `{ "error": "Không có quyền truy cập tài khoản Zalo này" }`. |
| 404 | _(none)_ | Cross-org or unknown `accountId`. |
| 503 | `account_offline` | Zalo account not connected. |
| 502 | `sticker_lookup_failed` | zca-js returned no entry for that stickerId. |

**Response 200:**

```json
{
  "stickerId": 2125,
  "catId": 50,
  "type": 1,
  "cdnUrl": "https://zalocdn/.../2125.png",
  "animationType": "static"
}
```

Entries are cached in-process for 24h (BR-0008) — repeated FE calls
for the same `stickerId` don't re-hit zca-js.

### GET `/api/v1/zalo/sticker-catalogues`

Return the sticker pack list used by the `StickerPicker` component.

**Query params:**

| Name | Type | Required | Notes |
|---|---|---|---|
| `accountId` | UUID | yes | Same ACL pattern as the detail endpoint. |

**Permission:** same as `GET /stickers/:stickerId` — `chat` or
higher on the account.

**Response 200:**

```json
{
  "catalogues": [
    {
      "id": "default",
      "name": "Default",
      "stickers": [
        { "stickerId": 2125, "catId": 50, "type": 1, "cdnUrl": "https://..." }
      ]
    }
  ]
}
```

Phase 1 returns a hardcoded default catalogue (BR-0009) — Phase 2
will hit Zalo's real catalogue API.

---

## Feature 0030 — Zalo user info popup

One-shot lookup that backs the avatar-hover popover. Crosses Zalo
identity data (`api.getUserInfo`) with the org's `Contact` table so
the FE can show "Tạo Contact" or "Xem trong CRM". See
[features/0030-zalo-user-popup/SPEC.md](../features/0030-zalo-user-popup/SPEC.md).

### GET `/api/v1/zalo/users/:uid`

**Path params:** `uid` — numeric Zalo uid.

**Query params:**

| Name | Type | Required | Notes |
|---|---|---|---|
| `accountId` | UUID | yes | Which Zalo account to call `getUserInfo` on. |

**Permission:** owner/admin bypass; member must have `chat` or
`admin` on `accountId`. The middleware is inlined because
`requireZaloAccess` reads `accountId` from path params, not query.

**Validation errors (400):**

- `{ "error": "missing_account_id" }` — `accountId` not provided.
- `{ "error": "invalid_uid" }` — `uid` is empty or not all digits.

**Other errors:**

| Status | When |
|---|---|
| 403 | Member without `chat` access on `accountId` — `{ "error": "Không có quyền truy cập tài khoản Zalo này" }` (or `"Không đủ quyền"` for `read`-only). |
| 404 | Cross-org or unknown `accountId` — `{ "error": "Account not found" }`. |

**Response 200:**

```json
{
  "uid": "2347234782",
  "displayName": "Lan Anh",
  "avatarUrl": "https://...",
  "gender": "female",
  "phone": "0901234567",
  "contactId": "uuid | null",
  "online": true,
  "cached": false
}
```

- `contactId` is the org's `Contact.id` if a row with this `zaloUid`
  exists, else `null` — drives the popover's "Tạo Contact" vs "Xem
  trong CRM" CTA (BR-0007 in SPEC §3).
- `online` is `false` when the underlying Zalo account isn't
  connected; the payload either echoes a cached entry or returns a
  `displayName: "Unknown"` stub (EC-0003).
- `cached: true` when the value came from the in-process 10-minute
  cache. Cache key is `${accountId}:${uid}`.

**Degraded responses (still 200):**

- zca-js throws (privacy, network) → `displayName: "Unknown"`,
  empty avatar/gender/phone, `online: true` (EC-0001 in SPEC §5).
  The FE still renders a useful popover.
- Account offline → see above.

---

## Feature 0033 — Friend aggregates

Read-only aggregate of the org's Zalo friend list, used by the
dashboard's "Friend stats" widget and the unified Friends grid (which
also feeds Feature 0042's left-rail counter). See
[features/0033-friend-aggregates/SPEC.md](../features/0033-friend-aggregates/SPEC.md).

### GET `/api/v1/friends/stats`

Per-Zalo-account aggregate plus org-wide totals.

**Permission:** any authenticated user. Owner/admin sees every
`ZaloAccount` in the org; members are restricted to accounts they
have a `ZaloAccountAccess` row for.

**Response 200:**

```json
{
  "byAccount": [
    {
      "zaloAccountId": "uuid",
      "displayName": "Sale account #1",
      "acceptedNicksCount": 142,
      "chattingNicksCount": 38
    }
  ],
  "totals": {
    "acceptedNicksCount": 142,
    "chattingNicksCount": 38
  },
  "windowDays": 7
}
```

- `acceptedNicksCount` — total friends on the account.
- `chattingNicksCount` — friends with at least one inbound message
  within `windowDays` (configurable; default 7).
- `windowDays` — comes from `config.friendChatWindowDays`.

**Caching:** 60-second in-memory cache keyed by `(orgId, userId)`
(BR-0007). Friend rows and message activity drift slowly enough that
brief staleness beats re-aggregating on every dashboard reload.

**Errors:** none in normal operation — an empty org returns
`{ byAccount: [], totals: { 0, 0 }, windowDays }`.

---

## Feature 0035 — Per-account proxy + 0044 — Master-key rotation

Allows owners/admins to route each `ZaloAccount` through a different
HTTP(S)/SOCKS5 proxy and rotates the master encryption key that
protects sensitive at-rest data (proxy URLs, AI API keys, integration
configs). See
[features/0035-per-account-proxy/SPEC.md](../features/0035-per-account-proxy/SPEC.md)
and
[features/0044-master-key-rotation/SPEC.md](../features/0044-master-key-rotation/SPEC.md).

### PUT `/api/v1/zalo-accounts/:id` — Cycle 2026-05 additions

Existing endpoint (Owner/Admin only) is extended with `proxyUrl` and
the response gains a `requiresReconnect` flag.

**New body fields:**

| Field | Type | Notes |
|---|---|---|
| `proxyUrl` | string \| null | Proxy URL or `null`/empty string to clear. |
| `displayName` | string \| null | Existing field — empty string treated as `null`. |

**Accepted proxy schemes** (BR-0002 of SPEC §3):

- `http://[user:pass@]host:port`
- `https://[user:pass@]host:port`
- `socks5://[user:pass@]host:port`
- `socks://...` — normalised to `socks5://` before persisting.

Trailing `/` is stripped. Empty string or `null` clears the proxy.

**Validation errors (400):**

- `{ "error": "Định dạng proxy không hợp lệ", "code": "invalid_proxy_format" }`
  — scheme not in the allow-list or URL fails Zod's `.url()` check
  (BR-0003).

**Permission:** `requireRole('owner', 'admin')`. Members hitting
the endpoint receive `403` from the role middleware before they ever
see the body.

**Response 200:**

```json
{
  "id": "uuid",
  "status": "connected",
  "displayName": "Sale account #1",
  "proxyUrl": "socks5://user:pass@10.0.0.1:1080",
  "liveStatus": "connected",
  "requiresReconnect": true
}
```

- `requiresReconnect: true` when the new `proxyUrl` differs from the
  previous value AND `zaloPool.getStatus(id)` is `connected`
  (BR-0007). The FE prompts the admin to reconnect manually — the
  backend never auto-reconnects, to avoid race conditions.
- `proxyUrl` reflects the **post-update** plaintext value (decrypted
  in-process before serialising). It is never logged in full — see
  `maskProxyUrl()` for the redacted form (`socks5://***@host:port`,
  BR-0010).

**At-rest encryption (Feature 0044):** `proxyUrl` is stored as a
triplet (`proxyUrlCipher`, `proxyUrlIv`, `proxyUrlTag`) using
AES-256-GCM keyed by the org's derived key. The plaintext is only
materialised in memory while serving GET/PUT. If decryption fails
(typically post-rotation with a stale row) the response treats the
account as having no proxy and a warn-level log line is emitted.

### GET `/api/v1/zalo-accounts` — Cycle 2026-05 additions

**Field visibility changes** (BR-0005 of Feature 0035 SPEC):

- Owner/admin callers: each account object includes `proxyUrl`
  (decrypted, or `null` when unset / decryption failed).
- Non-admin callers: `proxyUrl` is omitted from the row entirely —
  it never appears in `/conversations` or other non-Settings endpoints
  either.

Existing fields (`id`, `status`, `displayName`, etc.) are unchanged.
No new query params.

### Master-key rotation (operator-facing)

Master-key rotation is **not** an HTTP endpoint — it ships as a
backend CLI (`backend/scripts/0044-rotate-master-key.ts`) and is
documented separately in the SPEC. The HTTP contract above is the
**only** observable change for API callers:

- Encrypted columns (`proxyUrlCipher/Iv/Tag`,
  `AiConfig.apiKeyCipher/Iv/Tag`, `Integration.configCipher/...`)
  are re-encrypted in-place during rotation.
- Wire shapes stay identical — the FE never sees ciphertext.
- A failed decrypt during a GET request returns the row with the
  affected plaintext field set to `null` rather than 500-ing, so a
  partially-rotated org never fully breaks.

---

## Feature 0036 — AI reply suggestions

"Bring-your-own-key" reply assistant. The admin configures a
provider + API key (Anthropic, OpenAI-compatible, Gemini, Ollama).
Sales staff hit a per-conversation endpoint that returns 3 reply
drafts. Content is never persisted — only counts and token metrics
go into `AiSuggestionLog`. See
[features/0036-ai-reply-suggestions/SPEC.md](../features/0036-ai-reply-suggestions/SPEC.md).

### GET `/api/v1/settings/ai-providers`

Static catalogue used by the Settings dropdown.

**Permission:** any authenticated user.

**Response 200:**

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "models": [{ "value": "claude-haiku-4-5", "label": "Claude Haiku 4.5" }],
      "requiresApiKey": true,
      "supportsCustomEndpoint": false
    }
  ]
}
```

### GET `/api/v1/settings/ai-config`

Read the org's current AI config. The API key is **never** echoed
back — only an `apiKeyConfigured` boolean.

**Permission:** `requireRole('owner', 'admin')`. Member → `403`.

**Response 200** (configured):

```json
{
  "id": "uuid",
  "provider": "anthropic",
  "apiKeyConfigured": true,
  "apiKeyHint": "***",
  "apiEndpoint": null,
  "model": "claude-haiku-4-5",
  "systemPrompt": "Bạn là CSKH...",
  "enabled": true,
  "maxSuggestionsPerDay": 1000,
  "updatedAt": "2026-05-15T10:00:00.000Z"
}
```

When no row exists yet the endpoint returns the same shape with
`id: null`, `apiKeyConfigured: false`, sensible defaults, and
`enabled: false` so the Settings form can render as an empty draft.

### PUT `/api/v1/settings/ai-config`

Upsert config. The handler runs a one-token test request against
the provider before persisting (BR-0012) — bad keys never reach
the DB.

**Permission:** owner/admin only.

**Body:**

| Field | Type | Notes |
|---|---|---|
| `provider` | string | Must match a known provider id (`anthropic`, `openai`, `gemini`, `ollama`, ...). Default `anthropic`. |
| `apiKey` | string \| null \| undefined | `string` → encrypt + replace; `null` → clear key + force `enabled=false`; `undefined` → keep existing cipher. |
| `apiEndpoint` | string \| null | Custom base URL (OpenAI-compat / self-hosted Ollama). `undefined` keeps existing. |
| `model` | string | Defaults to the provider's first model. |
| `systemPrompt` | string \| null | Optional system prompt, max **2000** chars. |
| `enabled` | boolean | Defaults to the existing value, or `false` for new rows. |
| `maxSuggestionsPerDay` | integer | Org cap. Default `1000`. Range `[1, 1_000_000]`. |
| `skipTest` | boolean | Internal: skip the test-connect step (used by migrations). |

**Validation errors (400):**

- `{ "error": "Unknown provider: <id>" }`.
- `{ "error": "Model is required" }`.
- `{ "error": "maxSuggestionsPerDay must be an integer in [1, 1_000_000]" }`.
- `{ "error": "systemPrompt must be ≤ 2000 characters" }`.
- `{ "error": "API key required to enable this provider" }` — caller
  flipped `enabled: true` on a provider that needs a key without
  ever supplying one.
- `{ "error": "Provider test failed: <upstream message>" }` — the
  one-token test request rejected the key. Key fragments
  (`sk-...`) are scrubbed before bubbling the message.

**Response 200:** the serialised config (same shape as `GET`),
including a refreshed `updatedAt`.

### DELETE `/api/v1/settings/ai-config`

Soft-delete — disables AI and clears the encrypted key, but leaves
the rest of the config row intact so admins can re-enable by adding
a new key.

**Permission:** owner/admin only.

**Response:** `204 No Content` (also when nothing existed to delete).

### GET `/api/v1/settings/ai-usage`

Aggregated counters from `AiSuggestionLog`. Privacy-safe by
construction — only counts, tokens, costs, and userIds are stored.

**Permission:** owner/admin only.

**Query params:**

| Name | Type | Notes |
|---|---|---|
| `from` | ISO date | Inclusive lower bound on `createdAt`. Optional. |
| `to` | ISO date | Inclusive upper bound. Optional. |

**Response 200:**

```json
{
  "total": 248,
  "totalTokensIn": 84210,
  "totalTokensOut": 9120,
  "totalCost": 0.43,
  "errorCount": 4,
  "topUsers":   [{ "userId": "uuid", "count": 87 }],
  "byProvider": [{ "provider": "anthropic", "count": 248 }]
}
```

**Errors:**

- `500` — `{ "error": "Failed to compute usage" }` if the aggregate
  query fails (logged server-side).

### POST `/api/v1/conversations/:id/ai-suggestions`

Generate 3 reply drafts for a conversation. Triggered by the
"Gợi ý phản hồi (AI)" button in the chat composer.

**Path params:** `id` — conversation UUID.

**Permission:** `requireZaloAccess('chat')` — owner/admin bypass,
members need `chat` or `admin` on the Zalo account (BR-0003).

**Body:** none — the service reads the recent message thread
server-side.

**Response 200:**

```json
{
  "suggestions": [
    "Cảm ơn anh, em gửi ngay báo giá qua đây nhé.",
    "Dạ vâng, mình có size M anh nhé.",
    "Em kiểm tra hàng rồi báo lại sớm nhất ạ."
  ],
  "fromCache": false,
  "cachedUntil": "2026-05-15T10:05:00.000Z",
  "provider": "anthropic",
  "model": "claude-haiku-4-5"
}
```

- Repeat calls on the same `triggerMsgId` are served from a
  per-conversation cache (`fromCache: true`) until `cachedUntil`.

**Error codes (handler-mapped):**

| Status | `error` | Meaning |
|---|---|---|
| 400 | `no_context` / `no_inbound` | Conversation has no messages, or the latest message is outbound (nothing to reply to). |
| 412 | `ai_disabled` | Org disabled the feature in Settings. |
| 412 | `provider_unconfigured` | No API key on file. |
| 412 | `unknown_provider` | Stored provider id is no longer in the registry. |
| 429 | `rate_limit_org` | Org hit `maxSuggestionsPerDay`. Includes `retryAfter` (seconds) in the body and a `Retry-After` header. |
| 429 | `rate_limit_user` | Per-user/per-minute throttle. Same headers. |
| 502 | `provider_401` | Provider rejected the API key. The config is auto-disabled by the service. |
| 503 | `provider_5xx` / `provider_timeout` / `provider_other` | Upstream provider failure — message: `"AI provider unavailable"`. |
| 500 | `internal_error` / `unknown` | Unhandled error. |

Error body shape:

```json
{ "error": "rate_limit_org", "message": "...", "retryAfter": 42 }
```

`retryAfter` is only present on 429 responses.
