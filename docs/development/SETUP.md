# Development setup

Get a working dev environment up in ~5 minutes.

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 20.x (LTS) | Backend + frontend runtime |
| npm | bundled with Node 20 | Package manager (project uses npm, not pnpm/yarn) |
| Docker | 24+ | Local Postgres + MinIO via docker-compose |
| Git | 2.40+ | — |

The CI workflow uses Node 20. Stay on the same major.

## Quick start

```bash
git clone git@github.com:cuongdaoviet/ZaloCRM.git
cd ZaloCRM

# Backend
cd backend
cp ../.env.example .env
# Fill in JWT_SECRET, DB_PASSWORD, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD,
# AI_CONFIG_MASTER_KEY (see Environment variables below).
npm install
npx prisma generate

# Bring up Postgres + MinIO via docker-compose (dev variant)
cd ..
docker compose -f docker-compose.dev.yml up -d db minio minio-init

# Push schema into the dev DB
cd backend
npx prisma db push --accept-data-loss --url "$DATABASE_URL"
npm run dev   # tsx watch — backend hot-reload on src/ changes

# In another terminal: frontend
cd ../frontend
npm install
npm run dev   # vite dev server, default http://localhost:5173
```

When `npm run dev` is happy, open `http://localhost:5173` and you should
see the login page. Run `npm run db:seed` in `backend/` for a seed
admin account (check `backend/prisma/seed.ts` for the credentials it
creates).

## Verifying the dev install

After `npm run dev` starts cleanly in both backend and frontend:

- [ ] `http://localhost:3000/health` returns `{"status":"ok","db":"connected"}`
- [ ] `http://localhost:5173` shows the login page
- [ ] `curl http://localhost:3000/api/v1/status` returns version banner
- [ ] Login with the seeded admin succeeds and lands on the dashboard

If anything is red, see `docs/operations/RUNBOOK.md` §5 "Common errors".

<!-- AUTO-GENERATED — regenerated from package.json + .env.example -->
<!-- Do not hand-edit the tables below. Re-run /update-docs to refresh. -->

## Scripts reference (backend)

Run from `backend/`.

| Command | Description |
|---|---|
| `npm run dev` | Start the Fastify server with `tsx watch` — hot reloads on `src/` changes. Default port 3000. |
| `npm run build` | Compile TypeScript via `tsc`. Output to `dist/`. Run before `npm start` for production. |
| `npm start` | Run the compiled server (`node dist/app.js`). Requires `npm run build` first. |
| `npm run db:migrate` | `prisma migrate dev` — create a new migration from schema changes (dev only). |
| `npm run db:push` | `prisma db push` — sync schema to DB without creating a migration file (dev). |
| `npm run db:seed` | `tsx prisma/seed.ts` — seed the database with initial data (admin user, demo org). |
| `npm run db:studio` | Open Prisma Studio in the browser for DB inspection. |
| `npm test` | Run all tests (unit + integration) with Vitest. |
| `npm run test:unit` | Run unit tests only (`--project unit`). Fast — no DB. |
| `npm run test:integration` | Run integration tests (`--project integration`). Boots testcontainers Postgres. |
| `npm run test:watch` | Run tests in watch mode. |
| `npm run test:coverage` | Run tests with V8 coverage report. |
| `npm run rotate-master-key` | Re-encrypt every row using the current `AI_CONFIG_MASTER_KEY`. See `docs/operations/RUNBOOK.md` §10. Feature 0044. |
| `npm run migrate-encrypt-proxy-url` | One-off backfill: encrypt existing plaintext `ZaloAccount.proxyUrl` values. Runs once during 0044 rollout. |

## Scripts reference (frontend)

Run from `frontend/`.

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite dev server (default port 5173). |
| `npm run build` | Type-check via `vue-tsc -b` then build with `vite build`. Output to `dist/`. |
| `npm run preview` | Preview the production build locally. |
| `npm test` | Run all frontend tests with Vitest. |
| `npm run test:watch` | Run tests in watch mode. |
| `npm run test:coverage` | Run tests with V8 coverage. |

## Environment variables — deploy-level (root `.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | App port (default `3000`). |
| `NODE_ENV` | no | `production` / `development` / `test`. Drives boot guards and CORS. |
| `APP_URL` | yes (prod) | Canonical app URL for CORS allow-origin. |
| `JWT_SECRET` | **yes (prod)** | HMAC secret for JWT signing. **Feature 0046 BR-0004**: boot fails in production when unset, equals the dev placeholder, or is shorter than 32 chars. Generate: `openssl rand -base64 48`. |
| `ENCRYPTION_KEY` | legacy | Legacy 16-byte AES key. Currently unused (replaced by `AI_CONFIG_MASTER_KEY` per Feature 0044). Kept for backward compat; will be removed. |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | yes | Postgres credentials. Used by `docker-compose.yml`. |
| `DATABASE_URL` | yes | Postgres connection string. Format: `postgresql://user:pass@host:5432/db`. |
| `UPLOAD_DIR` | no | Local filesystem path for uploaded attachments before MinIO mirror. Default `/var/lib/zalo-crm/files`. |
| `MINIO_ROOT_USER` | **yes (prod)** | MinIO admin user. **Feature 0046 BR-0010**: docker-compose now refuses to start when unset (was `minioadmin` default). Generate: `zalocrm_minio_$(openssl rand -hex 4)`. |
| `MINIO_ROOT_PASSWORD` | **yes (prod)** | MinIO admin password. Same requirement. Generate: `openssl rand -base64 24`. |
| `S3_ENDPOINT` | no | Internal URL backend uses to reach MinIO. Default `http://minio:9000` (docker DNS name). |
| `S3_PUBLIC_URL` | yes (prod) | URL the browser uses for `<img src>` of chat attachments. After Feature 0046, points at nginx proxy: `https://your-domain.com/attachments`. |
| `S3_BUCKET` | no | Bucket name for attachments (default `zalocrm-attachments`). |
| `S3_ACCESS_KEY` | yes (prod) | MinIO S3 access key. Same value as `MINIO_ROOT_USER` by default. |
| `S3_SECRET_KEY` | yes (prod) | MinIO S3 secret key. Same value as `MINIO_ROOT_PASSWORD` by default. |
| `S3_REGION` | no | Region label MinIO returns in pre-signed URLs (default `us-east-1`). |
| `FRIEND_ACTIVE_WINDOW_DAYS` | no | Days window for `GET /api/v1/friends/stats` "active chat" count (default `7`). Feature 0033. |
| `MINIO_ENABLED` | no | `false` to opt out of MinIO mirror; outbound attachments use Zalo CDN fallback. Default `true`. Feature 0032. |

## Environment variables — backend-only (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `AI_CONFIG_MASTER_KEY` | **yes (prod)** | 32-byte hex master key (64 chars) for AES-256-GCM at-rest encryption. Protects: AI provider API keys (Feature 0036), Integration Hub configs (Feature 0038), per-account proxy URLs (Feature 0044). **Boot guard refuses production startup when unset or equals the zero placeholder.** Generate: `openssl rand -hex 32`. **Losing this key = losing every BYOK key + OAuth refresh token + Telegram bot token.** Back up via secrets manager. |
| `AI_CONFIG_MASTER_KEY_PREVIOUS` | no | Optional. Holds the OLD key during a rotation window. Decrypt path falls back to this when the current key fails. Encrypt path always uses `AI_CONFIG_MASTER_KEY`. **Must differ** from the current key (boot guard refuses identical values). Remove after `npm run rotate-master-key` completes. See RUNBOOK §10. Feature 0044. |
| `GOOGLE_OAUTH_CLIENT_ID` | yes (if Sheets integration) | OAuth 2.0 client ID for the Google Sheets connector. Create at https://console.cloud.google.com/apis/credentials with scope `https://www.googleapis.com/auth/spreadsheets`. Feature 0038. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes (if Sheets integration) | OAuth 2.0 client secret. Pair with the client ID above. |
| `GOOGLE_OAUTH_REDIRECT_URI` | yes (if Sheets integration) | Must match one of the "Authorised redirect URIs" entries in the same OAuth client. Format: `https://your-domain.com/api/v1/integrations/oauth/google/callback`. |

<!-- /AUTO-GENERATED -->

## Local Postgres + MinIO

`docker-compose.dev.yml` brings up:

- `db` — `postgres:16-alpine`, port `5432` (mapped to `127.0.0.1:5434` on host so it doesn't clash with any system Postgres).
- `minio` + `minio-init` — object storage for chat attachments. Port `9000` (API) and `9001` (console). Default bucket: `zalocrm-attachments`, anonymous-read.

If `docker compose up` fails with `bind: address already in use`, see RUNBOOK §5.

## Running tests

```bash
cd backend

# Fast unit tests, no DB
npm run test:unit

# Integration tests — boots testcontainers Postgres, ~30-60s startup
npm run test:integration

# Everything (~2 min total)
npm test

# Watch a specific test file while developing
npm run test:watch -- tests/integration/conversation-filters.integration.test.ts
```

Frontend tests are component-level via `@vue/test-utils`:

```bash
cd frontend
npm test
```

CI runs the full test matrix on every PR. See `docs/operations/CI-CD.md`.

## Common gotchas

- **Prisma client out of date**: after pulling new schema changes, run `npx prisma generate` in `backend/`.
- **`AI_CONFIG_MASTER_KEY` missing in dev**: the boot guard accepts the placeholder in non-production. Just set `NODE_ENV=development` (or leave it unset — `config.isProduction` is false then).
- **CORS errors in dev**: backend defaults to allowing all origins when `NODE_ENV !== production`.
- **Vite proxies `/api/*` to backend**: configured in `frontend/vite.config.ts`. If you change the backend port, update the proxy target.

## Next steps

- Read `docs/development/CONTRIBUTING.md` for the PR checklist + coding standards.
- Pick a feature SPEC from `docs/features/` to understand the architecture by example.
- Browse `docs/design/API.md` for the full endpoint reference.
