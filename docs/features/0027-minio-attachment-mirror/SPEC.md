# Feature 0027: MinIO/S3 attachment mirror

## 1. Mô tả

Hôm nay khi rep gửi ảnh/file qua composer, ta forward thẳng buffer cho zca-js
→ Zalo upload lên CDN của họ → ta lưu `Message.content` là Zalo CDN URL.
**Không có bản sao nào ở server CRM.** Hậu quả: Zalo xoay URL hoặc CDN của
họ hết hạn → file biến mất khỏi CRM, không xem lại được, không search nội
dung được, không audit được.

Tương tự với inbound: KH gửi ảnh, ta lưu URL Zalo trả về. Cùng vấn đề.

Feature này thêm MinIO làm object storage:

- **Outbound flow:** rep upload file → ta save MinIO trước → call zca-js
  với local-path → persist `Message.content` là **MinIO URL** (không phải
  Zalo CDN).
- **Inbound flow:** message handler nhận message từ KH có attachment URL
  → download từ Zalo CDN → re-upload to MinIO → persist message với MinIO
  URL.

Cả hai chiều, CRM giữ bản sao của mọi file đi qua hệ thống.

## 2. User Stories

- **US-0027-1:** Là Sale, 6 tháng sau khi gửi/nhận một file PDF, tôi mở
  lại Customer 360 và file vẫn xem được — không bị 404.
- **US-0027-2:** Là Admin, tôi xem dashboard "đã tiêu bao nhiêu storage"
  để biết cần nâng disk hay archive.
- **US-0027-3:** Là Compliance officer, tôi cần xuất tất cả file trao đổi
  với 1 contact theo yêu cầu pháp lý — tất cả nằm trong MinIO bucket, dễ
  xuất.
- **US-0027-4:** Là Dev/Ops, tôi muốn deploy MinIO khi `docker compose up`
  — không cần cấu hình thủ công bucket.

## 3. Business Rules

### Storage layer

- **BR-0001:** Object key format: `YYYY-MM-DD/<uuid><ext>`. Date prefix
  giúp navigate bucket bằng `mc ls` khi cần debug.
- **BR-0002:** Bucket: `zalocrm-attachments` (env-overridable
  `S3_BUCKET`). Anonymous-download permission (file accessible qua URL
  không cần auth). Lý do: `<video>` / `<img>` tag không gửi được auth
  header.
- **BR-0003:** MIME-derived file extension nếu original filename không
  có ext. Standard mapping cho image/jpeg → .jpg, video/mp4 → .mp4, etc.

### Outbound (rep gửi)

- **BR-0004:** `POST /api/v1/conversations/:id/attachments` flow:
  1. Validate file (MIME allowlist + 20MB cap — đã có).
  2. Save buffer to tmp file (zca-js cần path, không nhận buffer cho
     video).
  3. Upload buffer to MinIO via `uploadBuffer()` → get `UploadResult`.
  4. Call zca-js `sendImage(localPath, dest)` / `sendVideo` / `sendFile`.
  5. Delete tmp file (`fs.unlink`, swallow errors).
  6. Persist `Message` row với `content` là **MinIO URL** (không phải
     Zalo trả về).
- **BR-0005:** Nếu MinIO upload fail → trả 502 `storage_failed`. Không
  call Zalo (avoid orphan-on-Zalo).
- **BR-0006:** Nếu zca-js fail sau khi MinIO upload đã thành công → giữ
  MinIO object (sẽ được dùng cho retry hoặc xoá thủ công). Trả 502
  `zalo_send_failed`. Persist KHÔNG Message row.

### Inbound (KH gửi)

- **BR-0007:** Inbound message handler khi gặp message có attachment URL
  (`contentType in ['image','video','file']` và `content` chứa URL Zalo):
  1. Download buffer từ Zalo CDN (timeout 10s, max 20MB).
  2. Upload buffer to MinIO.
  3. Update Message với MinIO URL trong `content` field.
  - Fail download/upload → giữ Zalo URL gốc, log warn. Inbound message
    vẫn được persist (BR-0008 không block khi mirror fail).
- **BR-0008:** Inbound mirror là **best-effort**. Mục tiêu chính là KH có
  gửi message vào → ta lưu được message. Việc mirror file là nice-to-have
  cho long-term retention. Fail mirror KHÔNG bỏ message.

### Configuration

- **BR-0009:** Env vars (defaults `'minioadmin'` chỉ cho dev — prod phải
  override):
  - `S3_ENDPOINT` (default `http://minio:9000` — internal docker DNS)
  - `S3_PUBLIC_URL` (default `http://localhost:9000` — what browsers see)
  - `S3_BUCKET` (default `zalocrm-attachments`)
  - `S3_ACCESS_KEY` (default `minioadmin`)
  - `S3_SECRET_KEY` (default `minioadmin`)
  - `S3_REGION` (default `us-east-1`)
- **BR-0010:** Backend startup calls `ensureBucket()` once — idempotent
  `bucketExists` check + `makeBucket` if missing. Same pattern as Prisma
  `db push` on container start.

### Retention

- **BR-0011:** Phase 1: **không có retention policy**. Files stay
  forever. Admin có thể xoá bucket thủ công nếu hết disk. Phase 2 sẽ
  thêm "archive after N days idle" với storage class lifecycle rules.
- **BR-0012:** Khi `Message` row bị xoá cứng (rare — chỉ xảy ra qua
  Phase C của Feature 0018 contact merge), object MinIO **KHÔNG** bị
  xoá. Lý do: orphan objects rẻ; ngược lại nếu delete sai → file mất
  vĩnh viễn. Phase 2 có thể thêm sweep job.

## 4. Input / Output

### Schema

**Không thay đổi.** `Message.content` vẫn là `String?` chứa URL hoặc JSON
metadata. Phase 1 chỉ đổi NỘI DUNG của field này (URL trỏ MinIO thay vì
Zalo), không đổi shape.

### New files

```
backend/src/shared/storage/
  minio-client.ts          # ~68 LOC wrapper
  download-mirror.ts       # ~50 LOC helper for inbound: fetch + re-upload

backend/src/config/index.ts  # add s3Endpoint, s3PublicUrl, s3Bucket, s3AccessKey, s3SecretKey, s3Region

backend/package.json         # add "minio" dep

docker-compose.yml           # add minio + minio-init services + minio_data volume
docker-compose.dev.yml       # same additions

.env.example                 # add MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, S3_BUCKET, etc.
```

### Modified files

```
backend/src/modules/chat/chat-routes.ts (or chat-attachment-routes.ts if extracted)
  — outbound POST /conversations/:id/attachments rewrite
backend/src/app.ts
  — call ensureBucket() at startup
backend/src/modules/zalo/zalo-message-handler.ts (or wherever inbound msgs persist)
  — call mirrorAttachment() for image/video/file inbound
```

### Endpoints

No new endpoints. Existing `POST /api/v1/conversations/:id/attachments`
unchanged contract — body, validation, response shape stay the same.
Only the URL in the returned Message points to MinIO now.

## 5. Edge Cases

- **EC-0001:** MinIO down at container start → `ensureBucket()` throws.
  App crashes on startup. Acceptable (better than silent "uploads work but
  vanish"). Healthcheck on minio container handles ordering via `depends_on:
  service_healthy`.
- **EC-0002:** Bucket exists but with wrong permissions → `mc anonymous
  set download` in `minio-init` is idempotent, re-runs OK on every
  startup.
- **EC-0003:** Inbound Zalo CDN URL is empty / malformed → skip mirror,
  keep URL as-is. Message persists normally.
- **EC-0004:** Inbound download exceeds 20MB → abort fetch, skip mirror,
  log warn with size + URL. Message persists with original URL.
- **EC-0005:** Tmp file write fails (disk full) → 500 with cleanup of
  partial state. Caller retries.
- **EC-0006:** MinIO upload succeeds but zca-js call throws → we have an
  orphan object in MinIO. Acceptable cost (cheap storage). Document in
  RUNBOOK.
- **EC-0007:** Two reps upload same file content in same second → 2
  distinct UUIDs → 2 distinct keys. No dedup. Acceptable for v1.

## 6. Acceptance Criteria

- [ ] **AC-0001:** `docker compose up` brings up `minio` + `minio-init`
      containers; bucket `zalocrm-attachments` exists after init.
- [ ] **AC-0002:** Backend startup logs `[minio] bucket
      zalocrm-attachments ready`.
- [ ] **AC-0003:** POST `/conversations/:id/attachments` with valid
      image → 201 + Message row with `content` = `http(s)://<S3_PUBLIC_URL>/
      zalocrm-attachments/<date>/<uuid>.jpg`.
- [ ] **AC-0004:** GET the returned URL via curl → 200 image bytes.
- [ ] **AC-0005:** MinIO upload throws → 502 `storage_failed`, NO zca-js
      call, NO Message row.
- [ ] **AC-0006:** zca-js throws after MinIO succeeds → 502
      `zalo_send_failed`, MinIO object orphans (acceptable), NO Message
      row.
- [ ] **AC-0007:** Inbound message handler receives a `image` message
      with Zalo CDN URL → Message row persists with MinIO URL (not Zalo
      URL).
- [ ] **AC-0008:** Inbound mirror download fails → Message still
      persists with original Zalo URL (best-effort).
- [ ] **AC-0009:** Build pass: BE tsc + FE vue-tsc + vite (no FE changes
      expected — sanity check).
- [ ] **AC-0010:** Existing 694/694 backend tests still pass (mock
      MinIO client in tests).

## 7. Dependencies

- **New npm dep:** `minio` (official MinIO SDK).
- **New env vars** — backwards-compat: default values for dev so devs
  can `docker compose up` without setting anything.
- **Touches Feature 0023's inbound message handler** if 0023 lands the
  auto-promote logic there. Manageable rebase — different code paths
  (0023: update `tab` field; 0027: download/re-upload attachment).
- **Existing `MIME` allowlist** in chat-attachment route — no changes.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| `minio-client.ts` wrapper | ~68 |
| `download-mirror.ts` helper for inbound | ~50 |
| `config/index.ts` env additions | ~10 |
| `app.ts` ensureBucket() call | ~5 |
| Outbound flow rewrite (`chat-routes.ts` attachments route) | ~120 |
| Inbound mirror in message handler | ~30 |
| docker-compose changes (yml + dev yml + .env.example) | ~60 |
| **Backend tests (integration)** | ~250 |
| **package.json** | 1 line |
| **Total** | **~600 LOC** |

### Risk: MEDIUM

- **Storage-layer infra:** new container, new env vars, new disk volume.
  First deploy after this PR requires `docker compose up -d --build`
  (the existing `prisma db push` pattern handles schema, but new
  service requires explicit re-compose).
- **Orphan objects:** MinIO storage can grow uncapped. Phase 2 needs a
  sweep / retention policy (logged as Out of Scope).
- **Inbound mirror is async** — if it lags behind message ingest, FE
  sees Zalo URL initially, then it switches to MinIO. Acceptable; FE
  doesn't care which URL it gets.

### Test strategy

- Mock `minioClient.putObject` in integration tests — return a fake
  `UploadResult`. Don't spin up real MinIO in tests.
- Outbound: assert Message.content is the mocked MinIO URL, not the
  Zalo URL.
- Inbound: mock `fetch` for the Zalo CDN download. Assert mirror
  attempt + final Message.content.
- Fail cases: assert correct status codes + that side-effects don't
  happen (no Message on storage_failed, etc.).

### Deviations from ZaloCRM-3.0

None material. We're porting their 3.0 implementation:
- Same `minio-client.ts` wrapper (`uploadBuffer`, `ensureBucket`).
- Same docker-compose structure (minio + minio-init).
- Same env-var names.
- **One addition** (also documented in BR-0007/0008): explicit
  inbound mirror. 3.0's code shows the wrapper + outbound rewrite —
  we extend inbound symmetrically. Document this as our extension.

### Out of scope (Phase 2 candidates)

- Retention policy / lifecycle rules.
- Orphan-object sweep job (when Message row deleted via merge etc.).
- CDN in front of MinIO for global distribution.
- Per-org bucket prefix (today everyone shares one bucket).
- File dedup (sha256 of content + reuse existing object).
- Signed URLs (today everything is public-read).
- Storage usage dashboard for admins.
- Backfill: re-upload existing Zalo CDN URLs in old messages to MinIO.

### Deployment notes

After merge:
1. `docker compose down` to stop existing services.
2. `docker compose up -d --build` brings up minio + minio-init.
3. First startup: minio-init creates bucket + sets anonymous-read.
4. `app` startup logs `[minio] bucket ... ready`.
5. Verify: send a test attachment from CRM → URL in DB should match
   `$S3_PUBLIC_URL/$S3_BUCKET/...` pattern.
6. Update `.env` on production server with real `MINIO_ROOT_PASSWORD`
   + `S3_PUBLIC_URL` (production reverse-proxy domain).
