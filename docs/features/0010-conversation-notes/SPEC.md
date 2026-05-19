# Feature 0010: Conversation notes

## 1. Mô tả

Sale cần ghi chú nội bộ về 1 cuộc trò chuyện (vd: "khách thích chào lúc 7h sáng", "đã gửi voucher V123") mà khách không thấy. Hiện tại CRM chỉ có `Contact.notes` chung cho mọi conversation, không tracked theo timestamp + user.

Feature này thêm:
1. **Model `ConversationNote`** — gắn với 1 conversation, có timestamp + author
2. **API CRUD** ghi chú theo conversation
3. **Tab "Ghi chú" trong contact panel** (ChatContactPanel)

## 2. User Stories

- **US-0001:** Sale ghi nhanh "đã gửi voucher V123" sau khi gửi → xuất hiện trong panel với timestamp + tên người tạo
- **US-0002:** Tin sale khác làm overlap → xem ghi chú gần nhất biết customer history
- **US-0003:** Sửa/xoá note của chính mình. Admin có thể sửa/xoá mọi note

## 3. Business Rules

- **BR-0001:** Note org-scoped qua conversation
- **BR-0002:** Mọi member với access read trở lên trên Zalo account của conv được phép xem note
- **BR-0003:** Create/update note: user phải có access `chat` trên Zalo account. Owner/admin bypass
- **BR-0004:** Update/delete: chỉ author hoặc admin/owner
- **BR-0005:** Content 1-2000 chars
- **BR-0006:** Note hiển thị sắp xếp theo `createdAt DESC` (mới nhất đầu)

## 4. Schema

```prisma
model ConversationNote {
  id             String   @id @default(uuid())
  conversationId String   @map("conversation_id")
  authorId       String   @map("author_id")
  content        String
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  author       User         @relation("ConversationNotes", fields: [authorId], references: [id])

  @@index([conversationId, createdAt(sort: Desc)])
  @@map("conversation_notes")
}
```

Update Conversation + User reverse relations.

## 5. API

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/v1/conversations/:id/notes` | requireZaloAccess('read') |
| POST | `/api/v1/conversations/:id/notes` | requireZaloAccess('chat') |
| PUT | `/api/v1/conversations/notes/:noteId` | author OR admin |
| DELETE | `/api/v1/conversations/notes/:noteId` | author OR admin |

Body for POST/PUT: `{content: "..."}`. Returns note with author info.

## 6. Frontend

Trong `ChatContactPanel`, thêm tab/section "Ghi chú nội bộ":
- List notes mới nhất trước, mỗi note: avatar + tên author + timestamp + content + actions (edit/delete nếu là author hoặc admin)
- Form thêm note ở dưới (textarea + button "Thêm")
- Inline edit khi bấm icon edit

## 7. Acceptance Criteria

- [ ] **AC-0001:** Sale với access chat tạo note → 201, list refresh
- [ ] **AC-0002:** Member không access → 403 cả GET và POST
- [ ] **AC-0003:** Sale A tạo note → sale B (cùng access) thấy được nhưng không edit được
- [ ] **AC-0004:** Admin sửa note của member khác → OK
- [ ] **AC-0005:** Content quá dài (>2000) → 400
- [ ] **AC-0006:** Cross-org isolation
- [ ] **AC-0007:** Notes sắp xếp DESC
- [ ] **AC-0008:** Build pass

## 8. Test plan

- Unit: validateNoteInput (1-2000 chars)
- Integration: full CRUD + permission gradient + cross-org

## 9. Out of scope

- @mention notification trong note
- File attachment trong note (chỉ text)
- Pin note quan trọng lên đầu
- Edit history (chỉ updatedAt)
