# Hướng dẫn sử dụng ZaloCRM

## Mục lục

1. [Đăng nhập](#1-đăng-nhập)
2. [Kết nối Zalo](#2-kết-nối-zalo)
3. [Chat với khách hàng](#3-chat-với-khách-hàng)
4. [Tin nhắn mẫu (Quick replies)](#4-tin-nhắn-mẫu-quick-replies)
5. [Auto-reply ngoài giờ](#5-auto-reply-ngoài-giờ)
6. [Tìm kiếm tin nhắn](#6-tìm-kiếm-tin-nhắn)
7. [Quản lý khách hàng](#7-quản-lý-khách-hàng)
8. [Lịch hẹn](#8-lịch-hẹn)
9. [Dashboard & Báo cáo](#9-dashboard--báo-cáo)
10. [KPI & Leaderboard (admin/owner)](#10-kpi--leaderboard-adminowner)
11. [Quản lý nhân viên](#11-quản-lý-nhân-viên)
12. [API & Webhook](#12-api--webhook)
13. [Câu hỏi thường gặp](#13-câu-hỏi-thường-gặp)
14. [Quy tắc quan trọng](#14-quy-tắc-quan-trọng)

---

## 1. Đăng nhập

1. Mở trình duyệt → vào địa chỉ hệ thống
2. Nhập **Email** và **Mật khẩu** → nhấn **Đăng nhập**
3. Chọn theme tối/sáng bằng biểu tượng ☀️/🌙 trên thanh trên cùng

---

## 2. Kết nối Zalo

### Thêm tài khoản Zalo

1. Vào menu **Tài khoản Zalo**
2. Nhấn **Thêm Zalo** → đặt tên (VD: "Sale Hương")
3. Nhấn biểu tượng **QR** → mã QR hiện trên màn hình
4. Mở **Zalo trên điện thoại** → quét mã QR
5. Xác nhận trên điện thoại → trạng thái chuyển sang **Đã kết nối** (xanh)

### Đồng bộ danh bạ

- Nhấn biểu tượng **đồng bộ** (👥↻) bên cạnh tài khoản
- Tất cả bạn bè Zalo sẽ được nhập vào danh sách Khách hàng

### Phân quyền truy cập

- Nhấn biểu tượng **khiên** (🛡️) → chọn nhân viên + quyền
- **Xem:** chỉ xem tin nhắn
- **Chat:** được phép gửi tin nhắn
- **Quản lý:** toàn quyền trên tài khoản Zalo này

> ⚠️ **Lưu ý:** KHÔNG mở Zalo Web trên trình duyệt khi đang dùng hệ thống

---

## 3. Chat với khách hàng

> ⚠️ **Lưu ý quan trọng:** Cuộc trò chuyện **chỉ xuất hiện** sau khi khách hàng nhắn tin tới Zalo của bạn, hoặc khi bạn tự gửi tin cho khách từ **app Zalo trên điện thoại**. Hệ thống không tự động load lịch sử hội thoại cũ khi thêm tài khoản Zalo mới, và **không có nút "Tạo cuộc trò chuyện mới"** ở giao diện web. Để chủ động liên hệ khách lần đầu, hãy nhắn từ điện thoại — tin nhắn sẽ tự đồng bộ về CRM.

### Giao diện

Giao diện chat chia 3 cột (kéo thả để thay đổi kích thước):

| Cột trái | Cột giữa | Cột phải |
|----------|----------|----------|
| Danh sách hội thoại | Nội dung tin nhắn | Thông tin khách hàng |
| Lọc theo Zalo | Gửi tin nhắn | Lưu thông tin CRM |
| Tìm kiếm | Xem ảnh/file | Lịch hẹn + Đơn hàng |

### Gửi tin nhắn

1. Chọn cuộc trò chuyện bên trái
2. Gõ tin nhắn vào ô dưới cùng
3. Nhấn **Enter** để gửi
4. **Shift + Enter** = xuống dòng

### Gửi ảnh và file đính kèm

1. Click biểu tượng **📎** (paperclip) bên trái ô nhập tin → chọn ảnh/file từ máy tính
2. **Hoặc** kéo-thả file thẳng vào khung chat
3. Preview hiện ngay phía trên ô nhập (ảnh: thumbnail; file: card với tên + size)
4. Bấm **biểu tượng gửi** → file được đẩy lên Zalo

**Loại tệp được hỗ trợ:** JPG, PNG, GIF, WebP, PDF, Word/Excel/PowerPoint, CSV, TXT, ZIP. **Tối đa 20MB/file.**

> ℹ️ Sticker, tin nhắn thoại, và video clip ghi từ trình duyệt chưa hỗ trợ — vẫn cần dùng app Zalo trên điện thoại.

### Xem ảnh và file

- **Ảnh:** hiển thị trực tiếp → nhấn để phóng to
- **File/PDF:** hiện thẻ tên file + dung lượng → nhấn để tải
- **Sticker / Video / Voice / GIF:** hiển thị placeholder (🏷️ / 🎥 / 🎤 / GIF)
- **Link:** hiện thẻ với tiêu đề + 🔗
- **Nhắc hẹn Zalo:** hiện thẻ 📅 với thời gian → nhấn **Đồng bộ lịch** để tự tạo lịch hẹn trong CRM

### Lọc theo Zalo

- Ở đầu danh sách hội thoại → chọn **tên Zalo cụ thể**
- Chọn "Tất cả Zalo" để xem toàn bộ

### Cập nhật thông tin khách hàng

1. Nhấn biểu tượng **👤** (góc phải header chat) → panel thông tin mở ra
2. Điền: Họ tên, SĐT, Email, Nguồn, Trạng thái, Ngày tiếp nhận, **Hẹn tái khám**, Ghi chú, Tags
3. Nhấn **Lưu thông tin**
4. Dữ liệu tự động đồng bộ sang tab **Khách hàng**

### Tạo lịch hẹn từ chat

1. Trong panel thông tin → mục **Lịch hẹn**
2. Nhấn **+** → điền ngày, giờ, ghi chú → **Tạo lịch hẹn**

### Tạo đơn hàng từ chat

1. Trong panel thông tin → cuộn xuống mục **Đơn hàng**
2. Nhấn **+** → điền mã đơn, tổng tiền, trạng thái, ghi chú → **Tạo đơn hàng**
3. Đơn hàng được gắn với cả **khách hàng** lẫn **cuộc trò chuyện** hiện tại, hiện thị đồng thời ở tab **Đơn hàng** và **Khách hàng**

### Bắt đầu chat mới với khách hàng

1. Trong cột trái của trang **Tin nhắn**, bấm **"Chat mới với khách hàng"** (nút màu xanh trên cùng)
2. Dialog hiện ra → chọn **Tài khoản Zalo** (chỉ list account đang kết nối) → chọn **Khách hàng** (chỉ contact đã sync Zalo UID)
3. Bấm **Bắt đầu** → cuộc trò chuyện mới xuất hiện ngay đầu danh sách + tự được chọn

> 💡 Nếu autocomplete không tìm thấy khách hàng, vào **Tài khoản Zalo** → bấm icon **đồng bộ danh bạ** (👥) để sync. Hệ thống chỉ cho chat mới với contact đã có Zalo UID.

### Đồng bộ lịch sử nhóm chat

Khi mới thêm 1 tài khoản Zalo có sẵn nhiều nhóm, lịch sử cũ **chưa** xuất hiện trong CRM. Để load:

1. Vào **Tài khoản Zalo** (chỉ admin/owner)
2. Bấm icon **lịch sử** (📜 màu vàng) ở dòng tài khoản → dialog hiện ra
3. Nhập **Group ID** (bỏ trống = sync TẤT CẢ nhóm) + **số tin / nhóm** (1-200, mặc định 50)
4. Bấm **Đồng bộ** → kết quả hiện inline (`inserted: X, skipped: Y`)

> ⚠️ Tin nhắn 1-1 (chat cá nhân) **không thể** sync lịch sử cũ — Zalo API không hỗ trợ. Tin nhắn mới đến từ thời điểm kết nối trở đi sẽ được lưu bình thường.

### Tự bù tin nhắn offline

Khi server CRM tạm dừng (vd: restart) và khách nhắn tin trong thời gian đó, sau khi server kết nối lại Zalo sẽ **tự đẩy lại** các tin đã miss → CRM lưu vào DB. Không cần thao tác thủ công.

---

## 4. Tin nhắn mẫu (Quick replies)

Sale thường gửi đi gửi lại các tin chuẩn (chào, gửi giá, hỏi địa chỉ giao hàng). Tin nhắn mẫu cho phép lưu và dùng nhanh bằng slash command.

### Tạo tin nhắn mẫu

1. Vào menu **Tin nhắn mẫu** → bấm **Tạo tin mẫu**
2. Điền:
   - **Shortcut**: 2-20 ký tự, chỉ chữ thường + số + `-` `_` (vd: `chao`, `gia_vp_5pcs`)
   - **Nội dung**: tin nhắn (tối đa 2000 ký tự). Có thể chèn placeholder `{{contactName}}`, `{{firstName}}`
   - **Phạm vi** (admin/owner mới chọn được):
     - **Cá nhân** — chỉ bạn dùng
     - **Cả tổ chức** — toàn team thấy + dùng
3. Bấm **Lưu**

### Dùng trong chat

1. Mở 1 cuộc trò chuyện
2. Ở ô gõ tin nhắn, gõ **`/`** ở đầu dòng → popover hiện danh sách tin mẫu
3. Gõ tiếp shortcut để filter (vd: `/chao` → chỉ hiện tin có shortcut bắt đầu `chao`)
4. **Mũi tên ↑/↓** để chọn, **Enter** hoặc **Tab** để chèn, **Esc** để đóng
5. Placeholder tự thay thế: `{{contactName}}` → tên đầy đủ khách hàng, `{{firstName}}` → tên đầu (split theo dấu cách)

> 💡 Bạn có thể chỉnh sửa tin sau khi chèn trước khi bấm gửi.

### Quyền

- **Member**: chỉ tạo template cá nhân, chỉ sửa/xoá template của chính mình
- **Admin/Owner**: tạo cả 2 scope, sửa/xoá mọi template trong org

---

## 5. Auto-reply ngoài giờ

Cấu hình cho từng tài khoản Zalo: ngoài giờ làm việc, tự reply 1 tin định sẵn khi khách nhắn.

### Cấu hình

1. Vào **Tài khoản Zalo** → bấm icon **mdi-message-reply-text-outline** (màu tím) — chỉ admin/owner thấy
2. Dialog mở:
   - **Bật auto-reply** — toggle on/off (có thể tạm tắt mà không xoá rule)
   - **Ngày làm việc** — bấm các chip để chọn ngày (mặc định T2-T6). Trong giờ làm việc các ngày này → KHÔNG auto-reply
   - **Giờ bắt đầu / kết thúc** — định nghĩa khung giờ làm việc (mặc định 8:00-18:00)
   - **Múi giờ** — mặc định `Asia/Ho_Chi_Minh`
   - **Nội dung auto-reply** — hỗ trợ placeholder như tin nhắn mẫu
   - **Cooldown (phút)** — không gửi lại cho cùng 1 khách trong khoảng này (mặc định 240 = 4 giờ)
3. Bấm **Lưu**

### Quy tắc trigger

Auto-reply **chỉ gửi** khi tất cả điều kiện sau đúng:

- ✅ Rule đang bật
- ✅ Tin nhắn từ khách (không phải bạn tự gửi)
- ✅ Cuộc trò chuyện 1-1 (KHÔNG áp dụng cho group)
- ✅ Hiện tại NGOÀI khung giờ làm việc đã cấu hình
- ✅ Chưa từng auto-reply cho khách này trong cooldown
- ✅ Bạn chưa tự reply trong 5 phút gần đây (nếu vừa reply → hệ thống coi như bạn đang active, skip)

> 💡 Khi rule trigger, tin auto-reply **vẫn đếm** vào limit 200 tin/ngày để tránh block Zalo.

### Xoá rule

Bấm **Xoá rule** ở góc trái dưới dialog. Lịch sử cooldown cũng được xoá theo.

---

## 6. Tìm kiếm tin nhắn

Vào menu **Tìm tin nhắn** (`/search`) để tra cứu chính xác trong toàn bộ message đã lưu.

### Filter

- **Từ khoá**: tối thiểu 2 ký tự, case-insensitive
- **Từ ngày / Đến ngày**: lọc theo khoảng thời gian
- **Người gửi**: "Từ khách" hoặc "Bạn gửi" (bỏ trống = cả hai)
- **Loại tin**: Văn bản / Ảnh / File / Sticker / Link

### Kết quả

- Avatar khách + tên + thời gian + chip "Bạn gửi" (nếu là tin tự gửi)
- **Snippet** — đoạn trích chứa từ khoá, từ khoá được **bôi vàng** để dễ thấy
- Bấm vào dòng → mở `/chat` và chọn đúng cuộc trò chuyện đó

### Pagination

- Mặc định 30 kết quả / trang
- Mũi tên ◀ ▶ ở góc phải để qua trang

### Quyền

- **Member**: chỉ thấy tin của Zalo account có quyền `read` trở lên
- **Admin/Owner**: thấy toàn org

---

## 7. Quản lý khách hàng

Vào menu **Khách hàng**

### Xem danh sách

- Bảng hiển thị: Tên, SĐT, Email, Nguồn, Trạng thái, Ngày tiếp nhận
- **Tìm kiếm:** gõ tên hoặc SĐT
- **Lọc:** chọn Nguồn hoặc Trạng thái

### Pipeline khách hàng

| Trạng thái | Ý nghĩa | Màu |
|-----------|---------|-----|
| **Mới** | Khách hàng mới, chưa liên hệ | Xám |
| **Đã liên hệ** | Đã liên hệ lần đầu | Xanh dương |
| **Quan tâm** | Khách quan tâm sản phẩm/dịch vụ | Cam |
| **Chuyển đổi** | Đã mua/sử dụng dịch vụ | Xanh lá |
| **Mất** | Không còn quan tâm | Đỏ |

### Thêm khách hàng

1. Nhấn **Thêm KH** → điền thông tin → **Lưu**

### Sửa thông tin

1. Nhấn vào dòng khách hàng → dialog chi tiết mở ra
2. Sửa bất kỳ trường nào → **Lưu**

---

## 8. Lịch hẹn

Vào menu **Lịch hẹn**

### 3 tab xem

| Tab | Hiển thị |
|-----|---------|
| **Hôm nay** | Lịch hẹn trong ngày |
| **Sắp tới** | 7 ngày tiếp theo |
| **Tất cả** | Toàn bộ lịch hẹn |

### Tạo lịch hẹn

1. Nhấn **Tạo lịch hẹn**
2. Chọn khách hàng, ngày, giờ, loại
3. Ghi chú (nếu có) → **Tạo**

### Cập nhật nhanh

| Nút | Hành động |
|-----|----------|
| ✅ | Đánh dấu **Hoàn thành** |
| ❌ | **Huỷ** lịch hẹn |
| ✏️ | Sửa ngày/giờ/ghi chú |

### Nhắc nhở tự động

- Hệ thống tự kiểm tra lịch hẹn **ngày mai** lúc 8:00 sáng
- Thông báo hiện trong chuông 🔔 trên thanh trên cùng

---

## 9. Dashboard & Báo cáo

### Dashboard (trang chủ)

6 ô thống kê:
- Tin nhắn hôm nay | Chưa trả lời | Chưa đọc
- Lịch hẹn hôm nay | Khách mới tuần này | Tổng khách hàng

Biểu đồ:
- Tin nhắn gửi/nhận theo ngày (30 ngày)
- Pipeline khách hàng (biểu đồ tròn)
- Nguồn khách hàng (biểu đồ tròn)

### Báo cáo

1. Vào menu **Báo cáo**
2. Chọn **khoảng thời gian** (từ ngày – đến ngày)
3. Chọn tab: **Tin nhắn** / **Khách hàng** / **Lịch hẹn**
4. Nhấn **Xuất Excel** → tải file .xlsx về máy

---

## 10. KPI & Leaderboard (admin/owner)

Vào menu **KPI & Leaderboard** (chỉ admin/owner thấy trong sidebar).

### Date range

Chọn từ dropdown trên cùng:
- **Hôm nay / Hôm qua / 7 ngày qua / 30 ngày qua** — preset thường dùng
- **Tháng này / Tháng trước** — đầy đủ tháng
- **Tuỳ chọn…** — chọn từ ngày + đến ngày (tối đa 365 ngày)

### KPI cards (6 chỉ số)

Mỗi card hiện:
- **Giá trị kỳ này** — formatted (đ cho doanh thu, số đếm cho phần còn lại)
- **% thay đổi so với kỳ trước** — chip xanh khi tăng, đỏ khi giảm, xám khi không có data kỳ trước
- 6 cards: Doanh thu / Số đơn / Khách mới / KH chuyển đổi / Tin nhắn gửi / Tin nhắn nhận

> 💡 **Doanh thu** chỉ tính đơn có status `paid`, `shipped`, hoặc `completed` — đơn `new`/`confirmed`/`cancelled` không tính.
> 💡 **Tin nhắn gửi** loại trừ auto-reply (chỉ tính tin có nhân viên gửi).

### Leaderboard

Bảng xếp hạng nhân viên với 4 tab:
- **Doanh thu** — sale nào chốt được nhiều tiền nhất
- **Số đơn** — sale nào tạo nhiều đơn nhất
- **Tin gửi** — sale nào reply nhiều nhất
- **KH mới** — sale nào nhận về nhiều contact mới nhất (theo `assigned_user_id`)

Chuyển tab → chỉ bảng dưới reload, KPI cards trên giữ nguyên.

### Khi không có data

- Kỳ trước = 0 → delta hiện "—" thay vì "+∞"
- Range không có activity → cards = 0, leaderboard hiện "Không có dữ liệu cho khoảng này"

---

## 11. Quản lý nhân viên

Vào menu **Nhân viên** (chỉ Admin/Owner)

### Vai trò

| Vai trò | Quyền |
|---------|-------|
| **Owner** | Toàn quyền, quản lý admin |
| **Admin** | Quản lý nhân viên, Zalo, khách hàng |
| **Member** | Chỉ xem Zalo được phân quyền |

### Thêm nhân viên

1. Tab **Nhân viên** → nhấn **Thêm nhân viên**
2. Nhập: Email, Họ tên, Mật khẩu, Vai trò → **Tạo**

### Đội nhóm

1. Tab **Đội nhóm** → **Thêm đội nhóm** → đặt tên
2. Mở rộng đội nhóm → **Thêm thành viên**

---

## 12. API & Webhook

Dành cho lập trình viên muốn tích hợp ZaloCRM với hệ thống khác.

### Tạo API Key

1. Vào menu **API & Webhook**
2. Nhấn **Tạo key mới** → copy API key
3. Sử dụng trong header: `X-API-Key: your-key`

### Cấu hình Webhook

1. Nhập **Webhook URL** (địa chỉ server nhận thông báo)
2. Nhập **Secret** (mã bí mật để xác thực)
3. Nhấn **Lưu** → nhấn **Test Webhook** để kiểm tra

### Ví dụ sử dụng API

```bash
# Lấy danh sách khách hàng
curl -H "X-API-Key: your-key" https://your-domain/api/public/contacts

# Tạo khách hàng mới
curl -X POST -H "X-API-Key: your-key" -H "Content-Type: application/json" \
  -d '{"fullName":"Nguyễn Văn A","phone":"0901234567","source":"FB"}' \
  https://your-domain/api/public/contacts

# Gửi tin nhắn
curl -X POST -H "X-API-Key: your-key" -H "Content-Type: application/json" \
  -d '{"zaloAccountId":"abc","threadId":"xyz","content":"Xin chào!","threadType":0}' \
  https://your-domain/api/public/messages/send
```

---

## 13. Câu hỏi thường gặp

### "Zalo bị ngắt kết nối?"

Hệ thống tự kết nối lại trong 30 giây. Nếu không được → vào **Tài khoản Zalo** → quét QR lại.

### "Tin nhắn không gửi được?"

Kiểm tra trạng thái Zalo (phải xanh lá). Nếu hiện "Gửi quá nhanh" → đợi 30 giây.

### "Không thấy tin nhắn cũ?"

Hệ thống chỉ lưu tin nhắn từ lúc kết nối Zalo. Tin nhắn trước đó không có.

### "Lịch hẹn bị trùng?"

Hệ thống tự phát hiện — nếu cùng khách hàng + cùng ngày → báo lỗi.

### "Quên mật khẩu?"

Liên hệ Admin/Owner để reset mật khẩu trong **Cài đặt → Nhân viên**.

---

## 14. Quy tắc quan trọng

### ❌ KHÔNG làm

1. **KHÔNG mở Zalo Web** trên trình duyệt khi dùng hệ thống
2. **KHÔNG gửi tin spam** (cùng nội dung cho nhiều người)
3. **KHÔNG gửi tin cho người lạ** (không phải bạn bè Zalo)
4. **KHÔNG gửi quá 200 tin/ngày** trên 1 tài khoản Zalo
5. **KHÔNG chia sẻ mật khẩu** cho người khác

### ✅ NÊN làm

1. **Cập nhật thông tin** khách hàng đầy đủ (SĐT, trạng thái)
2. **Trả lời tin nhắn** trong vòng 30 phút
3. **Ghi chú lịch hẹn** ngay khi hẹn khách
4. **Đồng bộ danh bạ** Zalo khi thêm bạn mới
5. **Kiểm tra Dashboard** mỗi sáng
