# Feature 0038: Integration Hub framework + Sheets + Telegram (phase 1)

## 1. Mô tả

ZaloCRM-3.0 release notes liệt kê "Integration Hub" như framework cho
nhiều connector. Phase 1 chúng ta build framework + 2 connector cụ thể:

1. **Google Sheets** — one-way export. Sync contacts (hoặc filtered
   subset) ra 1 Google Sheet theo schedule (daily / on-demand). Admin
   nhận biết doanh số dễ chia sẻ với người không có CRM access.
2. **Telegram Bot** — push notifications. Sự kiện như "contact mới",
   "đơn hàng mới", "appointment sắp tới" → đẩy vào 1 Telegram channel
   của ops team.

Mỗi connector: 1 OAuth/setup flow + 1 worker. Framework chung
(`Integration` model, scheduler, error log) phục vụ phase 2 connectors
(Facebook Messenger, Zapier, etc.).

## 2. User Stories

- **US-0038-1:** Là Admin, tôi vào Settings → Integrations → "Add
  Google Sheets" → OAuth flow → chọn Sheet đích → chọn schedule (daily
  6am) + filter (vd "Only contacts status=interested") → save.
- **US-0038-2:** Là Admin, sau khi sync chạy, tôi xem log: thành công?
  bao nhiêu rows? error gì?
- **US-0038-3:** Là Admin, tôi vào Settings → Integrations → "Add
  Telegram Bot" → paste bot token + chat ID → chọn event types ("contact.created",
  "order.created", "appointment.reminder") → save → test notification fires.
- **US-0038-4:** Là Sale, một contact mới được tạo → Telegram channel
  có notification trong vài giây.

## 3. Business Rules

### Framework

- **BR-0001:** `Integration` model là generic container:
  - `id`, `orgId`, `type` (`google_sheets` | `telegram_bot`)
  - `name` (user-friendly label)
  - `configCipher` (encrypted JSON containing tokens + connector-
    specific fields)
  - `enabled` boolean
  - `lastSyncedAt`, `lastError`
- **BR-0002:** `IntegrationRun` model per execution:
  - `integrationId`, `startedAt`, `completedAt`, `status` (`running` |
    `succeeded` | `failed`), `recordsProcessed`, `errorDetail`
- **BR-0003:** Each connector implements interface:
  ```ts
  interface IntegrationConnector {
    type: 'google_sheets' | 'telegram_bot';
    validateConfig(config: any): { ok: boolean; error?: string };
    testConnection(config: any): Promise<{ ok: boolean; error?: string }>;
    // For scheduled (Sheets):
    sync?(orgId: string, config: any): Promise<{ recordsProcessed: number }>;
    // For event-driven (Telegram):
    onEvent?(event: IntegrationEvent, config: any): Promise<void>;
  }
  ```

### Google Sheets connector

- **BR-0004:** OAuth 2.0 flow. We register a Google OAuth app + ship
  client ID/secret in env. Each org authorizes → we get a refresh token
  per integration row.
- **BR-0005:** Config (encrypted) contains: `refreshToken`,
  `spreadsheetId`, `sheetName`, `filter` (json), `schedule` (cron
  expression — phase 1 only daily / hourly / manual).
- **BR-0006:** Sync writes 1 row per contact matching filter. Headers
  on first run: id, fullName, phone, status, tags (comma-joined), source,
  createdAt, assignedUserName.
- **BR-0007:** Subsequent runs **overwrite** (clear sheet content +
  rewrite). Phase 2: append-only with timestamp column.
- **BR-0008:** Filter shape mirrors existing `GET /contacts` query
  params (status, tags, dateFrom, dateTo).
- **BR-0009:** Scheduler: cron job every 5 min picks up integrations
  with `lastSyncedAt < scheduledNextRun`. Reuse worker pattern from
  Feature 0037.

### Telegram Bot connector

- **BR-0010:** Setup is simpler — admin creates bot via @BotFather on
  Telegram, gets bot token + chat ID. No OAuth.
- **BR-0011:** Config: `botToken`, `chatId`, `eventTypes` (array of
  enum: `contact.created`, `order.created`, `appointment.reminder`,
  `message.escalated`).
- **BR-0012:** Event dispatch is fire-and-forget. Webhook emitter
  (existing `emitWebhook` helper) tee'd to Integration Hub when at
  least one Telegram integration is configured.
- **BR-0013:** Message format: structured per event type. Examples:
  - `contact.created`: `🆕 KH mới: <fullName> (<phone>) — nguồn: <source>`
  - `order.created`: `💰 Đơn mới: <orderNumber> — <amount> VND — KH: <fullName>`
  - `appointment.reminder`: `📅 Hẹn sắp tới (15min): <contactName> @ <time>`

### Security

- **BR-0014:** `Integration.configCipher` encrypted same as Feature
  0036 AiConfig — AES-256-GCM with `INTEGRATION_CONFIG_MASTER_KEY` env.
- **BR-0015:** OAuth refresh tokens never logged or returned in
  GET response.
- **BR-0016:** Telegram bot tokens never logged. Helper masks
  `bot1234567890:AB***xyz`.

### Permissions

- **BR-0017:** Integrations CRUD: Admin/Owner only.
- **BR-0018:** Worker has full read access (system user). Filtered by
  `orgId` always.

## 4. Input / Output

### Schema migration

```prisma
model Integration {
  id            String   @id @default(uuid())
  orgId         String   @map("org_id")
  type          String   // 'google_sheets' | 'telegram_bot'
  name          String
  configCipher  String   @map("config_cipher")
  configIv      String   @map("config_iv")
  configTag     String   @map("config_tag")
  enabled       Boolean  @default(true)
  lastSyncedAt  DateTime? @map("last_synced_at")
  lastError     String?   @map("last_error")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  org  Organization      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  runs IntegrationRun[]

  @@index([orgId, type])
  @@index([enabled, lastSyncedAt])
  @@map("integrations")
}

model IntegrationRun {
  id                String   @id @default(uuid())
  integrationId     String   @map("integration_id")
  startedAt         DateTime @default(now()) @map("started_at")
  completedAt       DateTime? @map("completed_at")
  status            String   @default("running") // running|succeeded|failed
  recordsProcessed  Int      @default(0) @map("records_processed")
  errorDetail       String?  @map("error_detail")

  integration Integration @relation(fields: [integrationId], references: [id], onDelete: Cascade)

  @@index([integrationId, startedAt(sort: Desc)])
  @@map("integration_runs")
}
```

### Endpoints

#### `GET /api/v1/integrations`

- Admin/Owner only.
- Returns list of integrations for the org. ConfigCipher NOT exposed.
- Includes computed `configured: boolean`, `lastSyncedAt`, `lastError`.

#### `POST /api/v1/integrations`

- Body: `{ type, name, config }` (config plaintext from FE).
- Validate via connector's `validateConfig`.
- Test connection via `testConnection`.
- Encrypt + persist.
- Return 201 with integration ID.

#### `PATCH /api/v1/integrations/:id`

- Update config (partial). Re-test connection if config changed.

#### `DELETE /api/v1/integrations/:id`

- Soft-delete: set `enabled=false` and clear config.

#### `POST /api/v1/integrations/:id/sync`

- Manual trigger for sync-capable connectors (Sheets). Returns 202 +
  run ID immediately; sync runs async.

#### `GET /api/v1/integrations/:id/runs?limit=20`

- Returns recent runs for the integration.

#### `GET /api/v1/integrations/oauth/google/callback`

- OAuth redirect target for Google Sheets. Exchanges code for refresh
  token, encrypts + creates Integration row.

### Worker

`backend/src/workers/integration-runner.ts`:
- Every 5 min, find integrations with type=`google_sheets`, enabled,
  next-due (based on schedule cron).
- For each: create `IntegrationRun` row, call `connector.sync()`,
  update row with success/failure.
- Singleton flag (same pattern as Feature 0037 workflow worker). Phase
  2: `SKIP LOCKED`.

### Event dispatcher (Telegram)

Hook into existing `emitWebhook(orgId, eventType, payload)` helper:
- Find Telegram integrations for orgId where `eventTypes` includes
  `eventType`.
- For each: format message + POST to Telegram Bot API
  (`https://api.telegram.org/bot<token>/sendMessage`).
- Fire-and-forget via `trackBackground()`.

### Frontend

- New page `SettingsIntegrationsView.vue` — list integrations + add
  button + per-row run history.
- `frontend/src/components/integrations/GoogleSheetsForm.vue` — config
  form + OAuth launch button.
- `frontend/src/components/integrations/TelegramBotForm.vue` — config
  form + event type checkboxes.
- `frontend/src/composables/use-integrations.ts` — CRUD + run history.

## 5. Edge Cases

- **EC-0001:** Google refresh token revoked by user (off-platform) →
  next sync fails with 401, `lastError` set, FE shows banner. Admin
  must re-authorize.
- **EC-0002:** Telegram bot token rotated → 401 from sendMessage,
  `lastError` set.
- **EC-0003:** Sheets has > 100k rows → Google API rate-limits.
  Implement chunked batch write (1000 rows/batch).
- **EC-0004:** Contact deleted mid-sync → skip (defensive).
- **EC-0005:** Multiple Telegram integrations on same orgId for same
  event type → each fires independently (intentional — different
  channels for different teams).
- **EC-0006:** Worker overlap → singleton flag prevents (phase 1).
- **EC-0007:** Event fires while integration is disabled → skip.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Schema migration creates 2 tables + indices.
- [ ] **AC-0002:** POST /integrations type=`google_sheets` with valid
      OAuth code → 201, encrypted config stored, GET returns without
      raw refresh token.
- [ ] **AC-0003:** POST type=`telegram_bot` with valid bot token + chat
      ID → 201; test message sent to Telegram (verify in real chat).
- [ ] **AC-0004:** POST with invalid bot token → 400 with provider
      error.
- [ ] **AC-0005:** Member POST/PATCH/DELETE → 403.
- [ ] **AC-0006:** Manual POST /:id/sync triggers a run; row created
      in IntegrationRun.
- [ ] **AC-0007:** Worker picks up due integration on next tick.
- [ ] **AC-0008:** Sheets sync writes correct headers + rows (verify in
      a real test sheet).
- [ ] **AC-0009:** Telegram event fires when contact.created webhook
      emits; message format matches BR-0013.
- [ ] **AC-0010:** Disabled integration → events skipped + sync skipped.
- [ ] **AC-0011:** Logs don't contain raw tokens (grep test).
- [ ] **AC-0012:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- New Prisma models (Integration, IntegrationRun).
- `backend/src/modules/integrations/` — new module:
  - `integration-routes.ts`
  - `integration-service.ts`
  - `connectors/google-sheets.ts`
  - `connectors/telegram-bot.ts`
  - `connectors/index.ts` (registry)
- `backend/src/workers/integration-runner.ts` — scheduler.
- `backend/src/modules/webhooks/emit-webhook.ts` (existing) — tee to
  integrations.
- `backend/package.json` — `googleapis@^130`, `@types/node-cron` (use
  existing setInterval pattern if not).
- Env vars:
  - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
    `GOOGLE_OAUTH_REDIRECT_URI`.
  - `INTEGRATION_CONFIG_MASTER_KEY`.
- `frontend/src/views/SettingsIntegrationsView.vue` — new.
- `frontend/src/components/integrations/*` — new.
- `frontend/src/composables/use-integrations.ts` — new.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema + migration | ~60 |
| Integration framework (routes + service + crypto) | ~250 |
| Google Sheets connector (OAuth + sync) | ~280 |
| Telegram Bot connector (sendMessage + format) | ~150 |
| Worker scheduler + event dispatcher | ~150 |
| FE Settings page + 2 connector forms + OAuth launch | ~400 |
| Backend tests | ~350 |
| FE tests | ~80 |
| **Tổng** | **~1,720 LOC** |

### Risk: MEDIUM-HIGH

- **OAuth flow complexity** — Google's OAuth has nuances around scopes
  (request only what we need), state CSRF, redirect URI matching.
- **Token expiry** — refresh tokens can be invalidated by user. Detect
  401 and surface clearly.
- **Webhook fan-out load** — if org has 10 Telegram integrations all
  subscribing to `contact.created`, 1 contact create triggers 10 HTTP
  requests. Use fire-and-forget + per-integration timeout.

### Test strategy

- Unit: connector validators, message format functions, encryption.
- Integration: end-to-end POST → integration created → manual sync →
  IntegrationRun row → mocked Sheets API receives correct payload.
- Manual: real Google account + test sheet + test Telegram bot — full
  setup walkthrough.

### Out of scope (Phase 2)

- Facebook Messenger (treat as another inbox source — big scope).
- Zapier generic webhook (simpler than Sheets/Telegram but still
  separate connector). 3.0's `zapier-webhook.ts` is a 70-LOC port-ready
  starter when prioritized.
- Two-way Sheets sync (read updates back into CRM).
- Append-only Sheets mode with timestamp column.
- Custom event templates (admin edits the message format).
- Slack notifications (separate connector).
- WhatsApp Business API.
- Cron expression UI (phase 1: daily / hourly only).
- Couple `automation/` (Feature 0037 workflows) with integrations — let
  workflows trigger Telegram messages or Sheets exports as an action
  type. 3.0 missed this; we should pick it up.

## 9. ZaloCRM-3.0 lessons (recon notes)

Scanned `/tmp/zalocrm3/backend/src/modules/integrations/` and
`/tmp/zalocrm3/frontend/src/views/IntegrationsView.vue`.

### Port verbatim from 3.0

**(a) `SyncResult` discriminated union + always-log pattern** — 20 LOC
gives observability for free. Our `IntegrationRun` model mirrors this:

```ts
interface SyncResult {
  direction: 'import' | 'export';
  recordCount: number;
  status: 'success' | 'partial' | 'failed';
  errorMessage?: string;
}
```

Wrap every connector call in `try/catch`, build `SyncResult`, persist
to `IntegrationRun` regardless of outcome.

**(b) Zapier SSRF guard** (port from
`/tmp/zalocrm3/backend/src/modules/integrations/providers/zapier-webhook.ts:24-35`)
— even though Zapier isn't in our phase 1, **the same guard applies to
Telegram bot host validation** (in case someone configures a malicious
custom endpoint). Apply to any user-supplied URL:

```ts
function isSafeOutboundUrl(rawUrl: string): boolean {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') return false;
  const blocked = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
  return !blocked.test(parsed.hostname);
}
```

For Telegram: validate that `apiEndpoint` (if overridden) passes this.
Default `api.telegram.org` is safe.

**(c) `AbortSignal.timeout(15_000)` on every fetch** — uniform 15s
ceiling prevents hung syncs.

### Deviate explicitly from 3.0

**(a) Real encryption.** 3.0 stores `Integration.config` as **plain
JSON** (`config Json @default("{}")`). They have `AppSetting.valueEncrypted`
but integrations bypass it. We MUST encrypt — AES-256-GCM (BR-0014)
using existing `ENCRYPTION_KEY` env (already in 3.0's
`config/index.ts:10`, port to ours).

**(b) OAuth for Google Sheets, not API key.** 3.0 uses a per-integration
Google API key — requires public sheet sharing. Our OAuth + refresh
token works on private sheets and is the right level for org-level
data.

**(c) Scheduled worker.** 3.0 has NO worker — only manual sync triggered
by user POST. Our 5-min cron picks up due integrations automatically.
node-cron is already a dep in 3.0 (`zalo-health-check.ts`,
`appointment-reminder.ts`); reuse that pattern.

**(d) Webhook event tee to Telegram.** 3.0 has `emitWebhook()` and
Telegram, but `emitWebhook` is **never tee'd** to integrations. Our
event-driven Telegram dispatch fills this gap.

**(e) Use connector interface, not switch-dispatcher.** 3.0 uses a
`switch (type)` in `sync-engine.ts`. Works but doesn't scale — adding
a new connector means editing the dispatcher. Our `IntegrationConnector`
interface in BR-0003 supports plug-in registration. Trade-off: one
more abstraction layer for type safety.

**(f) Type column should be a constrained string, not free-form.** 3.0
has `type: String` with route-layer validation only. We do the same
(can't enum-ify TEXT in Postgres without migration pain), but document
the allowlist as a TS union type for the registry to enforce.

### Surprises

- 3.0 `automation/` module exists but has **zero coupling** to
  integrations — no Telegram action, no webhook-out action. Phase 2
  for us: hook workflow steps to integrations.
- 3.0 `IntegrationsView.vue` is **one flat 287-line file** with per-type
  `v-if` blocks. We split into per-connector forms
  (`GoogleSheetsForm.vue`, `TelegramBotForm.vue`) for maintainability.
- 3.0 Facebook connector does sequential `findFirst` + `create` per
  participant inside a nested loop — N+1 write storm. If/when we add
  Facebook, batch with `createMany` + dedupe via index.
