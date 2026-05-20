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
