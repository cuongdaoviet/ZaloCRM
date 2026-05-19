# CI/CD

## Workflow hiện tại

| File | Trigger | Jobs | Thời gian ước tính |
|------|---------|------|---------------------|
| `.github/workflows/ci.yml` | Mọi PR vào `main` + push vào `main` | Backend (build + test) + Frontend (type-check + build) | ~3–5 phút |

### Backend job
1. Setup Node 20 + cache npm
2. `npm ci` (dùng `package-lock.json` của backend)
3. `npx prisma generate`
4. `npx prisma db push --url $DATABASE_URL` (đẩy schema vào Postgres service container)
5. `npm run build` (tsc — type-check + compile)
6. `npm run test:unit` (Vitest, mocked Prisma, ~250ms)
7. `npm run test:integration` (Vitest + Postgres service, `USE_CI_DB=1`, ~9s)

### Frontend job
1. Setup Node 20 + cache npm
2. `npm ci` (lock của frontend)
3. `npm run build` (vue-tsc + vite — type-check và bundle)

### Postgres service container
Workflow dùng GitHub Actions service container (`postgres:16-alpine`) thay vì testcontainers — đơn giản hơn, không cần docker-in-docker. Code test (`tests/integration/setup-db.ts`) tự detect `USE_CI_DB=1` và bỏ qua testcontainers, dùng `DATABASE_URL` có sẵn.

## Branch protection cho `main`

> ✅ **Đã áp dụng** (2026-05-19). Cấu hình hiện tại: **0 approval** (solo dev mode — GitHub chặn author self-approve PR của mình) + 2 status checks (Backend, Frontend) + strict (branch phải up-to-date trước khi merge) + conversation resolution required + enforce trên cả admin + cấm force-push + cấm delete branch.
>
> Khi có thêm reviewer khác trong team, tăng `required_approving_review_count` lên 1 qua `gh api PUT` (xem snippet bên dưới).

Push trực tiếp vào `main` → GitHub reject với "Changes must be made through a pull request". Test verified.

### Khi cần thay đổi rule

GitHub Actions chỉ verify code; branch protection chặn merge nếu CI fail hoặc thiếu review. Có 2 cách điều chỉnh:

### Cách 1 — UI (đơn giản)

1. Vào `Settings` → `Branches` của repo
2. **Add branch protection rule** → Branch name pattern: `main`
3. Bật các option:
   - ✅ **Require a pull request before merging** → Required approving reviews: **0** (solo dev) hoặc **1** (có reviewer khác)
   - ✅ **Require status checks to pass before merging**
     - ✅ Require branches to be up to date before merging
     - Status checks: search "Backend (lint, build, test)" và "Frontend (type-check, build)" → tick cả 2
   - ✅ **Require conversation resolution before merging**
   - ✅ **Do not allow bypassing the above settings** (cả admin cũng phải tuân)
4. Save changes

### Cách 2 — `gh` CLI

```bash
gh api -X PUT "repos/cuongdaoviet/ZaloCRM/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Backend (lint, build, test)",
      "Frontend (type-check, build)"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

> ⚠️ **Lưu ý:** chỉ chạy được sau khi CI workflow đã chạy **ít nhất 1 lần** trên một PR — vì status check names ("Backend (lint, build, test)" và "Frontend (type-check, build)") chỉ được GitHub register sau lần chạy đầu.

### Inspect current protection state

```bash
gh api repos/cuongdaoviet/ZaloCRM/branches/main/protection
```

### Disable protection (emergency only)

```bash
gh api -X DELETE repos/cuongdaoviet/ZaloCRM/branches/main/protection
```

Sau khi disable, **luôn re-enable** ngay khi xử lý xong incident.

## Khi CI fail

| Symptom | Có thể là | Debug |
|---------|-----------|-------|
| Job "Backend" fail ở step `db push` | Schema syntax lỗi hoặc Postgres chưa healthy | Xem log step `Push schema to test DB` |
| `test:integration` fail | Logic regression hoặc DB chưa reset đúng giữa các test file | Chạy local: `npm run test:integration` |
| Job "Frontend" fail ở `npm run build` | Type error (vue-tsc) hoặc Vite bundle error | Chạy local: `cd frontend && npm run build` |
| Cả 2 job fail ở `npm ci` | `package-lock.json` không sync với `package.json` | Chạy `npm install` local, commit lại lockfile |

## Mở rộng sau này

Khi cần thêm:
- **Docker image build + push GHCR:** thêm job mới với `permissions: packages: write`, dùng `docker/build-push-action@v5`
- **Auto-deploy staging:** workflow riêng `deploy-staging.yml` trigger trên push vào `main`
- **Frontend tests:** khi viết Vitest cho Vue components, thêm step `npm run test` vào job frontend
- **Lint:** thêm `npm run lint` step nếu cài ESLint/Prettier
