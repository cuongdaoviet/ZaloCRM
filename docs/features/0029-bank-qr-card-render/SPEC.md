# Feature 0029: Bank/QR card render (zinstant cards)

## 1. Mô tả

KH thường gửi "thẻ chuyển khoản" — Zalo native UI để share bank account
number / amount / QR code (gọi là `zinstant` cards). Hôm nay nội dung này
render dưới dạng plain text "@@ZINSTANT@@" hoặc JSON raw — rep phải copy
thủ công từng số. Feature này detect zinstant card trong message content,
render dưới dạng card đẹp với click-to-copy account number, click-to-copy
amount, QR code image (nếu embedded).

Match ZaloCRM-3.0 v3.0: "Bank/QR card render".

## 2. User Stories

- **US-0029-1:** Là Sale, khi KH gửi thẻ chuyển khoản trên Zalo, tôi thấy
  card styled với số TK, ngân hàng, số tiền, QR — tất cả click-to-copy.
- **US-0029-2:** Là Sale, tôi click vào số TK → toast "Đã copy
  XXXXXXXXXXXX" + clipboard có giá trị → tôi paste sang banking app.
- **US-0029-3:** Là Sale, tôi click vào QR image → mở fullscreen để scan
  bằng banking app.

## 3. Business Rules

### Detection

- **BR-0001:** Inbound message với content là JSON có shape Zalo zinstant.
  Detect bằng pattern (verify tại impl):
  - JSON contains `"appId":"<some-id>"` AND `"params":{...}` keys, HOẶC
  - String contains `@@ZINSTANT@@` marker.
- **BR-0002:** Khi detect, set `Message.contentType = 'zinstant'`. Lưu
  parsed structure vào `content` (giữ JSON envelope, hoặc enrich thêm
  `parsed` field với account info).

### Parse zinstant payload

- **BR-0003:** Common fields trong zinstant bank card:
  - `bankCode` / `bankName` (BIDV, Vietcombank, Techcombank, ...)
  - `accountNumber` (numeric string)
  - `accountName` (chủ TK)
  - `amount` (optional, numeric VND)
  - `description` / `note` (optional)
  - `qrUrl` (image URL) hoặc base64 QR data
- **BR-0004:** Parser tolerant: missing fields render với fallback
  ("Chưa rõ"). KHÔNG crash khi schema khác (Zalo versioning).

### Render

- **BR-0005:** Render `<ZinstantCard>` component thay thế default message
  bubble cho contentType='zinstant'. Layout:
  - Header: bank logo + bankName.
  - Account number (large, monospace, click-to-copy icon).
  - Account name.
  - Amount + description (nếu có).
  - QR image (nếu có), click → fullscreen modal.

### Outbound (out of scope phase 1)

- Phase 2 sẽ cho rep gửi bank card từ composer. Phase 1: chỉ render
  inbound.

## 4. Input / Output

### Schema

KHÔNG schema change.

### Detection / Persist

In `backend/src/modules/zalo/zalo-message-helpers.ts`
`detectContentType()`:

```typescript
function detectContentType(msgType: any, rawContent: any): string {
  // ... existing logic ...

  // Zinstant detection
  if (typeof rawContent === 'string' && rawContent.includes('@@ZINSTANT@@')) {
    return 'zinstant';
  }
  try {
    const parsed = typeof rawContent === 'object' ? rawContent : JSON.parse(rawContent);
    if (parsed?.appId && parsed?.params) {
      return 'zinstant';
    }
  } catch { /* not JSON */ }

  // ... fall through ...
}
```

Persist content as-is (JSON envelope). FE parses on render.

### Frontend

#### `parseZinstant(rawContent: string)` helper

```ts
function parseZinstant(rawContent: string): ZinstantData | null {
  try {
    const obj = JSON.parse(rawContent);
    // Extract known fields. Tolerant of missing fields.
    return {
      bankCode: obj?.params?.bankCode || obj?.bankCode || null,
      bankName: obj?.params?.bankName || obj?.bankName || null,
      accountNumber: obj?.params?.accountNumber || obj?.accountNumber || '',
      accountName: obj?.params?.accountName || obj?.accountName || '',
      amount: obj?.params?.amount || null,
      description: obj?.params?.description || obj?.params?.note || '',
      qrUrl: obj?.params?.qrUrl || obj?.qrUrl || null,
    };
  } catch {
    return null;
  }
}
```

#### `ZinstantCard.vue` component

- Props: `data: ZinstantData`.
- Click-to-copy with `navigator.clipboard.writeText()` + toast.
- QR image click → emit `preview` for parent to open modal.

#### MessageThread integration

Switch:
```vue
<template v-else-if="msg.contentType === 'zinstant'">
  <ZinstantCard v-if="parseZinstant(msg.content)" :data="parseZinstant(msg.content)!" />
  <span v-else>📦 Thẻ thông tin</span>
</template>
```

## 5. Edge Cases

- **EC-0001:** Zinstant không phải bank card (vd location share, contact
  card) → parser nhận ra schema khác → render fallback "📦 Thông tin Zalo".
  KHÔNG crash.
- **EC-0002:** accountNumber rỗng → render hide field hoặc "Chưa rõ".
- **EC-0003:** QR URL hết hạn (Zalo CDN expiry) → image broken; show
  placeholder "QR không tải được".
- **EC-0004:** Copy fail (browser permissions) → toast error "Không copy
  được, hãy copy thủ công".

## 6. Acceptance Criteria

- [ ] **AC-0001:** Inbound zinstant message → DB row có
      `contentType='zinstant'`.
- [ ] **AC-0002:** FE: zinstant message render `<ZinstantCard>`, KHÔNG
      hiện raw JSON.
- [ ] **AC-0003:** Click số TK → clipboard có giá trị, toast "Đã copy".
- [ ] **AC-0004:** QR image render, click → fullscreen modal.
- [ ] **AC-0005:** Parse fail / unknown schema → fallback "📦 Thông tin
      Zalo".
- [ ] **AC-0006:** Existing non-zinstant messages render unchanged
      (regression).
- [ ] **AC-0007:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `backend/src/modules/zalo/zalo-message-helpers.ts` — `detectContentType`
  branches.
- `frontend/src/components/chat/MessageThread.vue` — render branch.
- `frontend/src/components/chat/ZinstantCard.vue` — new.
- `frontend/src/utils/parse-zinstant.ts` — helper.

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Backend detect branch | ~15 |
| FE parseZinstant helper | ~30 |
| FE ZinstantCard component | ~120 |
| FE MessageThread branch | ~10 |
| Backend integration test (1) | ~30 |
| FE component test (basic) | ~30 |
| **Tổng** | **~235 LOC** |

### Risk: LOW

Read-only render. Tolerant parser handles schema variations. No new
endpoints, no zca-js calls. Test surface small.

### Test strategy

- Backend: feed sample zinstant payload to message handler, assert
  contentType set.
- FE: mount card with stub data, assert fields rendered + click handlers.
- Manual smoke: ask volunteer to send bank card from real Zalo client.

### Deviations from ZaloCRM-3.0

3.0 release note short. Our parser is tolerant (BR-0004) so future Zalo
zinstant variants don't break us.

### Out of scope (Phase 2)

- Outbound bank card composer (rep tạo + gửi).
- Non-bank zinstant types (location, contact card) — generic renderer.
- QR scan inline (camera-based, mobile-only).
- Integration with VietQR / banking APIs for verification.
