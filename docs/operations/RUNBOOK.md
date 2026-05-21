# RUNBOOK — Vận hành ZaloCRM

Cheat sheet cho on-call: deploy, backup, recover, troubleshoot. Dành cho người đã đọc [HUONG-DAN-CAI-DAT.md](../../HUONG-DAN-CAI-DAT.md).

## 1. Cấu trúc deploy

```
host
├── docker-compose.yml         # prod
├── docker-compose.dev.yml     # dev (hot-reload)
├── .env                        # secrets — KHÔNG commit
└── backups/                    # postgres dump hàng ngày (volume mount)
    └── daily/                  # tự sinh bởi container `backup`
```

3 containers chạy song song:
| Container | Image | Port host | Purpose |
|-----------|-------|-----------|---------|
| `zalo-crm-app` | build từ `docker/Dockerfile` | 3080 | API + FE |
| `zalo-crm-db` | `postgres:16-alpine` | 5434 (loopback) | Database |
| `zalo-crm-backup` | `prodrigestivill/postgres-backup-local` | — | Daily dump |

## 2. Lệnh thường dùng

```bash
# Xem trạng thái + log
docker compose ps
docker compose logs -f app
docker compose logs -f db

# Restart 1 service
docker compose restart app

# Rebuild khi có code mới
git pull
docker compose up -d --build app

# Vào shell trong container
docker exec -it zalo-crm-app sh
docker exec -it zalo-crm-db psql -U crmuser zalocrm

# Stop / start toàn bộ
docker compose down
docker compose up -d
```

## 3. Deploy code mới

> Branch protection trên `main` đảm bảo mọi code đã pass CI trước khi merge. Sau khi merge:

```bash
# Trên server
cd /path/to/ZaloCRM
git pull origin main
docker compose up -d --build app    # rebuild + restart (FE + BE)
docker compose logs -f app          # tail log 1-2 phút để verify
```

Smoke check sau deploy:
1. `curl https://your-domain/health` → `{"status":"ok","db":"connected",...}`
2. Mở app trên browser → đăng nhập → check 1 cuộc trò chuyện hiển thị bình thường
3. Verify Zalo account `lastConnectedAt` trong DB cập nhật trong 30s (tự reconnect)

> 💡 Nếu thay đổi schema (PR có file `prisma/schema.prisma` modified), thêm bước `docker compose exec app npx prisma db push` trước khi log tail. Container `app` đã chạy `db push` ở entrypoint, nhưng explicit hơn an toàn hơn.

## 4. Backup & restore database

### Backup tự động

Container `zalo-crm-backup` (image `prodrigestivill/postgres-backup-local`) chạy 1 lần/ngày → ghi file `.sql.gz` vào volume `./backups/`. Retention mặc định: 7 daily + 4 weekly + 3 monthly.

```bash
ls -la ./backups/daily/      # daily snapshots
ls -la ./backups/weekly/
ls -la ./backups/monthly/
```

### Backup thủ công (ngay lập tức)

```bash
docker exec zalo-crm-db pg_dump -U crmuser zalocrm | gzip > ./backups/manual-$(date +%Y%m%d-%H%M%S).sql.gz
```

### Restore từ backup

```bash
# Stop app để không có connection mới
docker compose stop app

# Drop + recreate database
docker exec -it zalo-crm-db psql -U crmuser -d postgres -c "DROP DATABASE zalocrm;"
docker exec -it zalo-crm-db psql -U crmuser -d postgres -c "CREATE DATABASE zalocrm;"

# Restore
gunzip -c ./backups/daily/zalocrm-YYYY-MM-DD.sql.gz | docker exec -i zalo-crm-db psql -U crmuser -d zalocrm

# Start app trở lại
docker compose start app
```

> ⚠️ Restore mất 30s-5p tuỳ kích thước. Trong thời gian này, sale không vào CRM được, Zalo session có thể bị mất → cần quét QR lại.

## 5. Common errors

### `bind: address already in use` khi `docker compose up`

Port 5434 đã có process khác chiếm (vd. native Postgres trên máy dev). Đổi port mapping trong `docker-compose.yml`:

```yaml
db:
  ports:
    - "127.0.0.1:5435:5432"  # change 5434 → 5435 hoặc port khác
```

Container nội bộ vẫn dùng 5432 nên app code không đổi.

### App container crash loop với `POSTGRES_PASSWORD is required`

`.env` thiếu `DB_PASSWORD`. Set giá trị rồi `docker compose down -v && docker compose up -d --build` (lưu ý `-v` xoá volume, **chỉ làm khi DB chưa init**).

### Zalo "Đã ngắt kết nối" liên tục

1. Check log: `docker logs zalo-crm-app | grep -E "zalo|disconnect|circuit"`
2. Nếu thấy `Circuit breaker: 5 disconnects in 5 min` → session bị Zalo reject. Vào **Tài khoản Zalo** → bấm QR → quét lại từ điện thoại
3. Nếu nhiều account cùng disconnect → có thể bị Zalo rate limit hoặc IP server bị nghi spam. Đợi 1h rồi retry

### Auto-reply không gửi

Check theo thứ tự (xem [feature 0005 SPEC §3](../features/0005-auto-reply/SPEC.md)):

1. Rule `enabled = true`?
2. Đang OUTSIDE active window? (vd: thiết lập T2-T6 8-18h, hiện 14h thứ ba → đang IN, không trigger)
3. Cooldown đã hết chưa? (`SELECT * FROM auto_reply_history WHERE contact_uid = '...' ORDER BY sent_at DESC`)
4. Bạn có vừa reply contact đó trong 5 phút trước không? (nếu có → skip)
5. Rate limit hit? (xem log `[auto-reply] rate-limit hit`)

### CI fail trên PR mới (Backend `Generate Prisma client`)

Schema syntax error. Pull branch về local + chạy `npx prisma generate` để xem dòng lỗi.

### CI fail trên PR mới (Frontend `Type-check + build`)

Thường là vue-tsc error hoặc Vite template parsing fail (vd: `{{ ... }}` literal interpolation — phải dùng `v-pre`). Chạy `cd frontend && npm run build` local để reproduce.

## 6. Monitoring

| Metric | Cách kiểm tra |
|--------|---------------|
| App alive | `curl https://your-domain/health` mỗi 60s |
| DB alive | Trong `/health` response field `db: connected` |
| Số Zalo account connected | `SELECT count(*) FROM zalo_accounts WHERE status = 'connected'` |
| Tin chưa trả lời >30p | `SELECT count(*) FROM conversations WHERE is_replied = false AND last_message_at < now() - interval '30 min'` |
| Daily message limit gần đạt | `SELECT * FROM daily_message_stats WHERE messages_sent > 180 AND stat_date = current_date` (cảnh báo trước khi hit 200) |

## 7. Khi không vào được CRM (incident)

1. SSH vào server
2. `docker compose ps` — service nào down?
3. Nếu `db` down → `docker compose logs db` xem lỗi disk full / OOM
4. Nếu `app` down → `docker compose logs app | tail -50`
5. Nếu cả 2 đều "up healthy" nhưng vẫn không vào → check nginx/reverse proxy phía trước
6. Worst case: `docker compose restart` (downtime ~30s)
7. Nếu DB corrupt → restore từ backup (mục 4)

## 8. Bảo trì định kỳ

| Tần suất | Việc |
|----------|------|
| Hàng ngày | Container `backup` tự dump (không cần làm thủ công) |
| Hàng tuần | Check log `app` 5 phút để spot warning bất thường |
| Hàng tháng | Verify restore: chạy thử restore vào DB tạm (vd: `zalocrm_test`) để chắc backup không corrupt |
| Khi update Node/Postgres major version | Test trên `docker-compose.dev.yml` trước, plan downtime cho prod |

## 9. App crash-loop sau khi deploy schema destructive

**Triệu chứng:** `docker logs zalo-crm-app` lặp lại
```
Error: Use the --accept-data-loss flag to ignore the data loss warnings
like prisma db push --accept-data-loss
```
mỗi ~30 giây.

**Nguyên nhân:** schema mới drop một column mà DB hiện tại có dữ liệu
non-null (kể cả `[]` cũng tính là non-null). Prisma `db push` từ chối
silent data loss trong production (NODE_ENV=production trong
docker-compose.yml). Đây là hành vi cố ý — không phải bug — nhưng cần
operator can thiệp.

**Xử lý:**

1. **Backup trước:**
   ```bash
   docker exec zalo-crm-db pg_dump -U crmuser zalocrm > /tmp/before-migration-$(date +%F).sql
   ```

2. **Đọc schema mới + xác định column nào bị drop** (so với DB hiện tại):
   ```bash
   docker exec zalo-crm-db psql -U crmuser -d zalocrm -c "\d contacts" | grep -i tags
   ```
   So sánh với `backend/prisma/schema.prisma`.

3. **Drop column thủ công nếu xác nhận an toàn:**
   ```bash
   docker exec zalo-crm-db psql -U crmuser -d zalocrm \
     -c "ALTER TABLE contacts DROP COLUMN IF EXISTS tags;"
   ```

4. **Restart app — sẽ tự heal:**
   ```bash
   docker restart zalo-crm-app
   docker logs --tail 20 zalo-crm-app
   ```
   Phải thấy `The database is already in sync with the Prisma schema.`

**Phòng ngừa cho lần sau:**

- Trước khi deploy một schema có column drop, chạy migration thủ công
  trên DB **trước** khi `docker compose up` image mới.
- `docker-compose.dev.yml` có `NODE_ENV=development`, tức là Dockerfile
  tự thêm `--accept-data-loss` → môi trường dev/staging tự heal. Chỉ
  prod (mặc định `docker-compose.yml`) cần can thiệp thủ công.

## 10. Master key rotation (Feature 0044)

`AI_CONFIG_MASTER_KEY` là khóa chủ HKDF-SHA-256 → AES-256-GCM cho 3
bề mặt dữ liệu nhạy cảm:

- **0036** — `ai_configs.api_key_cipher/iv/tag` (provider API keys).
- **0038** — `integrations.config_cipher/iv/tag` (OAuth refresh
  tokens, Telegram bot tokens).
- **0035 + 0044** — `zalo_accounts.proxy_url_cipher/iv/tag` (proxy URL
  có thể chứa credentials).

Mất hoặc rò khóa = mất toàn bộ secret đã mã hóa. Quy trình rotate đảm
bảo zero-downtime: trong cửa sổ rotate ứng dụng decrypt bằng
**current key** trước, **previous key** dự phòng. CLI re-encrypt từng
batch để cuối quy trình chỉ còn current key.

### 10.1. Khi nào rotate

- Nghi ngờ khóa bị rò (nhân viên cũ có quyền prod, accident commit, …).
- Theo lịch SOC2 / ISO 27001 / audit nội bộ.
- Sau khi xử lý incident liên quan đến hạ tầng credential.

### 10.2. Quy trình 9 bước

```
┌─ Step 1 ─────────────────────────────────────────────────────────┐
│ Tạo khóa mới (chạy local, KHÔNG paste vào chat / ticket):       │
│                                                                  │
│     openssl rand -hex 32                                         │
└──────────────────────────────────────────────────────────────────┘
```

**Step 2 — Cập nhật env (staging trước, prod sau):**

- `AI_CONFIG_MASTER_KEY_PREVIOUS=<old key>`
- `AI_CONFIG_MASTER_KEY=<new key>`
- `docker compose up -d app` (rebuild nếu cần). Boot guard refuse start
  nếu 2 biến trùng nhau — đó là lỗi paste, sửa rồi deploy lại.

**Step 3 — Verify app healthy.** Tail log:

```bash
docker logs --tail 200 zalo-crm-app | grep -i "previous key"
```

Sau khi user/CRON đầu tiên đọc một row encrypted bằng key cũ, log sẽ
có dòng `[crypto] decrypted with previous key, re-encrypt pending` —
đây là tín hiệu fallback hoạt động đúng (không phải lỗi).

**Step 4 — Dry-run CLI:**

```bash
docker exec -it zalo-crm-app sh -c "cd /app/backend && pnpm rotate-master-key --dry-run"
```

JSON output cho biết: bao nhiêu rows mỗi bảng cần re-encrypt, bao
nhiêu đã current, có failed không. Xác nhận số liệu hợp lý trước khi
chạy thật.

**Step 5 — Run rotation thật:**

```bash
docker exec -it zalo-crm-app sh -c "cd /app/backend && pnpm rotate-master-key"
```

CLI in tiến độ mỗi batch (100 rows). Với org có vài nghìn rows nên
xong < 5 phút. Dùng `FOR UPDATE SKIP LOCKED` nên không block ứng dụng
đang chạy.

**Step 6 — Nếu exit code = 2:** có row decrypt thất bại bằng cả 2 key.

```
exit code 2 = partial rotation
JSON output liệt kê failedIds theo bảng
```

Nguyên nhân thường gặp:
- Có một lần rotation cũ chưa hoàn tất → row vẫn dùng key thứ 3.
- Blob corrupt (DB restore từ backup không khớp với env).

Quyết định theo policy:
- Xóa row (mất AI config / integration / proxy URL đó).
- Restore từ backup cũ hơn.
- Yêu cầu org reconfigure (user nhập lại credentials qua UI).

**KHÔNG remove `AI_CONFIG_MASTER_KEY_PREVIOUS` cho đến khi xử lý xong.**

**Step 7 — Verify done.** Re-run dry-run:

```bash
docker exec -it zalo-crm-app sh -c "cd /app/backend && pnpm rotate-master-key --dry-run"
```

Mọi bảng phải báo `reencrypted: 0, skipped: <N>`. Nếu vẫn còn rows
cần encrypt → quay lại step 5.

**Step 8 — Remove previous key:**

- Xóa `AI_CONFIG_MASTER_KEY_PREVIOUS` khỏi `.env`.
- `docker compose up -d app`.
- Tail log 5-10 phút — không được có dòng "previous key" nào nữa.

**Step 9 — Ghi log operations:** ngày, người thực hiện, lý do rotate,
số rows được re-encrypt. Lưu trong vault nội bộ (KHÔNG commit).

### 10.3. Recovery nếu Step 2 deploy lỗi

- Roll back env về **chỉ** old key (xóa cả `_PREVIOUS` và đặt
  `AI_CONFIG_MASTER_KEY=<old key>`).
- `docker compose up -d app` — DB chưa bị động vào, app trở lại
  bình thường.
- Điều tra nguyên nhân (key sai format? đặt nhầm key cũ vào current?),
  fix, thử lại.

### 10.4. Rotation cho proxyUrl (one-off, chạy 1 lần khi 0044 lên prod)

Bản 0044 lần đầu chuyển `zalo_accounts.proxy_url` từ plaintext sang
cipher. Khi deploy 0044 lần đầu (chỉ duy nhất 1 lần):

```bash
# Backup DB trước. Sau đó:
docker exec -it zalo-crm-app sh -c "cd /app/backend && pnpm migrate-encrypt-proxy-url --dry-run"
# Nếu số liệu hợp lý:
docker exec -it zalo-crm-app sh -c "cd /app/backend && pnpm migrate-encrypt-proxy-url"
```

Script idempotent. Sau khi xong, cột `proxy_url` plaintext bị DROP.
Từ đây trở đi quy trình rotation 10.2 cover cả 3 bảng.

## 11. Tham khảo nhanh

- Settings: `.env` (KHÔNG commit)
- Schema: `backend/prisma/schema.prisma`
- API endpoints: [README.md §API & Webhook](../../README.md#api--webhook)
- Feature SPEC: [docs/features/](../features/)
- CI pipeline: [CI-CD.md](./CI-CD.md)
