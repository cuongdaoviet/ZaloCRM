# Feature 0044: Master-key rotation tooling

## 1. Mô tả

Three shipped features encrypt secrets at rest via the shared helper
`backend/src/shared/crypto/encrypt-config.ts`:

- **0036 AI suggestions** — provider API keys per org (`AiConfig.apiKeyCipher`)
- **0038 Integration Hub** — OAuth refresh tokens + Telegram bot tokens
  per integration (`Integration.configCipher`)
- **0035 per-account proxy** — proxy URLs with embedded credentials
  (`ZaloAccount.proxyUrl`) — **currently plaintext**, see below

All three use one master key: env var `AI_CONFIG_MASTER_KEY` (64 hex
chars, 32 bytes). HKDF-SHA-256 derives a per-org sub-key, then
AES-256-GCM with random IV + 96-bit auth tag.

Today there is **no procedure** to rotate this master key. Losing
it = forfeiting every BYOK provider key + OAuth refresh token + Telegram
bot token. Suspected leak = no clean response.

Phase 1 ships:

1. **Dual-key read window** — helper accepts a current key
   (`AI_CONFIG_MASTER_KEY`) and an optional previous key
   (`AI_CONFIG_MASTER_KEY_PREVIOUS`). Decrypts try current first, fall
   back to previous. Encrypt always uses current.
2. **CLI re-encrypt command** — `pnpm rotate-master-key` reads every
   encrypted row, decrypts with whichever key works, re-encrypts with
   current, writes back. Batched, idempotent, resumable.
3. **0035 proxyUrl encryption-at-rest** — closes a real plaintext gap
   that 0035 SPEC BR-0009 explicitly deferred. proxyUrl becomes
   `proxyUrlCipher/Iv/Tag` columns. Required to make rotation cover
   ALL master-key-derived secrets (otherwise proxy URLs are still
   plaintext, partial rotation).
4. **RUNBOOK procedure** — documented step sequence for ops.

Out of scope phase 1: admin UI showing key fingerprints, audit log of
which key was used per call, external KMS integration, scheduled
auto-rotation.

## 2. User Stories

- **US-0044-1:** As an Ops engineer, when I suspect the master key has
  leaked (e.g. ex-employee with prod access), I follow a documented
  RUNBOOK procedure to rotate to a fresh key without service interruption
  and without forcing every org to re-enter credentials.
- **US-0044-2:** As an Ops engineer, I run `pnpm rotate-master-key`
  during a deploy window. It re-encrypts every protected row in batches,
  with progress output, in <5 minutes for an org with thousands of
  encrypted rows.
- **US-0044-3:** As a Compliance officer (or auditor), I have a
  documented key rotation procedure in `docs/operations/RUNBOOK.md`
  that I can show as evidence of operational readiness.
- **US-0044-4:** As a developer, I read the encrypt-config helper docs
  and understand which env var is current vs previous, and the system
  refuses to start in production if both are set to the same value
  (signal that rotation was misconfigured).

## 3. Business Rules

### Dual-key read window

- **BR-0001:** Helper reads two env vars:
  - `AI_CONFIG_MASTER_KEY` (required) — the **current** key. All NEW
    encryptions use this.
  - `AI_CONFIG_MASTER_KEY_PREVIOUS` (optional) — the **previous** key.
    Used ONLY for decrypt fallback.
- **BR-0002:** Decrypt path:
  1. Try `decryptForOrg(orgId, blob, currentKey)`. If auth-tag verifies
     → return plaintext.
  2. If `currentKey` decrypt fails AND `previousKey` is set: try
     `decryptForOrg(orgId, blob, previousKey)`. If that succeeds →
     return plaintext (log info: `[crypto] decrypted with previous key,
     re-encrypt pending`).
  3. If both fail → throw (genuine tamper / wrong env / corrupt blob).
- **BR-0003:** Encrypt path always uses `currentKey`. Never the previous.
- **BR-0004:** Boot-time guard: production refuses to start if
  - `AI_CONFIG_MASTER_KEY` is unset or placeholder, OR
  - Both env vars are set AND identical (signal of misconfig).
  Dev allows missing/placeholder for ergonomics (existing pattern).

### Re-encrypt CLI

- **BR-0005:** Command: `pnpm rotate-master-key` (added to
  `backend/package.json` scripts). Compiled to a single executable
  Node script at `backend/scripts/rotate-master-key.ts` (or
  `.mjs` if simpler).
- **BR-0006:** Tables + columns processed (in order):
  1. `ai_configs` — `(api_key_cipher, api_key_iv, api_key_tag)` —
     skip rows where `api_key_cipher = ''` (Ollama-style, no key).
  2. `integrations` — `(config_cipher, config_iv, config_tag)`.
  3. `zalo_accounts` — `(proxy_url_cipher, proxy_url_iv, proxy_url_tag)`
     — depends on BR-0011 (encryption-at-rest).
- **BR-0007:** Batch size 100 rows per transaction. Idempotent: if a
  row's blob already decrypts with current key, **skip** (no write,
  no error). This makes the script safely re-runnable.
- **BR-0008:** Progress output every batch: `[rotate] ai_configs
  450/1200 (37%) — 12 re-encrypted, 38 skipped (already current)`.
- **BR-0009:** Exit codes:
  - 0 — all rows processed successfully.
  - 1 — fatal error (env var missing, both keys identical, DB
    unavailable).
  - 2 — partial success: some rows failed to decrypt with EITHER key.
    Logs the rows by ID + table. Operator must investigate (likely
    corrupt blobs predating proper encryption, or a third historical
    key).
- **BR-0010:** Dry-run mode: `pnpm rotate-master-key --dry-run`
  reports what would be done without writing. Use during change-
  management approval.

### 0035 proxyUrl encryption-at-rest

- **BR-0011:** Schema migration:
  - Drop `zalo_accounts.proxy_url TEXT`
  - Add `proxy_url_cipher TEXT NULL`, `proxy_url_iv TEXT NULL`,
    `proxy_url_tag TEXT NULL`
- **BR-0012:** Backfill migration step: existing `proxy_url` plaintext
  values are encrypted using current `AI_CONFIG_MASTER_KEY` before the
  old column is dropped. Atomic via single migration script.
- **BR-0013:** `zalo-pool.ts` `loadProxyUrl()` decrypts on read using
  the dual-key helper. PUT proxyUrl endpoint encrypts on write.
- **BR-0014:** Logging: `maskProxyUrl()` continues to mask credentials
  in logs. Plaintext proxyUrl never appears in any log line.

### Test / safety

- **BR-0015:** Round-trip test: encrypt with previous key, swap env to
  current+previous, decrypt should succeed via fallback. Then run
  re-encrypt CLI; subsequent reads use current key only.
- **BR-0016:** Tamper test: corrupt one byte of cipher; decrypt MUST
  throw (auth tag mismatch). No silent failure.
- **BR-0017:** Concurrency: CLI uses `FOR UPDATE SKIP LOCKED` to avoid
  contending with normal app traffic. Re-encrypt is interleavable with
  live reads.

## 4. Input / Output

### Schema migration

```prisma
model ZaloAccount {
  // ... existing fields ...
  // Drop: proxyUrl String? @map("proxy_url")
  // Add:
  proxyUrlCipher String? @map("proxy_url_cipher")
  proxyUrlIv     String? @map("proxy_url_iv")
  proxyUrlTag    String? @map("proxy_url_tag")
}
```

Migration script (custom, not pure Prisma `db push`):
1. Read all `proxy_url` non-null rows.
2. For each: encrypt with `encryptForOrg(orgId, proxyUrl)`.
3. Write to new cipher/iv/tag columns.
4. `ALTER TABLE zalo_accounts DROP COLUMN proxy_url` (after backfill
   verified).

Implemented as `backend/scripts/migrate-encrypt-proxy-url.ts` — runs
**once** during the 0044 rollout. Idempotent.

### Helper API change

`backend/src/shared/crypto/encrypt-config.ts`:

```typescript
// Existing — UNCHANGED public API for encrypt
export function encryptForOrg(orgId: string, plaintext: string): EncryptedBlob;
export function encryptConfig(orgId: string, config: unknown): ConfigBlob;

// MODIFIED internal: now tries current → previous
export function decryptForOrg(orgId: string, blob: EncryptedBlob): string;
export function decryptConfig(orgId: string, blob: ConfigBlob): unknown;

// NEW exported helpers for the CLI
export function isCurrentlyEncrypted(orgId: string, blob: EncryptedBlob): boolean;
// True iff `blob` decrypts cleanly with the CURRENT master key (not previous).
// Used by the CLI to decide skip-vs-rewrite.

// MODIFIED boot guard
export function assertAiMasterKey(): void;
// Adds the "both keys identical" check.
```

The signature of `decryptForOrg` does NOT change — call sites are
untouched. The fallback is internal.

### CLI script

`backend/scripts/rotate-master-key.ts`:

```typescript
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const stats = {
    aiConfigs: { total: 0, reencrypted: 0, skipped: 0, failed: 0 },
    integrations: { /* ... */ },
    zaloAccounts: { /* ... */ },
  };

  // For each table, in batches of 100, with FOR UPDATE SKIP LOCKED:
  //   - Fetch batch
  //   - For each row: check isCurrentlyEncrypted → skip if true
  //   - Else: decrypt (via dual-key helper) → encrypt with current → update
  //   - If decrypt fails both keys: record failed row id, continue
  //   - Print progress
  //   - On dry-run: skip the UPDATE

  console.log(JSON.stringify(stats, null, 2));
  process.exit(stats.aiConfigs.failed + stats.integrations.failed + stats.zaloAccounts.failed > 0 ? 2 : 0);
}
```

Added to `backend/package.json`:
```json
{
  "scripts": {
    "rotate-master-key": "tsx scripts/rotate-master-key.ts"
  }
}
```

### Runbook section

New section in `docs/operations/RUNBOOK.md` titled "Master key rotation":

```markdown
## Master key rotation (Feature 0044)

### When to rotate
- Suspected key leak (ex-employee access, accidental commit, …)
- SOC2 / ISO 27001 schedule
- After incident response

### Procedure

1. Generate new key:
   ```
   openssl rand -hex 32
   ```

2. In production env (staging first, then prod):
   - Set `AI_CONFIG_MASTER_KEY_PREVIOUS = <old key>`
   - Set `AI_CONFIG_MASTER_KEY = <new key>`
   - Deploy backend.

3. Verify app is healthy. Check logs for `[crypto] decrypted with
   previous key, re-encrypt pending` lines — these confirm fallback works.

4. Run dry-run:
   ```
   pnpm rotate-master-key --dry-run
   ```
   Confirm row counts look right.

5. Run actual rotation:
   ```
   pnpm rotate-master-key
   ```
   Monitor progress output. Should complete in <5 min for typical
   org size.

6. If exit code 2: investigate failed row IDs. May be legacy
   undecryptable rows that predate proper encryption. Decide:
   delete, accept loss, or restore from backup.

7. Verify: re-run with `--dry-run` should show all rows skipped
   (already current). If any rows would be re-encrypted, step 5
   missed them.

8. Remove `AI_CONFIG_MASTER_KEY_PREVIOUS` from env. Deploy.

9. Document rotation in operations log: date, who, why.

### Recovery if step 2 deploy fails
- Roll back env vars to old key only.
- App resumes normal operation; no data is touched yet.
```

## 5. Edge Cases

- **EC-0001:** Both env vars set to identical values → boot fails with
  clear error "AI_CONFIG_MASTER_KEY and AI_CONFIG_MASTER_KEY_PREVIOUS
  must differ". Prevents footgun deploys.
- **EC-0002:** Operator rotates env vars but forgets to run CLI → app
  still works (fallback decrypts), but every read pays the cost of
  trying current key first. Logs warn every time. Not silent.
- **EC-0003:** Operator runs CLI before deploying new env vars → CLI
  detects all rows already "current" → no-op exit. Safe.
- **EC-0004:** CLI killed mid-batch → committed batches stay
  re-encrypted with current key, uncommitted rows still on previous
  key → safe to re-run, picks up where it left off (idempotent per
  BR-0007).
- **EC-0005:** Row's blob is corrupt (was encrypted with a third
  historical key, e.g. from an undocumented earlier rotation) →
  decrypt fails on both keys → CLI logs the row ID, continues with
  next row, exits 2.
- **EC-0006:** During rotation window, a user creates a new AiConfig
  via the app → it's encrypted with current key → CLI's later batch
  sees `isCurrentlyEncrypted = true` → skips → safe.
- **EC-0007:** 0035 backfill (BR-0012): if a proxy_url row has invalid
  format that fails URL validation, the backfill script logs + skips.
  Operator decides whether to clear or fix manually.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `decryptForOrg` decrypts a blob encrypted with
      current key (no fallback needed). Existing tests still pass.
- [ ] **AC-0002:** `decryptForOrg` decrypts a blob encrypted with
      previous key when `AI_CONFIG_MASTER_KEY_PREVIOUS` is set. Logs
      a warning.
- [ ] **AC-0003:** `decryptForOrg` throws when blob decrypts with
      neither key.
- [ ] **AC-0004:** Boot in production with both env vars identical →
      `assertAiMasterKey()` throws.
- [ ] **AC-0005:** `pnpm rotate-master-key` re-encrypts a seeded
      `AiConfig` (encrypted with previous key) so subsequent reads
      use current only.
- [ ] **AC-0006:** Re-run of CLI is idempotent — second run reports
      0 re-encrypted, all skipped.
- [ ] **AC-0007:** `--dry-run` reports planned changes without
      writing to DB.
- [ ] **AC-0008:** 0035 schema migration: `proxy_url` column dropped,
      `proxy_url_cipher/iv/tag` columns added. Backfill encrypts all
      existing proxy URLs.
- [ ] **AC-0009:** `zalo-pool.loadProxyUrl()` reads encrypted column
      via dual-key helper. Proxy URLs round-trip cleanly.
- [ ] **AC-0010:** PUT `/zalo-accounts/:id` with `proxyUrl` encrypts
      on write. Subsequent GET returns plaintext to admin caller
      (existing behavior).
- [ ] **AC-0011:** Tamper test: corrupt 1 byte of `apiKeyCipher` →
      decrypt throws.
- [ ] **AC-0012:** CLI handles 3 tables in order (ai_configs,
      integrations, zalo_accounts) and reports per-table stats.
- [ ] **AC-0013:** CLI exit code 2 when any rows fail decrypt with
      both keys; failed row IDs logged.
- [ ] **AC-0014:** RUNBOOK section "Master key rotation" exists with
      the 9-step procedure + recovery steps.
- [ ] **AC-0015:** Build pass: BE tsc + FE vue-tsc + vite (FE
      untouched, smoke check only).

## 7. Dependencies

- `backend/src/shared/crypto/encrypt-config.ts` — extend dual-key
  fallback + boot guard.
- `backend/src/config/index.ts` — add `aiConfigMasterKeyPrevious`
  optional config field.
- `backend/.env.example` — document new env var with explanatory
  comment.
- `backend/prisma/schema.prisma` — `ZaloAccount` field swap.
- `backend/scripts/rotate-master-key.ts` — new CLI script.
- `backend/scripts/migrate-encrypt-proxy-url.ts` — one-off backfill
  script (runs once during 0044 rollout, then can be retired).
- `backend/package.json` — `rotate-master-key` script entry. Verify
  `tsx` is already a dev dep; if not add `tsx@^4`.
- `backend/src/modules/zalo/zalo-pool.ts` — encrypt/decrypt proxyUrl
  in `loadProxyUrl()` + the PUT path.
- `backend/src/modules/zalo/zalo-routes.ts` — encrypt proxyUrl on
  PUT before save, decrypt on GET for admin response.
- `docs/operations/RUNBOOK.md` — new "Master key rotation" section.
- Backend tests: unit tests for dual-key helper, integration test
  for CLI round-trip, integration test for proxyUrl encryption.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration (proxyUrl swap) | ~10 |
| One-off backfill script (proxyUrl encryption) | ~80 |
| Helper extension (dual-key fallback + boot guard) | ~60 |
| zalo-pool + zalo-routes proxyUrl encrypt/decrypt | ~50 |
| CLI rotate-master-key.ts (3 tables + batching + reporting) | ~250 |
| Unit tests (dual-key, tamper, idempotent) | ~150 |
| Integration tests (CLI round-trip, proxyUrl encryption) | ~180 |
| RUNBOOK section | ~80 LOC markdown |
| **Total** | **~860 LOC** |

### Risk: MEDIUM

Two real risks:

1. **0035 proxyUrl migration corrupting live data.** Mitigation: dry-
   run first, take DB snapshot before, verify backfill via SELECT
   COUNT WHERE proxy_url IS NOT NULL = SELECT COUNT WHERE
   proxy_url_cipher IS NOT NULL.

2. **CLI consuming too much DB during rotation window.** Mitigation:
   batch size 100, `FOR UPDATE SKIP LOCKED`, configurable
   `--batch-size` flag for tuning.

### Test strategy

- **Unit** (`tests/unit/encrypt-config-rotation.test.ts`): dual-key
  fallback, identical-key guard, isCurrentlyEncrypted predicate.
- **Integration** (`tests/integration/rotate-master-key.integration.test.ts`):
  seed AiConfig + Integration + ZaloAccount rows encrypted with key A,
  run CLI with key B current + key A previous, verify all rows
  re-encrypted, second CLI run is no-op, dry-run doesn't write.
- **Migration test** (`tests/integration/migrate-encrypt-proxy-url.integration.test.ts`):
  seed plaintext proxy_url, run backfill, verify cipher fields
  populated, plaintext column dropped.

### Why we don't use external KMS (phase 1)

Hashicorp Vault / AWS KMS would give us proper rotation with no
re-encrypt step (KMS manages key versions internally). But:
- Adds external infrastructure dependency (Vault server or AWS
  account).
- Latency on every encrypt/decrypt (network call).
- Operational complexity (Vault unseal procedure, IAM policies).
- ZaloCRM today runs on a single VPS pattern.

Phase 1 keeps it boring: two env vars, one CLI command, one
RUNBOOK page. When we move to multi-region or compliance-heavy
deployment, KMS becomes the right call.

### Why we include 0035 in scope

Original 0035 SPEC BR-0009 said: "proxy_url stored plaintext;
acceptable since same threat model as sessionData". That was true
in isolation. But once 0036 and 0038 introduced encrypted secrets
under one master key, leaving proxy_url plaintext means:

- "Rotate the master key" rotates only 2 of 3 sensitive surfaces.
- Compliance gets messier ("encryption-at-rest? mostly").
- A future audit asks why proxy URLs (which contain credentials!)
  are plaintext while AI keys aren't.

Closing the gap now while we're already touching the crypto helper
is cheaper than touching it again later.

### Out of scope (Phase 2)

- Admin UI showing key fingerprint + last rotation timestamp.
- Audit log of which key version decrypted each call.
- External KMS integration (Vault / AWS KMS).
- Automatic periodic rotation (cron-triggered).
- Per-org key (instead of derived sub-keys from one master). Would
  enable per-org compromise containment.
- Backup encryption (DB dumps currently plaintext).
- Encryption of `sessionData` (Zalo session blobs) — same threat
  model rationale as old 0035 BR-0009, but worth revisiting.
