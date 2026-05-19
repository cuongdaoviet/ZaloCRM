# Feature 0006: Tìm kiếm tin nhắn nâng cao

## 1. Mô tả

Hiện tại `/api/v1/search` chỉ tìm contacts + messages + appointments, mỗi loại trả về 10 kết quả không filter, không pagination, không snippet. Khi sale muốn "tìm tin nhắn nhắc đến 'bảng giá' của khách A trong tháng trước" → không làm được.

Feature này thêm:
1. **Endpoint chuyên biệt** `/api/v1/search/messages` với pagination + filter (date range, sender type, content type, Zalo account, conversation, contact)
2. **Snippet highlight** — trả thêm `snippet` (đoạn cắt 80 ký tự quanh keyword, có dấu `**...**` quanh match)
3. **Frontend trang `/search`** với form filter + bảng kết quả + click → jump tới conversation
4. **Sửa dead bug** `diseaseCode/diseaseName` trong global search

## 2. User Stories

- **US-0001:** Là Sale, tôi muốn tìm tất cả tin nhắn chứa "bảng giá" trong 30 ngày qua trên Zalo của tôi → thấy danh sách + snippet để xác định nhanh
- **US-0002:** Là Sale, tôi muốn filter chỉ "tin từ khách" (không lẫn tin tôi gửi) khi tra lại yêu cầu khách
- **US-0003:** Là Sale, tôi muốn click 1 kết quả → mở `/chat` đúng conversation đó (deep link)
- **US-0004:** Là Admin, tôi muốn tìm trên toàn org để audit (chỉ tin trong account user có quyền truy cập)

## 3. Business Rules

- **BR-0001:** Org isolation — chỉ trả về message của `Conversation` cùng `orgId` user
- **BR-0002:** ACL — nếu user là `member`, chỉ trả về message của Zalo account user có `ZaloAccountAccess`. Owner/admin bypass
- **BR-0003:** Query yêu cầu tối thiểu 2 ký tự — short query block với 400
- **BR-0004:** Pagination cap 100 / page, default 30
- **BR-0005:** Filters đều optional, có thể kết hợp:
  - `q`: text contains, case-insensitive
  - `from`, `to`: ISO date range trên `sentAt`
  - `senderType`: `self` | `contact` | omitted = both
  - `contentType`: `text` | `image` | `file` | etc.
  - `accountId`: lọc theo Zalo account
  - `conversationId`: lọc theo conversation (deep search trong 1 chat)
  - `contactId`: lọc theo contact bất kể Zalo account nào
- **BR-0006:** Trả về `snippet` cắt 80 ký tự xung quanh keyword đầu tiên, đặt `**` quanh match để FE render bold
- **BR-0007:** Index `messages(content)` không khả thi với pgvector/B-tree đơn thuần — dùng index thường + dùng `mode: 'insensitive'`. Performance acceptable đến vài triệu rows. Nếu cần scale lên, future migration sang tsvector

## 4. API contract

### GET /api/v1/search/messages

**Query params:**
| Param | Type | Note |
|-------|------|------|
| `q` | string | required, ≥2 chars |
| `from` | ISO datetime | optional |
| `to` | ISO datetime | optional, `from < to` |
| `senderType` | `self` \| `contact` | optional |
| `contentType` | string | optional, exact match |
| `accountId` | uuid | optional |
| `conversationId` | uuid | optional |
| `contactId` | uuid | optional |
| `page` | int | default 1 |
| `limit` | int | default 30, max 100 |

**Response 200:**
```json
{
  "messages": [
    {
      "id": "...",
      "content": "Xin chào, em hỏi bảng giá",
      "snippet": "Xin chào, em hỏi **bảng giá**",
      "contentType": "text",
      "senderType": "contact",
      "senderName": "Khách A",
      "sentAt": "ISO8601",
      "conversation": {
        "id": "...",
        "contact": { "id": "...", "fullName": "...", "avatarUrl": "..." },
        "zaloAccount": { "id": "...", "displayName": "..." }
      }
    }
  ],
  "total": 142,
  "page": 1,
  "limit": 30,
  "totalPages": 5
}
```

**Errors:**
- `400` — `q` thiếu/quá ngắn, `from >= to`, `contentType` invalid, etc.

## 5. Helpers (testable, pure)

```ts
buildSnippet(content: string, query: string, maxLen=80): string
  // Find first case-insensitive match, slice ±40 chars around it,
  // wrap match in **...** for FE bold rendering.
  // If content is shorter than maxLen, return whole + wrap match.
  // If no match (rare — Prisma already filtered), return content[0..maxLen]+"..."

validateSearchInput(query: Record<string, string>): { ok, value } | { ok: false, error }
  // Centralize parsing of date strings, enum values, pagination bounds.
```

## 6. Schema changes

- Add `@@index([conversationId, sentAt])` to `Message` to speed up the common pattern: `WHERE conversation.orgId=X AND content ILIKE Y ORDER BY sentAt DESC`. Already have `@@index([zaloMsgId])` from feature 0001
- No new model

## 7. Frontend

**Route mới:** `/search` (link từ global search bar khi có >10 results — "Xem tất cả")

UI:
- Filter row: text input (q, debounce 300ms), date range picker, sender type chips, content type select, Zalo account select
- Table: avatar | snippet (innerHTML với bold) | sentAt | contact name | account
- Click row → `router.push('/chat?conversationId=<id>')`
- Pagination: prev/next + total count

> Simplification cho MVP: bỏ deep-link tới message anchor trong conversation. Chỉ select đúng conversation, sale tự scroll.

## 8. Acceptance Criteria

- [ ] **AC-0001:** GET với `q=test` → trả messages match, mỗi item có snippet
- [ ] **AC-0002:** `q=ab` (2 chars) → 200; `q=a` (1 char) → 400
- [ ] **AC-0003:** `senderType=contact` → không trả tin self
- [ ] **AC-0004:** `from=2026-01-01&to=2026-01-31` → chỉ tin trong khoảng đó
- [ ] **AC-0005:** `from` > `to` → 400
- [ ] **AC-0006:** Pagination `page=2&limit=10` → trả 10 row tiếp theo, `page` reflect đúng
- [ ] **AC-0007:** Member user không có ZaloAccountAccess → 200 nhưng results trống cho account không có quyền
- [ ] **AC-0008:** Cross-org isolation — message của org khác không leak
- [ ] **AC-0009:** Snippet bao đoạn match với `**` quanh keyword
- [ ] **AC-0010:** Build pass BE + FE, tests green

## 9. Test plan

### Unit
- `buildSnippet`: match đầu, match cuối, no match, content ngắn
- `validateSearchInput`: date parse, enum coerce, pagination bounds

### Integration
- Real Postgres + seed data
- All AC từ 0001-0008
- ACL: member with/without access
- Performance check (skip benchmark, chỉ smoke với 100 messages)

## 10. Out of scope

- Full-text search với tsvector / ranking (nếu DB scale > 1M rows mới cần)
- Search trong attachments metadata
- Saved searches / alerts
- Anchor scroll tới đúng message khi click (cần re-architect MessageThread)
