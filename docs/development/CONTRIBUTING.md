# Contributing to ZaloCRM

Workflow conventions, coding standards, and the PR checklist.

For first-time setup, read `docs/development/SETUP.md` first.

## Workflow at a glance

1. **Find or create a feature SPEC** in `docs/features/<NNNN-name>/SPEC.md`.
   - Existing pattern: every shipped feature has a SPEC. New work follows
     the same template (sections 1–8, with §3 Business Rules, §6 ACs).
   - Trivial bug fixes can skip the SPEC if the diff < ~50 LOC.
2. **Create a feature branch** from `main`: `feature/<NNNN-name>`.
3. **Implement + tests in the same PR.** 80%+ coverage target on new code.
4. **Open the PR.** CI must be green before merge.
5. **Squash-merge** to `main`. Branch auto-deletes.

The repo uses the SPEC-first workflow that established this codebase —
see `AGENTS.md` at repo root and the `docs/features/README.md` index for
the conventions baked in over the past cycles.

## Branch + commit conventions

| Type | Branch prefix | Commit prefix |
|---|---|---|
| New feature | `feature/<NNNN-name>` | `feat:` or `feat(<NNNN>): ` |
| Bug fix | `bugfix/<short-desc>` or `fix/<short-desc>` | `fix:` |
| Refactor | `refactor/<short-desc>` | `refactor:` |
| Docs only | `docs/<short-desc>` | `docs:` |
| Chore (deps, CI) | `chore/<short-desc>` | `chore:` |
| Hotfix | `hotfix/<short-desc>` | `fix:` |

**Commit message format** (the repo uses Conventional Commits loosely):

```
<type>(<scope optional>): <imperative subject line, ~70 chars>

<body — 1-3 paragraphs explaining WHY, not WHAT. The diff shows what.>

Co-Authored-By: ...  (only when actually co-authored)
```

Avoid:
- Trailing periods in subject lines.
- Em-dashes (` — `) in subjects (body is fine).
- Multi-line subjects.

## PR checklist

Before requesting review:

- [ ] Linked the feature SPEC (or filed `docs/features/<NNNN>/SPEC.md`
      if this is a new feature).
- [ ] Backend tests added or updated; `npm test` passes locally.
- [ ] Frontend changes have at least one unit test for new composables /
      utility logic; component tests for non-trivial UI.
- [ ] `npm run build` passes in `backend/` (tsc clean) and `frontend/`
      (`vue-tsc -b && vite build` clean).
- [ ] No new secrets committed. `.env*` files stay gitignored.
- [ ] If touching crypto (`encrypt-config.ts`, helpers in
      `backend/src/shared/crypto/`): explicit unit tests + reviewer
      tagged.
- [ ] If touching `docker-compose.yml`, `Dockerfile`, `nginx/`, or
      auth (`auth-routes.ts`, `auth-service.ts`, JWT verify hooks):
      explain operator-facing changes in the PR body and update
      `docs/operations/RUNBOOK.md` if the deploy steps change.
- [ ] If adding a new env variable: added to `.env.example` (deploy)
      and/or `backend/.env.example` with a comment explaining purpose,
      default, and which feature owns it. Also added to
      `docs/development/SETUP.md` env tables.
- [ ] If adding a new endpoint: added to `docs/design/API.md` under the
      appropriate feature section.

## Coding standards

### TypeScript (backend)

- ESM modules. `import './foo.js'` (the `.js` extension is required by
  Node's ESM resolver even though the source is `.ts`).
- `strict: true` in `tsconfig.json`. No `any` unless commented.
- Prisma is the data layer. Raw SQL only through `$queryRaw` tagged
  templates (never `$queryRawUnsafe`). See `backend/src/workers/`
  for the `FOR UPDATE SKIP LOCKED` pattern (Feature 0045).
- Fastify route handlers: type the body / params / querystring via
  Fastify's generic. Return value is the response body; don't call
  `reply.send` unless you need a non-default status code.
- Error handling: throw `Error` instances with a `statusCode` property
  for HTTP errors. The global handler in `app.ts` formats the response.
- Logging: use the shared `logger` in `backend/src/shared/utils/`. Never
  log raw secrets, JWT bodies, or full API keys — see `maskApiKey()` and
  `maskSecret()` helpers in `backend/src/shared/crypto/encrypt-config.ts`.

### Vue 3 (frontend)

- Composition API only. Avoid Options API in new components.
- Vuetify 4 + the Smax theme tokens (PR #32 + Feature 0042). Use
  existing tokens before adding new ones.
- No `v-html` unless the content is from a trusted source AND
  reviewer-tagged. Default to template interpolation `{{ }}` which
  Vue escapes automatically.
- Use existing composables (`use-chat.ts`, `use-contacts.ts`, etc.)
  rather than inlining state in components.
- Pinia for cross-component state (auth, theme). Composables for
  feature-local state.
- Real DOM tests with `@vue/test-utils` + Vitest.

### Prisma schema

- New models go at the end of `backend/prisma/schema.prisma` in their
  feature block (see existing layout — features grouped by ID with
  comment markers).
- Always set `@map("snake_case_name")` on field + `@@map("table_name")`
  on model.
- Indexes: think about the hot path. Use `@@index([orgId, ...])` —
  multi-tenant: always lead with `orgId`.
- For raw SQL queries via `$queryRaw`, declare a TypeScript row
  interface and a snake_case-to-camelCase mapper. Don't `SELECT *` —
  list columns explicitly so the type stays stable.

## Testing

### What to test

- **Business logic** in services / helpers: unit tests, mocked Prisma
  via `vitest-mock-extended` or testcontainers Postgres for integration.
- **Routes**: integration tests against a real testcontainers Postgres.
  Existing pattern in `backend/tests/integration/*.integration.test.ts`.
- **Frontend composables**: unit tests. Mock `@/api/index` with
  `vi.hoisted()` (see precedent in `use-integrations.test.ts`).
- **Frontend components**: real `mount()` from `@vue/test-utils` with
  Vuetify globals stubbed where they get in the way.

### What NOT to test

- Generated code (Prisma client, Vuetify internals).
- Third-party library behavior — we test our usage, not their
  implementation.
- Visual regressions via screenshots (we don't have a viz framework set
  up). Document a manual smoke checklist instead.

### Test commands

See `docs/development/SETUP.md` for the full scripts reference. Quick
reminder:

```bash
cd backend
npm run test:unit              # fast, no DB
npm run test:integration       # with testcontainers Postgres
npm test                       # both
```

## Database migrations

For schema changes:

1. Edit `backend/prisma/schema.prisma`.
2. Local dev: `npx prisma db push --accept-data-loss` (no migration
   file).
3. For staged migrations, `npx prisma migrate dev --name <short-desc>`
   creates a file under `backend/prisma/migrations/`.
4. **Destructive migrations** (column drops, table renames) MUST be
   reviewed by a second contributor. Document in the PR body and add
   a section to RUNBOOK §9 if the deploy needs a manual step.

## Security guidelines

The 2026-05 CSO audit + Feature 0046 set baseline expectations:

- **Never hardcode secrets.** Env vars only. `.env*` is gitignored.
- **All secrets at rest are encrypted** via `encrypt-config.ts`
  (AES-256-GCM + HKDF-derived per-org key). New features storing
  credentials must use `encryptForOrg`/`decryptForOrg` or the
  `encryptConfig`/`decryptConfig` shim.
- **Constant-time compares** for HMAC + token lookups: use
  `crypto.timingSafeEqual`, not `!==`.
- **No `v-html` on user content.**
- **No new wildcards in CI workflows.** Pin third-party actions to SHA;
  first-party `actions/*` may use `@v4` tags.
- **No `Bash(*)` allow rules** in Claude Code permissions. Run
  `/security-scan` locally before committing config changes.

When in doubt, run `/cso` for a security pass; ~5-minute audit.

## Release / deploy

See `docs/operations/RUNBOOK.md` for the deploy procedure and
`docs/operations/2026-cycle-hardening.md` for the pre-release manual
QA checklist.

Hot fixes go on `hotfix/<short>` branches off `main`, merge with squash,
and trigger a redeploy through the normal CI flow.

## Getting unstuck

- Read the relevant feature SPEC under `docs/features/`.
- Check `docs/operations/RUNBOOK.md` §5 "Common errors" for known
  deploy/dev gotchas.
- The `AGENTS.md` at repo root documents the AI-assisted workflow
  conventions used in this codebase — useful even if you're not using
  an AI agent yourself.
