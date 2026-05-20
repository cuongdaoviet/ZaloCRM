# Feature 0025: Inline video player

## 1. Mô tả

Khi KH gửi video qua Zalo, chat web hiện chỉ render placeholder text "🎥 Video"
— sale phải mở Zalo trên điện thoại để xem nội dung. Feature này render
video inline bằng HTML5 `<video controls>` với thumbnail Zalo gửi kèm làm
poster.

## 2. User Stories

- **US-0025-1:** Là Sale, khi KH gửi video, tôi xem được ngay trong CRM
  không phải chuyển sang app Zalo.
- **US-0025-2:** Là Sale, tôi muốn thấy thumbnail preview trước khi bấm
  play để không phải tải video không cần thiết.

## 3. Business Rules

- **BR-0001:** Render video inline khi `Message.contentType === 'video'`
  VÀ `getVideoInfo()` parse được URL hợp lệ (http(s)). Ngược lại → giữ
  fallback "🎥 Video" cũ.
- **BR-0002:** Dùng `preload="metadata"` để browser chỉ tải poster +
  duration, KHÔNG auto-tải toàn bộ video. Người dùng phải bấm play.
- **BR-0003:** Poster image ưu tiên `Message.content.thumb` (Zalo gửi
  kèm). Nếu không có, để browser render frame đầu sau khi click play.
- **BR-0004:** Max-height 360px để không chiếm quá nhiều chỗ trong
  message thread.

## 4. Input / Output

Chỉ là rendering — không endpoint mới, không schema mới.

Input: `Message` object với `contentType='video'` và `content` là JSON
string Zalo gửi về (`{ hdUrl, href, thumb, ... }`).

Output: `<video>` element với native browser controls.

### `getVideoInfo(msg)` helper

```ts
function getVideoInfo(msg: Message): {
  href: string;
  poster: string | null;
} | null
```

- Returns `null` nếu không phải video, không có content, hoặc parse JSON
  fail.
- `href` = `content.hdUrl || content.href` (chuỗi `http*`).
- `poster` = `content.thumb` nếu là `http*`, ngược lại `null`.

## 5. Edge Cases

- **EC-0001:** Content là plain URL (không phải JSON object) → dùng làm
  `href`, không có poster.
- **EC-0002:** `hdUrl` rỗng nhưng `href` có → fallback `href`.
- **EC-0003:** Cả hai URL fields đều rỗng / không bắt đầu bằng `http` →
  trả `null`, fallback text placeholder.
- **EC-0004:** JSON parse fail → trả `null`.
- **EC-0005:** Zalo CDN URL hết hạn (cùng vấn đề như image messages) →
  browser hiện "video không tải được" của native player. Không xử lý đặc
  biệt; sẽ được giải quyết khi có MinIO mirror (feature 0027).

## 6. Acceptance Criteria

- [ ] **AC-0001:** Message với `contentType='video'` và `content` chứa
      `hdUrl` HTTP → render `<video>` với src đó.
- [ ] **AC-0002:** `Message.content.thumb` có giá trị HTTP → set
      `poster` attribute trên `<video>`.
- [ ] **AC-0003:** Content rỗng / JSON parse fail / không có URL hợp lệ
      → giữ fallback "🎥 Video" text.
- [ ] **AC-0004:** Build pass: `vue-tsc + vite build`.

## 7. Dependencies

- `frontend/src/components/chat/MessageThread.vue` — chỉ duy nhất file
  này thay đổi. Mọi logic ở client.

## 8. Implementation notes

- **LOC:** ~30 (template + helper + 1 CSS rule).
- **Risk:** LOW.
- **Tests:** No unit test added — the helper is small enough that build-
  time type checks + manual smoke test cover it. Future MinIO mirror
  feature (0027) will add real attachment-handling tests.
- **NOSONAR:** Web:S4084 (subtitle tracks) is suppressed inline since
  user-uploaded Zalo videos don't ship captions.

## 9. Out of scope

- Custom video controls / branding (use native browser controls).
- Video uploads from the composer (planned for a future composer feature).
- Video thumbnail scrubbing UI.
- Captions / `<track>` support.
