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

## 9. Tham khảo nhanh

- Settings: `.env` (KHÔNG commit)
- Schema: `backend/prisma/schema.prisma`
- API endpoints: [README.md §API & Webhook](../../README.md#api--webhook)
- Feature SPEC: [docs/features/](../features/)
- CI pipeline: [CI-CD.md](./CI-CD.md)
