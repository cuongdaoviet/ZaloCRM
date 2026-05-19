# Feature 0013: Customer 360 view

## 1. Mô tả
Trang xem 360° của một khách hàng — tổng hợp toàn bộ thông tin của contact vào
một màn hình duy nhất để sales không phải nhảy giữa các tab. Bao gồm:
profile cơ bản, hội thoại gần nhất, danh sách đơn hàng + doanh thu, lịch hẹn
sắp tới + đã qua, ghi chú nội bộ, và activity timeline (từ 0012).

## 2. User Stories liên quan
- US-0013-1: Là sales, tôi muốn xem mọi thông tin về 1 khách trong 1 màn hình,
  để chuẩn bị nội dung trước khi gọi/chat.
- US-0013-2: Là quản lý, tôi muốn biết khách này đã mua bao nhiêu đơn, doanh
  thu trọn đời, để chấm priority.
- US-0013-3: Là sales, tôi muốn xem timeline mọi thao tác liên quan đến khách
  này (đổi status, đặt lịch, tạo đơn) để theo dõi mạch chăm sóc.

## 3. Business Rules
- BR-0001: Chỉ trả về contact thuộc đúng `orgId` của user. Cross-org → 404.
- BR-0002: Member chỉ xem được contact mà họ được `assignedUserId`, hoặc nếu
  có quyền `read` trên `zaloAccount` của conversation. Owner/admin xem tất.
- BR-0003: Endpoint là **read-only**, không thay đổi dữ liệu. Cập nhật profile
  vẫn đi qua `PUT /contacts/:id` cũ.
- BR-0004: Lifetime revenue chỉ tính các order có `status IN
  ('confirmed','paid','shipped','completed')` — loại `new` (chưa chốt) và
  `cancelled`.
- BR-0005: Conversation snippet trả về **tối đa 5 message gần nhất** từ
  conversation `lastMessageAt` mới nhất. Cắt content > 200 ký tự.
- BR-0006: Activity timeline filter theo `entityId = contact.id` HOẶC theo
  các order/appointment/note thuộc contact này. Trả 50 record gần nhất.

## 4. Input / Output

### GET /api/v1/contacts/:id/overview
- **Input:** `:id` (UUID)
- **Output 200:**
  ```json
  {
    "contact": {
      "id": "...",
      "fullName": "...",
      "phone": "...",
      "email": "...",
      "avatarUrl": "...",
      "source": "FB",
      "status": "interested",
      "tags": ["VIP", "Q2-warm"],
      "nextAppointment": "2026-05-21T09:00:00Z",
      "assignedUser": { "id": "...", "fullName": "..." } | null,
      "createdAt": "...",
      "firstContactDate": "..."
    },
    "stats": {
      "lifetimeRevenue": 12500000,
      "orderCount": 3,
      "completedOrderCount": 2,
      "appointmentCount": 5,
      "upcomingAppointmentCount": 1,
      "totalMessages": 47
    },
    "primaryConversation": {
      "id": "...",
      "zaloAccountId": "...",
      "lastMessageAt": "...",
      "unreadCount": 2,
      "recentMessages": [
        { "id": "...", "senderType": "contact", "content": "...", "sentAt": "..." }
      ]
    } | null,
    "orders": [
      { "id": "...", "orderCode": "ORD-001", "totalAmount": 500000,
        "status": "completed", "createdAt": "...",
        "createdBy": { "id": "...", "fullName": "..." } }
    ],
    "appointments": [
      { "id": "...", "appointmentDate": "...", "appointmentTime": "09:00",
        "status": "scheduled", "type": "consult",
        "assignedUser": { "id": "...", "fullName": "..." } | null }
    ],
    "notes": [
      { "id": "...", "content": "...", "createdAt": "...",
        "author": { "id": "...", "fullName": "..." } }
    ],
    "activity": [
      { "id": "...", "action": "order.created", "entityType": "order",
        "entityId": "...", "details": {}, "createdAt": "...",
        "user": { "id": "...", "fullName": "..." } | null }
    ]
  }
  ```
- **Error codes:**
  - 403: Member không có quyền xem contact này
  - 404: Contact không thuộc org, hoặc không tồn tại

## 5. Edge Cases
- Contact không có conversation: `primaryConversation = null`
- Contact không có order: `orders = []`, `lifetimeRevenue = 0`
- Contact có nhiều conversation: trả về conversation có `lastMessageAt` mới
  nhất (active nhất)
- `firstContactDate` null → giữ null, FE hiển thị "—"
- Member không assigned contact + không có read access nào trên zalo accounts
  liên quan → 403

## 6. Acceptance Criteria
- [ ] AC-0001: GET endpoint trả về đủ 6 section (contact/stats/conv/orders/appts/notes/activity)
- [ ] AC-0002: Cross-org → 404
- [ ] AC-0003: Member không assigned + không có zalo access → 403
- [ ] AC-0004: Member được assigned → 200
- [ ] AC-0005: Owner/admin → 200 cho mọi contact trong org
- [ ] AC-0006: `lifetimeRevenue` chỉ cộng status confirmed+
- [ ] AC-0007: `recentMessages` ≤ 5, sort sentAt DESC
- [ ] AC-0008: Orders sort createdAt DESC
- [ ] AC-0009: Activity filter đúng theo contact (entityId match)
- [ ] AC-0010: FE view tại `/contacts/:id` render đủ section + loading state

## 7. Dependencies
- Feature 0010 (Notes) — đọc bảng `conversation_notes`
- Feature 0011 (Orders) — đọc bảng `orders`
- Feature 0012 (Activity log) — đọc bảng `activity_logs`
- Feature 0007 (Appointments) — đọc bảng `appointments`
