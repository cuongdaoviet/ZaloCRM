# Feature 0046: Security hardening — cycle 2026-05 CSO findings

## 1. Mô tả

Closes all 8 findings from the 2026-05-21 `/cso` audit, saved at
`.gstack/security-reports/2026-05-21-135843.json`.

Split into 6 fix chunks ordered by severity + dependency:
1. **Dep upgrade** — `npm audit fix` for fast-jwt + fastify + others
   (closes findings #1, #4).
2. **JWT_SECRET boot guard + rotation policy** (closes #2). Force all
   users to log out on deploy.
3. **MinIO hardening** — bind 127.0.0.1, nginx reverse proxy, drop
   default creds (closes #3).
4. **Public API key hashing + lazy migration** (closes #5).
5. **OAuth state `timingSafeEqual` + login rate limit + Dockerfile
   USER directive** (closes #6, #7, #8).
6. **`.gstack/` to `.gitignore`** (housekeeping).

## 2. User Stories

- **US-0046-1:** As an Operator deploying ZaloCRM, the app refuses to
  start when `JWT_SECRET` is unset or matches the known placeholder.
  Same boot-guard pattern Feature 0044 introduced for `AI_CONFIG_MASTER_KEY`.
- **US-0046-2:** As an Ops engineer, after this feature ships I run
  `npm audit --omit=dev` and see zero CRITICAL or HIGH CVEs in
  direct deps.
- **US-0046-3:** As a Compliance officer, public API keys are stored
  as SHA-256 hashes — a DB read no longer reveals usable credentials.
  Existing plaintext keys migrate transparently on next use.
- **US-0046-4:** As a Security engineer, the production Docker
  container runs as a non-root user.
- **US-0046-5:** As an Attacker, credential-stuffing `/api/v1/auth/login`
  hits a per-email rate limiter after 5 failed attempts in 15 minutes.
- **US-0046-6:** As an Operator, MinIO API is bound to `127.0.0.1` only.
  Browser `<img src>` requests flow through nginx at `/attachments/*`,
  not directly to a public MinIO port. Default `minioadmin/minioadmin`
  is no longer accepted — deploy fails without explicit credentials.

## 3. Business Rules

### Dependency upgrade (closes #1, #4)

- **BR-0001:** Run `npm audit fix` (no `--force`) in `backend/`. Apply
  patch-version + minor-version upgrades only. Goal: pull
  `fast-jwt >6.1.0` (via `@fastify/jwt` upgrade) and the patched
  `fastify` body-validation fix.
- **BR-0002:** After upgrade, run `npm audit --omit=dev` and verify
  zero CRITICAL CVEs. Document remaining MODERATE CVEs in PR body
  (acceptable per CSO findings — moderate is below merge gate).
- **BR-0003:** Re-run full backend test suite + frontend build. Any
  test failure introduced by the upgrade → fix or back out the
  specific package.

### JWT_SECRET boot guard + session invalidation (closes #2)

- **BR-0004:** Add `assertJwtSecret()` to a new file
  `backend/src/shared/crypto/assert-jwt-secret.ts`. Pattern matches
  existing `assertAiMasterKey()`:
  - Production: throw if `JWT_SECRET` is unset, equals the literal
    placeholder `'dev-secret-change-me'`, or is shorter than 32
    characters.
  - Dev/test: accept the placeholder for ergonomics (existing
    pattern from `assertAiMasterKey`).
- **BR-0005:** Call `assertJwtSecret()` in `backend/src/app.ts` BEFORE
  `app.listen()` — same hook point as `assertAiMasterKey()`.
- **BR-0006:** Same guard for `config.encryptionKey` (still declared
  but unused in active code). Verify it's unused via grep; if no
  callsites, **delete the config field entirely** as a separate
  housekeeping commit.
- **BR-0007:** Session invalidation strategy: relying on JWT_SECRET
  rotation. Operators are instructed in RUNBOOK to set a fresh
  `JWT_SECRET` value when deploying this feature. The boot guard
  documents this. Active tokens signed with the old (potentially
  default) secret will fail verification → users see 401 → re-login.
  No DB schema change needed.

### MinIO hardening (closes #3)

- **BR-0008:** `docker-compose.yml` MinIO service:
  - Bind API to `127.0.0.1:9000` (was `0.0.0.0:9000` — change is to
    add the localhost prefix).
  - Remove `:-minioadmin` shell defaults. Required env vars are
    `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY`,
    `S3_SECRET_KEY`. If unset → docker-compose fails with clear
    error (no silent default).
- **BR-0009:** Add nginx reverse proxy in front of MinIO so the FE
  can still load `<img src="/attachments/...">`:
  - New `nginx/` directory with `nginx.conf` proxying
    `location /attachments/` → `http://minio:9000/zalocrm-attachments/`.
  - Update `S3_PUBLIC_URL` to `https://<app-host>/attachments` (no
    longer the raw MinIO port).
- **BR-0010:** `.env.example` updated: no defaults for MinIO creds.
  Operators must `openssl rand -base64 24` for each.
- **BR-0011:** Document migration in RUNBOOK: existing deploys
  running `0.0.0.0:9000` need to (a) rotate `MINIO_ROOT_USER` +
  `MINIO_ROOT_PASSWORD` to non-defaults, (b) deploy nginx config,
  (c) update `S3_PUBLIC_URL`.

### Public API key hashing + lazy migration (closes #5)

- **BR-0012:** Schema change: `app_settings` row for
  `setting_key='public_api_key'` keeps `value_plain` (for backward
  compat) AND gains an implicit hash via a new helper. **No schema
  migration** — we use the existing `value_plain` column transitionally,
  with a 2-stage logic:
  - Stage 1 (this feature): when an API key is **created** or
    **rotated**, store SHA-256 hash in `value_plain`. The lookup
    function hashes the incoming key and compares against `value_plain`.
  - Stage 2 (lazy migration): for any `public_api_key` row where
    `value_plain` is not a 64-char hex string (= legacy plaintext),
    on **next successful lookup** the row is updated to store the
    hash and the plaintext is cleared. Idempotent.
- **BR-0013:** Helper `hashApiKey(key: string): string` returns
  `crypto.createHash('sha256').update(key).digest('hex')`.
- **BR-0014:** `apiKeyAuth()` middleware refactored:
  - Lookup ALL rows with `setting_key = 'public_api_key'` (not
    filtered by `value_plain`).
  - For each: try (a) `hashApiKey(input) === row.value_plain`
    (already-migrated) AND (b) `input === row.value_plain` (legacy
    plaintext). Either match → success.
  - On legacy-plaintext match: enqueue a write to migrate (set
    `value_plain = hashApiKey(input)`).
- **BR-0015:** Constant-time string compare via `crypto.timingSafeEqual`
  in the hash lookup loop (security AND avoid leak of which org's key
  the attacker is close to).
- **BR-0016:** PUT/POST endpoints that create or rotate the public
  API key always hash on write (never plaintext for new keys).

### OAuth state timing-safe compare (closes #6)

- **BR-0017:** In `backend/src/modules/integrations/integration-routes.ts`
  `verifyOAuthState()`, replace `expected !== sig` with
  `crypto.timingSafeEqual(Buffer.from(expected, 'hex'),
  Buffer.from(sig, 'hex'))` with explicit length check before the
  comparison. Return `false` on length mismatch.

### Login rate limiting (closes #7)

- **BR-0018:** New module `backend/src/shared/security/login-attempt-tracker.ts`:
  - In-memory `Map<emailLower, { count: number, firstFailedAt: number }>`.
  - On each login failure: increment count, set firstFailedAt if 0.
  - On login success: clear entry for that email.
  - Threshold: 5 failures within 15 minutes → return 429 with
    `Retry-After` header pointing to (firstFailedAt + 15min).
  - Window reset: if 15 minutes have elapsed since `firstFailedAt`,
    reset counter to 0 on next attempt.
- **BR-0019:** Apply BEFORE `bcrypt.compare` in login flow — don't
  spend bcrypt CPU on a rate-limited request.
- **BR-0020:** Log auth.login.failed events to existing activity log
  with `{ email, ip }`. Useful for audit + future SIEM integration.
- **BR-0021:** Phase 2 (out of scope): persist tracker to Redis or
  DB for multi-process. Phase 1 in-memory is fine for single-process
  (Feature 0045 already documents the single-process assumption).

### Dockerfile USER (closes #8)

- **BR-0022:** Production `docker/Dockerfile`:
  - After multi-stage copy, add `RUN addgroup -S app && adduser -S
    app -G app`.
  - `RUN chown -R app:app /app /var/lib/zalo-crm/files`.
  - `USER app` before `CMD`.
- **BR-0023:** Tini stays as ENTRYPOINT — runs as app, not root.
- **BR-0024:** Verify the Node process can still bind to port 3000
  (non-privileged port, no root needed). Confirm uploads still write
  to `/var/lib/zalo-crm/files`.
- **BR-0025:** `docker/Dockerfile.dev` left as-is (dev container,
  not deployed to prod).

### Housekeeping

- **BR-0026:** Add `.gstack/` to `.gitignore`. Security reports
  shouldn't be committed.

## 4. Input / Output

### Schema migration

NO schema changes. The public API key hashing uses the existing
`value_plain` column transitionally.

### New / modified files

**Backend:**
- `backend/src/shared/crypto/assert-jwt-secret.ts` — NEW.
- `backend/src/shared/crypto/hash-api-key.ts` — NEW.
- `backend/src/shared/security/login-attempt-tracker.ts` — NEW.
- `backend/src/app.ts` — call `assertJwtSecret()` before listen.
- `backend/src/modules/api/public-api-routes.ts` — refactor
  `apiKeyAuth()` per BR-0014.
- `backend/src/modules/api/api-key-management-routes.ts` (or
  wherever key CRUD lives — find via grep `public_api_key`) — hash
  on write.
- `backend/src/modules/integrations/integration-routes.ts` —
  `timingSafeEqual` in `verifyOAuthState`.
- `backend/src/modules/auth/auth-routes.ts` — rate-limit check before
  login flow.
- `backend/src/modules/auth/auth-service.ts` — call tracker.
- `backend/src/config/index.ts` — delete unused `encryptionKey` field
  if confirmed unused.

**Infrastructure:**
- `docker/Dockerfile` — add USER, chown.
- `docker-compose.yml` — bind 127.0.0.1, drop defaults, nginx service.
- `nginx/nginx.conf` — NEW (proxy /attachments → MinIO).
- `.env.example` — drop MinIO defaults.

**Tests:**
- `backend/tests/unit/assert-jwt-secret.test.ts` — NEW.
- `backend/tests/unit/hash-api-key.test.ts` — NEW.
- `backend/tests/unit/login-attempt-tracker.test.ts` — NEW.
- `backend/tests/integration/public-api-key-migration.integration.test.ts` — NEW.
- `backend/tests/integration/login-rate-limit.integration.test.ts` — NEW.

**Docs:**
- `docs/operations/RUNBOOK.md` — add "Deploying Feature 0046"
  section with the migration checklist.
- `.gitignore` — `.gstack/` entry.

## 5. Edge Cases

- **EC-0001:** Existing deploy has `JWT_SECRET = 'dev-secret-change-me'`
  → app refuses to start after upgrade. Operator MUST set a new
  secret. Documented in RUNBOOK.
- **EC-0002:** Existing deploy has `JWT_SECRET` set to a real value
  → app starts normally; all old tokens stay valid.
- **EC-0003:** Hash migration: legacy plaintext API key looked up →
  matches → row updated to hash. Next lookup uses hash path. Both
  paths handled.
- **EC-0004:** Rate limiter: email "admin@example.com" gets 5
  failures, then operator pages a legit user → user types right
  password but gets 429. Operator can clear the tracker entry via a
  CLI command (out of scope phase 1; user just waits 15 min OR
  operator restarts the backend).
- **EC-0005:** MinIO existing deploy still binds 0.0.0.0:9000 →
  after upgrade, browser `<img src>` URLs pointing to the raw MinIO
  port break. Mitigation: RUNBOOK §0046 instructs operator to update
  `S3_PUBLIC_URL` to nginx path BEFORE rolling out the docker-compose
  change.
- **EC-0006:** Dockerfile USER: existing images rebuilt with USER app
  will fail if the volume `/var/lib/zalo-crm/files` is owned by
  uid 0. Mitigation: a one-off `chown -R app:app` in the entrypoint
  on first run, or document the operator step.
- **EC-0007:** Public API key migration: an attacker who already has
  a leaked plaintext key continues to work (they have the value).
  Mitigation: this feature doesn't claim retroactive protection —
  it stops NEW leaks. Operators should rotate keys after the feature
  ships if they suspect prior leak.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `npm audit --omit=dev` in `backend/` reports zero
      CRITICAL CVEs. Direct-dep HIGH CVEs reduced to acceptable list
      documented in PR body.
- [ ] **AC-0002:** `fast-jwt` installed version is `>6.1.0`.
- [ ] **AC-0003:** Production startup with unset `JWT_SECRET` fails
      with "JWT_SECRET must be set". Test: `NODE_ENV=production
      unset JWT_SECRET; node dist/app.js` → exit code 1, error logged.
- [ ] **AC-0004:** Production startup with `JWT_SECRET=dev-secret-change-me`
      fails with placeholder warning.
- [ ] **AC-0005:** Production startup with `JWT_SECRET` (random 32+
      chars) succeeds.
- [ ] **AC-0006:** Public API key created via management endpoint
      is stored hashed. `SELECT value_plain FROM app_settings WHERE
      setting_key='public_api_key'` returns a 64-char hex string.
- [ ] **AC-0007:** Existing plaintext public API key still works on
      first request after migration (legacy match path). After that
      request, the row is hashed.
- [ ] **AC-0008:** 6 failed logins for the same email in <15 min
      → 6th request returns 429 with `Retry-After` header.
- [ ] **AC-0009:** Successful login after 4 failures clears the
      tracker (5th failure resets the count).
- [ ] **AC-0010:** OAuth state with tampered signature → 400. Same
      behavior as before, but now via `timingSafeEqual`.
- [ ] **AC-0011:** `docker run zalo-crm` runs as UID != 0 (verify
      with `docker exec ... id`).
- [ ] **AC-0012:** MinIO bound to `127.0.0.1:9000` — `curl
      http://0.0.0.0:9000` from host fails; `curl http://localhost:9000`
      from inside the docker network succeeds.
- [ ] **AC-0013:** `docker-compose up` with unset `MINIO_ROOT_USER`
      fails (no silent default).
- [ ] **AC-0014:** nginx serves `/attachments/<key>` → MinIO bucket
      object. Browser `<img>` works through this path.
- [ ] **AC-0015:** `.gstack/` is in `.gitignore`.
- [ ] **AC-0016:** Build pass: BE tsc + FE vue-tsc + vite.
- [ ] **AC-0017:** All existing tests pass without modification.

## 7. Dependencies

- Touch points across many modules (auth, public-api, integrations,
  config, app boot).
- No external service dependencies added.
- nginx as new docker-compose service.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Dep upgrade (no code change, just package.json/lock) | ~0 |
| `assertJwtSecret` helper + boot wire | ~40 |
| Public API key hash + migration | ~80 |
| OAuth state timingSafeEqual | ~10 |
| Login rate limiter (tracker + integration) | ~120 |
| Dockerfile USER + chown | ~10 |
| docker-compose.yml updates + nginx.conf | ~50 |
| .env.example + .gitignore | ~10 |
| RUNBOOK section | ~80 markdown |
| Unit tests (3 helpers) | ~150 |
| Integration tests (2 new) | ~200 |
| **Total** | **~750 LOC** |

### Risk: MEDIUM

- **Dep upgrade may surface test failures.** Mitigation: incremental
  PR (chunk 1 upgrade-only first), don't combine with code refactors.
- **MinIO migration breaks active deployments.** Mitigation: RUNBOOK
  documents the sequence; offer a `--legacy-minio-bind` flag if
  needed (probably not).
- **JWT_SECRET rotation forces logout for everyone.** This is the
  desired behavior per the product call. Communicate via release notes.

### Test strategy

- Unit tests for each new helper (boot guard, hash, tracker).
- Integration tests: full login flow with rate limit, full public API
  key flow with hash + lazy migration.
- Manual smoke: deploy to staging with unset JWT_SECRET, confirm refusal.

### Why NOT delete `config.encryptionKey` in this PR

Grep confirmed `config.encryptionKey` has no active callsites (only
referenced in a comment in encrypt-config.ts explaining why a separate
helper was built). Deleting it is safe but is **out of scope for a
security PR** — keep this PR focused on the 8 findings. Schedule the
removal as a separate housekeeping commit.

### Migration sequence (operator-facing)

1. **Before deploy:**
   - Generate new `JWT_SECRET`: `openssl rand -base64 48`
   - Generate new `MINIO_ROOT_USER`: e.g. `zalocrm_minio_$(openssl rand -hex 4)`
   - Generate new `MINIO_ROOT_PASSWORD`: `openssl rand -base64 24`
   - Update `.env`. Verify `JWT_SECRET` is set, not the placeholder.
2. **Deploy** — boot guard catches misconfigs.
3. **All users re-authenticate.** Communicate via in-app banner.
4. **Optional:** rotate any active public API keys (existing ones
   still work via lazy migration, but rotation is good hygiene).

### Out of scope

- Persisting rate-limit tracker to Redis for multi-process (BR-0021).
- Deleting `config.encryptionKey` (separate housekeeping).
- Master-key rotation tooling — already shipped as Feature 0044.
- Multi-process worker locks — already shipped as Feature 0045.
- Master-key rotation for `JWT_SECRET` (forced re-login is the
  rotation strategy).
