# Mẫu Email Xác Thực Supabase Auth — ViRead

Thư mục này chứa 4 mẫu email HTML đóng khung theo đúng nhận diện thương hiệu **ViRead** (nền giấy kem `#fffaf0`, xanh ngọc `#087467`, khung thẻ bo góc, chữ `#233e40`, tương thích Gmail / Outlook / Apple Mail) để cấu hình trực tiếp trên **Supabase Dashboard**.

---

## 1. Danh sách 4 mẫu email & Tiêu đề đề xuất (Subject)

| Tệp mẫu | Mục trên Supabase Dashboard | Tiêu đề đề xuất (Subject heading) | Phong cách khung | Luồng kích hoạt trên ViRead |
| --- | --- | --- | --- | --- |
| `confirm-signup.html` | **Confirm signup** | `ViRead — Xác nhận email để bắt đầu hành trình đọc sách` | Xanh ngọc chào mừng (`#087467` / `#caf0df`) | Phụ huynh đăng ký tài khoản (`/register` → `/login?auth_callback=signup`) |
| `reset-password.html` | **Reset password** | `ViRead — Yêu cầu đặt lại mật khẩu tài khoản` | Hổ phách bảo mật (`#d97706` + `#f0b645` / `#fff3c4`) | Quên mật khẩu hoặc đặt lại từ Cài đặt (`/forgot-password`, `/settings` → `/reset-password`) |
| `change-email.html` | **Change email address** | `ViRead — Xác nhận thay đổi địa chỉ email` | Xanh bàn đọc xác minh (`#087467` + `#4a7c82` / `#e5f5f6`) | Đổi email hồ sơ phụ huynh hoặc admin cập nhật (`/profile` → `/auth/callback?next=/profile`) |
| `invite-user.html` | **Invite user** | `ViRead — Lời mời tham gia hành trình đọc sách cùng bé` | Bạc hà + vàng hân hoan (`#087467` + `#f0b645` / `#d9f4eb`) | Quản trị viên mời phụ huynh mới (`admin.invite_user_by_email` → Site URL) |

---

## 2. Hướng dẫn áp dụng trên Supabase Dashboard

1. Đăng nhập **Supabase Dashboard** và chọn đúng project của **ViRead**.
2. Ở thanh điều hướng bên trái, vào **`Authentication` -> `Email Templates`** *(trên một số phiên bản Supabase Studio mới hơn nằm tại `Authentication` -> `Notifications` -> `Email`)*.
3. Lần lượt chọn từng tab tương ứng:
   - **Confirm signup** ← dán nội dung từ `supabase/templates/confirm-signup.html`
   - **Reset password** ← dán nội dung từ `supabase/templates/reset-password.html`
   - **Change email address** ← dán nội dung từ `supabase/templates/change-email.html`
   - **Invite user** ← dán nội dung từ `supabase/templates/invite-user.html`
4. Với mỗi tab:
   - Cập nhật ô **Subject heading** bằng tiêu đề tiếng Việt tương ứng ở bảng mục 1.
   - Xóa toàn bộ HTML mặc định trong ô **Message (Body)** và dán nguyên văn nội dung tệp `.html` tương ứng.
   - Nhấn **Save** và kiểm tra trước trong khung xem trước (Preview) hoặc gửi thử ở môi trường staging.
5. Kiểm tra bổ sung tại **`Authentication` -> `URL Configuration`**:
   - Đảm bảo **Site URL** trỏ đúng tên miền frontend ViRead (ví dụ `https://viread-frontend.vercel.app`).
   - Đảm bảo **Redirect URLs** đã cho phép các đường dẫn callback của ViRead (`/login`, `/reset-password`, `/auth/callback`, `/profile`).

---

## 3. Checklist biến Go Template (`html/template`)

Tất cả 4 tệp đều tuân thủ nghiêm ngặt kiến trúc xác thực hiện tại của ViRead:

- [x] **Bắt buộc dùng `{{ .ConfirmationURL }}`** cho cả nút CTA chính và đường dẫn sao chép dự phòng bên dưới.
  - **Không dùng** `/auth/confirm`, **không dùng** `{{ .TokenHash }}`, và **không thêm** khung mã OTP `{{ .Token }}` (ViRead không có tuyến `/auth/confirm` hay màn hình nhập mã OTP; luồng xác thực đi qua `/auth/v1/verify` của Supabase).
- [x] **Bảo vệ an toàn trường tùy chọn `display_name`**:
  - Luôn dùng `{{ if .Data.display_name }}{{ .Data.display_name }}{{ else }}ba mẹ{{ end }}` để xử lý mượt tài khoản cũ hoặc tài khoản OAuth chưa có `display_name`.
- [x] **Bảo vệ an toàn `{{ .NewEmail }}` trong `change-email.html`**:
  - Hiển thị `{{ .Email }}` kèm khối có điều kiện `{{ if .NewEmail }} → {{ .NewEmail }}{{ end }}` để tránh khoảng trống hoặc mũi tên thừa khi biến không được truyền.
- [x] **Bảo vệ an toàn `{{ .SiteURL }}` ở chân trang**:
  - Bọc trong `{{ if .SiteURL }}...{{ end }}`.
- [x] **Cân bằng cú pháp Go template**:
  - Mọi khối `{{ if ... }}` đều có `{{ end }}` tương ứng; không có thẻ Go template nằm trong chú thích HTML.

---

## 4. Tiêu chuẩn kỹ thuật Email đã tích hợp sẵn

- **Thuần HTML Table + Inline CSS**, có khung bao `<!--[if mso]>...<![endif]-->` cố định `600px` cho Microsoft Outlook desktop.
- **Thuộc tính ngôn ngữ & hướng viết**: `lang="vi" dir="ltr"` trên cả `<html>` lẫn bảng ngoài cùng.
- **Preheader ẩn** với chuỗi `&zwnj;&nbsp;` chống lộ văn bản thừa trong danh sách hộp thư đến.
- **Biểu trưng thương hiệu tự chứa (zero broken images)**: Ô `32×32` bo góc `#d9f4eb` chữ `V` + wordmark `ViRead` `#087467`, **không `<svg>`**, **không `data:image/`**, **không tài nguyên `localhost` hay ảnh ngoài**.
- **Chống tràn khung trên di động**: `table-layout:fixed; word-break:break-word; overflow-wrap:anywhere;` cho email dài và `word-break:break-all;` cho liên kết dự phòng `{{ .ConfirmationURL }}`.
- **Dung lượng gọn nhẹ**: mỗi tệp đều dưới `25 KiB` (tránh Gmail cắt bớt nội dung email).
