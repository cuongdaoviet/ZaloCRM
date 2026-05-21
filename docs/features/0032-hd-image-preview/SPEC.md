# Feature 0032: HD image preview (uploadAttachment first)

## 1. Mô tả

Outbound image messages today rely on `sendMessage` returning an `hdUrl` /
`href` in its response. zca-js sometimes returns empty/null for these
fields — kết quả: message lưu DB với content trống → FE render placeholder
thay vì image. Bug fix existing trong ZaloCRM-3.0 v3.0:
"Image preview rỗng — Upload uploadAttachment lấy hdUrl thật trước khi lưu
Message".

Fix: gọi `api.uploadAttachment(file)` TRƯỚC để lấy `hdUrl` thật từ Zalo
CDN, sau đó `api.sendMessage({ attachments: [hdUrl], ... })`. Khi persist
Message, dùng `hdUrl` từ uploadAttachment response (đảm bảo non-empty)
chứ không từ sendMessage response.

Match ZaloCRM-3.0 v3.0 bug-fix note.

**Note:** Feature 0027 (MinIO mirror) đã ship. Outbound flow hiện đã upload
sang MinIO trước rồi gửi link MinIO qua zca-js. Feature 0032 vẫn cần thiết
cho 2 case:
1. Zalo `hdUrl` cho **inbound** image content (Zalo CDN side) — không
   ảnh hưởng 0032 này.
2. Outbound: nếu rep chọn gửi qua **Zalo CDN** (không qua MinIO mirror)
   ở env không cấu hình MinIO → cần uploadAttachment-first pattern.
3. Outbound message metadata: lưu `hdUrl` Zalo phụ thêm để future reference
   (forwarding, debugging) — đang miss field này.

Scope chính của 0032 là cleanup contract `Message.content.hdUrl` cho cả 2
flow để consistent + future-proof. Có thể overlap với 0027; impl agent
xác minh và pick subset chưa làm.

## 2. User Stories

- **US-0032-1:** Là Sale, mọi ảnh tôi gửi đi đều có preview thumbnail
  ngay trong CRM (không placeholder rỗng).
- **US-0032-2:** Là Sale, ảnh tôi gửi cũng có HD URL lưu trong Message
  metadata để có thể export/forward sau này.

## 3. Business Rules

### Outbound flow refactor

- **BR-0001:** Outbound attachment route (đã refactor ở Feature 0027 để
  upload MinIO first):
  - Nếu MinIO không khả dụng (env không config / fail upload) → fallback
    sang Zalo CDN.
  - Trong fallback path: gọi `api.uploadAttachment(localPath)` FIRST →
    parse response để lấy `hdUrl` (Zalo CDN URL). Sau đó
    `api.sendMessage({ attachments: [hdUrl] })`.
- **BR-0002:** Khi persist Message với attachment, fields cần set:
  - `content.href = hdUrl` (Zalo CDN URL — fallback case) HOẶC MinIO URL
    (primary case).
  - `content.hdUrl = hdUrl từ uploadAttachment` (LUÔN có ở Zalo CDN
    fallback path; nếu MinIO path thì có thể empty hoặc set thêm Zalo
    URL nếu zca-js return — best effort).
  - `content.thumb = thumbUrl từ uploadAttachment.thumb` nếu available.
- **BR-0003:** Validate sau uploadAttachment: nếu response không có
  `hdUrl` (rare, but Zalo flake) → log error + return 502 `upload_failed`
  cho client. KHÔNG silently store empty URL (bug 3.0 chính là đây).

### Inbound flow (verify)

- **BR-0004:** Inbound image messages: zca-js `message.data.content` JSON
  envelope đã có `hdUrl` / `href` / `thumb`. Persist as-is. KHÔNG cần
  uploadAttachment cho inbound. Feature 0027 mirror copy này sang MinIO
  best-effort (đã ship).

### Backward compat

- **BR-0005:** Existing messages trong DB có content rỗng/null cho ảnh
  → KHÔNG backfill thủ công. Migration tiếp theo (nếu cần) ở Phase 2.

## 4. Input / Output

### Schema

KHÔNG thêm field. `Message.content` JSON đã chấp nhận arbitrary structure.

### Code changes

#### `backend/src/modules/chat/chat-routes.ts`

Trong outbound attachment route — fallback path khi MinIO không khả dụng:

```typescript
// PSEUDOCODE — actual location & function name verify trong impl.
async function sendAttachmentZaloCdnFallback(api, file, conversationDest) {
  const uploadResp = await api.uploadAttachment(file.path, conversationDest);
  // uploadResp shape (verify with zca-js docs):
  //   { hdUrl, normalUrl, thumb, fileType, ... }
  const hdUrl = uploadResp?.hdUrl || uploadResp?.normalUrl;
  if (!hdUrl) {
    throw new Error('upload_failed');
  }

  const sendResp = await api.sendMessage(
    { msg: '', attachments: [hdUrl] }, // or whatever zca-js shape
    conversationDest,
  );

  return {
    msgId: sendResp.msgId,
    hdUrl,
    thumb: uploadResp.thumb ?? null,
  };
}
```

#### Message persist:

```typescript
const content = JSON.stringify({
  href: minioUrl ?? hdUrl,    // primary URL (MinIO preferred)
  hdUrl,                       // Zalo CDN URL (always set when fallback)
  thumb: uploadResp.thumb ?? null,
});

await prisma.message.create({
  data: { ..., content, contentType: 'image' },
});
```

## 5. Edge Cases

- **EC-0001:** `uploadAttachment` succeeds nhưng `hdUrl` empty (Zalo edge
  case) → BR-0003: 502.
- **EC-0002:** `uploadAttachment` fail (network/quota) → 502
  `zalo_upload_failed` + log.
- **EC-0003:** Cả MinIO và Zalo CDN đều fail → existing flow handle:
  500 chung; rep retry. Out-of-scope: queue + retry.
- **EC-0004:** Video upload: same uploadAttachment pattern? zca-js có
  `sendVideo` separate có thể không cần. Phase 1 chỉ image. Video reuse
  pattern nếu zca-js cùng API surface.

## 6. Acceptance Criteria

- [ ] **AC-0001:** Outbound image qua Zalo CDN fallback (MinIO disabled):
      Message lưu DB có `content.hdUrl` non-empty.
- [ ] **AC-0002:** `uploadAttachment` trả response thiếu hdUrl → endpoint
      trả 502 `upload_failed`.
- [ ] **AC-0003:** `content.thumb` populated nếu uploadAttachment response
      có thumb.
- [ ] **AC-0004:** Existing tests Feature 0027 vẫn pass (regression).
- [ ] **AC-0005:** FE: outbound image hiển thị preview ngay sau gửi (no
      empty placeholder).
- [ ] **AC-0006:** Build pass: BE tsc + FE vue-tsc + vite.

## 7. Dependencies

- `backend/src/modules/chat/chat-routes.ts` outbound attachment route —
  modify fallback path.
- zca-js `api.uploadAttachment` — verify exact response shape during impl.
- Existing Feature 0027 storage logic — preserve, add fallback edge.
- FE: KHÔNG đổi (render logic đã đúng — bug chỉ ở DB nội dung).

## 8. Implementation notes

### LOC estimate

| Area | LOC |
|---|---|
| Refactor outbound fallback path | ~40 |
| Validation + error code | ~15 |
| Backend tests (with mocked zca-js) | ~80 |
| **Tổng** | **~135 LOC** |

### Risk: LOW

Small, contained backend fix. Existing Feature 0027 tests cover the
golden MinIO path. Fallback path is new — needs explicit test.

### Test strategy

- Integration: mock zca-js `uploadAttachment` to return hdUrl/thumb;
  assert Message row content.
- Mock uploadAttachment to return empty hdUrl → assert 502.
- Mock uploadAttachment to throw → assert 502 + log.

### Deviations from ZaloCRM-3.0

3.0 release note describes the fix at fairly high level. Our scope wraps
it together with Feature 0027 MinIO architecture (which 3.0 also has).
The fix is applicable to the Zalo CDN fallback path; MinIO primary path
benefits indirectly (hdUrl now persisted even when fallback isn't taken,
useful for export/forward features down the line).

### Out of scope (Phase 2)

- Video uploadAttachment refactor (separate zca-js path).
- Backfill empty content rows from before this fix (manual script).
- Sticker upload (handled by Feature 0028).
- Async upload + queue (large files).
