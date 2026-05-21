# Feature 0035: Per-account proxy config (HTTP / SOCKS5)

## 1. Mô tả

Reps ở khu vực địa lý khác nhau (TP.HCM, Hà Nội, Đà Nẵng, hoặc remote
overseas) đôi khi cần Zalo connection đi qua proxy của vùng tương ứng —
do nhà mạng địa phương, do Zalo geo-routing, hoặc do org có hạ tầng proxy
riêng cho compliance. Hôm nay zca-js connect trực tiếp, không có cách set
proxy per-account.

Feature này thêm `ZaloAccount.proxyUrl` field + UI để Admin set proxy cho
từng nick, pass-through xuống zca-js qua `agent` option.

Match ZaloCRM-3.0: "Cấu hình proxy HTTP/SOCKS5 cho từng Zalo qua giao diện".

## 2. User Stories

- **US-0035-1:** Là Admin, tôi vào Settings → Zalo Accounts → 1 account
  → form "Proxy URL", nhập `socks5://user:pass@10.0.0.1:1080` rồi save.
  Account reconnect sẽ dùng proxy đó.
- **US-0035-2:** Là Admin, tôi clear field để bỏ proxy → account quay về
  connect trực tiếp.
- **US-0035-3:** Là Admin, tôi nhập sai format (vd `socks5//bad`) → UI
  reject với message rõ ràng "Định dạng không hợp lệ".
- **US-0035-4:** Là Admin, tôi không thấy raw proxyUrl (có credentials)
  của account khác trừ khi tôi là Owner/Admin của org. Member-level user
  KHÔNG được xem field này.

## 3. Business Rules

### Schema + validation

- **BR-0001:** `ZaloAccount.proxyUrl: String?` — nullable. NULL = no proxy
  (default behavior unchanged).
- **BR-0002:** Accepted formats:
  - `http://[user:pass@]host:port`
  - `https://[user:pass@]host:port`
  - `socks5://[user:pass@]host:port`
  - `socks://...` (alias for socks5) — accept, normalize sang `socks5://`
    trước khi lưu.
  - Trailing `/` allowed nhưng strip khi lưu.
- **BR-0003:** Validation chạy ở backend qua Zod schema. Reject 400 nếu
  không match. FE cũng validate trước khi gửi (UX), nhưng backend là
  authoritative.

### Permissions

- **BR-0004:** GET/PUT proxyUrl chỉ Owner/Admin của org được phép. Member
  → 403.
- **BR-0005:** Khi response chứa account list cho non-admin (vd
  chat-routes conversation list), proxyUrl phải bị strip khỏi response
  (security). API contract: `proxyUrl` chỉ xuất hiện trong endpoints Settings,
  KHÔNG trong endpoints chat/conversation.

### Runtime integration

- **BR-0006:** Khi zca-js `Zalo` instance được khởi tạo (login flow / QR
  flow / session restore), nếu `account.proxyUrl` non-null:
  - HTTP/HTTPS proxy → use `HttpsProxyAgent` từ `https-proxy-agent` package.
  - SOCKS5 proxy → use `SocksProxyAgent` từ `socks-proxy-agent` package.
  - Pass `agent` field vào zca-js Zalo constructor options.
- **BR-0007:** Nếu proxyUrl thay đổi cho account đang connected: account
  cần disconnect + reconnect để dùng proxy mới. Implementation: PUT
  `/zalo-accounts/:id` với proxyUrl khác → trigger disconnect + reconnect
  (existing pattern nếu có) HOẶC trả response kèm flag
  `requiresReconnect: true` để FE prompt admin reconnect thủ công.
  Recommend: trả flag, để admin chủ động (an toàn hơn vì auto-reconnect có
  thể gây race).
- **BR-0008:** Nếu proxy không reachable → zca-js login fail. Error message
  trả về cho admin: "Proxy không kết nối được — kiểm tra URL/credentials".
  Account status không đổi (vẫn `disconnected`). KHÔNG fallback sang direct
  connection (silent fallback = security risk).

### Storage / Security

- **BR-0009:** `proxyUrl` lưu plaintext trong DB (acceptable: same threat
  model như `sessionData`, attacker với DB access đã có nhiều thứ rồi).
  KHÔNG cần encryption-at-rest cho phase 1. Audit log thay đổi là plus
  nhưng out-of-scope.
- **BR-0010:** Logging: KHÔNG log full proxyUrl. Mask thành
  `socks5://***@host:port` khi log. Format helper trong shared/util.

## 4. Input / Output

### Schema migration

```prisma
model ZaloAccount {
  // ... existing fields ...
  proxyUrl String? @map("proxy_url")
}
```

Migration: `ADD COLUMN proxy_url TEXT NULL`. Existing rows: NULL (no proxy).

### Endpoint changes

#### `PUT /api/v1/zalo-accounts/:id`

Existing endpoint (Admin/Owner only). Add `proxyUrl` to accepted body fields.

- Body extension:
  ```json
  { "proxyUrl": "socks5://user:pass@10.0.0.1:1080" }
  ```
- Validation: Zod schema with `.url()` + regex check on scheme.
  - Accept: `http://`, `https://`, `socks://`, `socks5://`.
  - Reject 400 `{ code: 'invalid_proxy_format' }`.
- Empty string / null → clear proxy.
- Response 200: account object (with `proxyUrl` field for admin caller).
  Include `requiresReconnect: true` if proxyUrl changed AND account
  status is `connected`.

#### `GET /api/v1/zalo-accounts` & `GET /:id`

- Admin/Owner caller: response includes `proxyUrl`.
- Member caller: response strips `proxyUrl` (returns undefined).

### Login / Reconnect integration

Trong `backend/src/modules/zalo/zalo-pool.ts` (hoặc file equivalent quản lý
Zalo instances), khi tạo `new Zalo({ ... })`:

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

function buildAgent(proxyUrl: string | null) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
  if (proxyUrl.startsWith('http')) return new HttpsProxyAgent(proxyUrl);
  return undefined;
}

const zalo = new Zalo({
  // ... existing options
  agent: buildAgent(account.proxyUrl),
});
```

Package deps to add: `socks-proxy-agent@^8`, `https-proxy-agent@^7`.

### FE form

Settings → Zalo Accounts → detail/edit panel:
- Input field "Proxy URL" với placeholder
  `socks5://user:pass@host:1080 hoặc để trống`.
- Helper text: "Hỗ trợ HTTP, HTTPS, SOCKS5. Để trống = kết nối trực tiếp."
- Validation client-side với regex.
- Trên save: nếu BE trả `requiresReconnect: true`, hiện banner
  "Cần reconnect để áp dụng proxy mới" với button reconnect.

Field hiển thị: hiện hostname:port + scheme, mask credentials phần `user:pass`
khi display (vd `socks5://****@10.0.0.1:1080`). Input edit thì show plain.

## 5. Edge Cases

- **EC-0001:** ProxyUrl mà host không resolve / port không reachable →
  BR-0008: error message, status không thay đổi.
- **EC-0002:** ProxyUrl có IPv6 → vẫn chấp nhận, format
  `socks5://[::1]:1080`.
- **EC-0003:** Proxy yêu cầu auth nhưng URL không có credentials → fail
  rõ ràng từ proxy agent. BR-0008 path.
- **EC-0004:** Admin save same proxyUrl không đổi → KHÔNG trigger reconnect
  (no-op).
- **EC-0005:** Clear proxy (set null) khi account đang connect qua proxy →
  `requiresReconnect: true`. Admin phải reconnect thủ công để chuyển sang
  direct.
- **EC-0006:** zca-js không support `agent` option ở mọi phương thức nội
  bộ (vd webhook callback) → document limitation. Phase 1: proxy chỉ
  guarantee áp dụng cho login + main socket connection.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Migration add `proxy_url TEXT NULL` → build pass.
- [ ] **AC-0002:** PUT `/zalo-accounts/:id` với valid SOCKS5 URL → 200,
      DB row updated, response có `requiresReconnect: true` nếu account
      đang connected.
- [ ] **AC-0003:** PUT với invalid format → 400 `invalid_proxy_format`.
- [ ] **AC-0004:** PUT với null/empty → clear field, success.
- [ ] **AC-0005:** Member user PUT → 403.
- [ ] **AC-0006:** Member user GET account → response không có `proxyUrl`.
- [ ] **AC-0007:** Admin user GET account → response có `proxyUrl`.
- [ ] **AC-0008:** Reconnect với proxyUrl SOCKS5 (mocked agent) → zca-js
      Zalo instance nhận agent option. Verify via spy/mock.
- [ ] **AC-0009:** Reconnect với proxyUrl unreachable → login fail với
      error message rõ ràng, account.status không đổi.
- [ ] **AC-0010:** Logging không leak credentials: log line
      `socks5://***@host:port` (mask `user:pass`).
- [ ] **AC-0011:** FE form validate format client-side, hiện banner
      reconnect khi BE trả flag.
- [ ] **AC-0012:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `ZaloAccount` model — thêm 1 field nullable.
- `backend/src/modules/zalo/zalo-account-routes.ts` (hoặc settings routes
  hiện tại quản lý PUT zalo-accounts) — extend body schema + permission
  guard + response shaping.
- `backend/src/modules/zalo/zalo-pool.ts` (hoặc file Zalo instance factory)
  — `buildAgent` helper, pass to constructor.
- `backend/package.json` — add `https-proxy-agent@^7`,
  `socks-proxy-agent@^8`.
- `backend/src/shared/logger.ts` (hoặc util) — `maskProxyUrl` helper.
- `frontend/src/pages/SettingsZaloAccounts.vue` (hoặc form edit account)
  — input + banner.
- `frontend/src/types/zalo-account.ts` — add `proxyUrl: string | null` (admin
  view only).

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Schema migration | ~3 |
| Body schema + permission + shaping | ~50 |
| buildAgent + pool integration | ~30 |
| Mask helper + logger update | ~15 |
| Package install + types | ~5 |
| FE form + validation + banner | ~80 |
| FE TS types | ~5 |
| Integration tests | ~100 |
| **Tổng** | **~290 LOC** |

### Risk: LOW-MEDIUM

Schema additive an toàn. Rủi ro chính là integration với zca-js — agent
option có thể không apply mọi nơi (vd webhook receiver dùng connection
khác). Test với mocked agent + manual smoke test trên 1 nick thật trước
khi rollout.

### Test strategy

- Unit: `buildAgent` returns correct agent type per scheme; `maskProxyUrl`
  ẩn credentials.
- Integration: PUT/GET endpoints với từng role; clear/set/invalid paths;
  member access strip.
- Mocked zca-js: spy trên `new Zalo({ agent })` để verify agent object đúng
  type được pass.
- Manual smoke: setup local SOCKS5 (vd `ssh -D 1080`), config 1 account, verify
  Zalo connection đi qua proxy (check proxy access log).

### Deviations from ZaloCRM-3.0

3.0 release notes không mô tả detail bao xa, nhưng signal "proxy HTTP/SOCKS5
per Zalo qua giao diện" → match đúng scope. Bổ sung: requiresReconnect flag
(an toàn hơn auto-reconnect), credential masking trong log (security
hardening).

### Out of scope (Phase 2)

- Proxy health-check endpoint (test connectivity trước khi save).
- Proxy pool / failover (nếu primary fail, dùng secondary).
- Org-level default proxy (set 1 lần áp dụng cho mọi account chưa có riêng).
- Audit log của thay đổi proxy (compliance feature).
- Encryption-at-rest cho `proxy_url` column.
