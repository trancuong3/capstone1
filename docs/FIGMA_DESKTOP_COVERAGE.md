# ViRead · Đối chiếu Figma desktop

Nguồn: trang `00 · Giao diện Web & Mobile`, node `2:6`, file ReadAlong Vision (`gfqkWdrUEBr63jpJUS27eP`). Phạm vi ở đây chỉ gồm **85 frame có tên `Web · …`**, tất cả rộng 1440 px. Không dùng frame mobile.

Mỗi dòng là một khung hoặc trạng thái riêng. Nhiều dòng có thể dùng chung route; trạng thái ghi rõ biến thể cần xuất hiện trong màn đó. Bảng này là danh sách kiểm tra thực tế, không gộp các hộp thoại, lỗi, tải, rỗng và thành công thành một mục.

## 01 · Tài khoản (12)

| Figma ID   | Frame                                 | Route              | Thành phần                                            | Trạng thái                | Mức rà soát          |
| ---------- | ------------------------------------- | ------------------ | ----------------------------------------------------- | ------------------------- | -------------------- |
| `22:28`    | Đăng nhập                             | `/login`           | `login-screen.tsx · login-form.tsx`                   | Đăng nhập mặc định        | Ảnh Figma + mã nguồn |
| `78:447`   | Đăng ký tài khoản                     | `/register`        | `register-screen.tsx · register-form.tsx`             | Tạo tài khoản             | Ảnh Figma + mã nguồn |
| `82:474`   | Quên mật khẩu                         | `/forgot-password` | `forgot-password-screen.tsx`                          | Yêu cầu khôi phục         | Ảnh Figma + mã nguồn |
| `83:487`   | Kiểm tra email khôi phục              | `/forgot-password` | `forgot-password-screen.tsx`                          | Đã gửi email khôi phục    | Ảnh Figma + mã nguồn |
| `108:156`  | Đặt mật khẩu mới                      | `/reset-password`  | `reset-password-screen.tsx · reset-password-form.tsx` | Đặt mật khẩu              | Ảnh Figma + mã nguồn |
| `108:175`  | Đổi mật khẩu thành công               | `/reset-password`  | `reset-password-screen.tsx`                           | Đổi mật khẩu thành công   | Ảnh Figma + mã nguồn |
| `227:2392` | Xác nhận email đăng ký                | `/register`        | `register-screen.tsx`                                 | Xác nhận email đăng ký    | Ảnh Figma + mã nguồn |
| `112:173`  | Gửi lại email khôi phục               | `/forgot-password` | `forgot-password-screen.tsx`                          | Đã gửi lại hướng dẫn      | Ảnh Figma + mã nguồn |
| `245:4604` | Liên kết không hợp lệ                 | `/reset-password`  | `reset-password-screen.tsx`                           | Liên kết không hợp lệ     | Ảnh Figma + mã nguồn |
| `245:4639` | Liên kết đã hết hạn                   | `/reset-password`  | `reset-password-screen.tsx`                           | Liên kết hết hạn          | Ảnh Figma + mã nguồn |
| `245:4674` | Thông tin đăng nhập không đúng        | `/login`           | `login-screen.tsx · login-form.tsx`                   | Sai thông tin đăng nhập   | Ảnh Figma + mã nguồn |
| `245:4729` | Đăng nhập mạng xã hội chưa thành công | `/login`           | `login-screen.tsx · login-form.tsx`                   | Đăng nhập mạng xã hội lỗi | Ảnh Figma + mã nguồn |

## 02 · Ba mẹ · Hồ sơ, thói quen và báo cáo (20)

| Figma ID   | Frame                   | Route                      | Thành phần                                          | Trạng thái              | Mức rà soát          |
| ---------- | ----------------------- | -------------------------- | --------------------------------------------------- | ----------------------- | -------------------- |
| `21:2`     | Tổng quan               | `/dashboard`               | `dashboard-screen.tsx`                              | Tổng quan               | Ảnh Figma + mã nguồn |
| `23:117`   | Hồ sơ các bé            | `/children`                | `children-list-screen.tsx`                          | Danh sách hồ sơ bé      | Ảnh Figma + mã nguồn |
| `23:216`   | Tạo hồ sơ bé            | `/children/new`            | `child-profile-screen.tsx · child-profile-form.tsx` | Tạo hồ sơ bé            | Ảnh Figma + mã nguồn |
| `233:3036` | Chỉnh sửa hồ sơ bé      | `/children/:childId`       | `child-profile-screen.tsx · child-profile-form.tsx` | Chỉnh sửa hồ sơ bé      | Ảnh Figma + mã nguồn |
| `233:3100` | Thông tin tài khoản     | `/profile`                 | `parent-profile-screen.tsx`                         | Thông tin tài khoản     | Ảnh Figma + mã nguồn |
| `233:3186` | Chỉnh sửa hồ sơ ba mẹ   | `/profile`                 | `parent-profile-form.tsx`                           | Chỉnh sửa hồ sơ ba mẹ   | Ảnh Figma + mã nguồn |
| `234:2628` | Quản lý đọc sách        | `/reading-management`      | `reading-management-screen.tsx`                     | Tổng quan quản lý đọc   | Ảnh Figma + mã nguồn |
| `234:2840` | Cài đặt tài khoản       | `/settings`                | `account-settings-screen.tsx`                       | Cài đặt tài khoản       | Ảnh Figma + mã nguồn |
| `234:2926` | Trợ giúp và hỗ trợ      | `/help-support`            | `help-support-screen.tsx`                           | Trợ giúp và hỗ trợ      | Ảnh Figma + mã nguồn |
| `23:147`   | Tiến bộ của bé          | `/reports`                 | `progress-report-screen.tsx`                        | Tiến bộ của bé          | Ảnh Figma + mã nguồn |
| `237:3233` | Lịch sử buổi đọc        | `/sessions`                | `session-history-screen.tsx`                        | Lịch sử buổi đọc        | Ảnh Figma + mã nguồn |
| `23:185`   | Chi tiết buổi đọc       | `/sessions/:sessionId`     | `session-detail-screen.tsx`                         | Chi tiết buổi đọc       | Ảnh Figma + mã nguồn |
| `23:84`    | Từ cần luyện            | `/reports/difficult-words` | `difficult-words-screen.tsx`                        | Từ cần luyện            | Ảnh Figma + mã nguồn |
| `245:5244` | Menu tài khoản          | `/dashboard`               | `account-avatar-menu.tsx · app-shell.tsx`           | Menu tài khoản mở       | Ảnh Figma + mã nguồn |
| `245:5159` | Gửi phản hồi thành công | `/help-support`            | `help-support-screen.tsx`                           | Gửi phản hồi thành công | Ảnh Figma + mã nguồn |
| `55:358`   | Gợi ý luyện tập         | `/reports/difficult-words` | `difficult-words-screen.tsx`                        | Gợi ý luyện tập         | Ảnh Figma + mã nguồn |
| `246:5959` | Chưa có báo cáo         | `/reports`                 | `progress-report-screen.tsx`                        | Chưa có báo cáo         | Ảnh Figma + mã nguồn |
| `246:6011` | Chưa có hồ sơ bé        | `/dashboard`               | `dashboard-screen.tsx`                              | Chưa có hồ sơ bé        | Ảnh Figma + mã nguồn |
| `246:6115` | Chưa tải được dữ liệu   | `/dashboard`               | `dashboard-screen.tsx`                              | Lỗi tải dữ liệu         | Ảnh Figma + mã nguồn |
| `246:6169` | Đang tải dữ liệu        | `/dashboard`               | `dashboard-screen.tsx`                              | Đang tải dữ liệu        | Ảnh Figma + mã nguồn |

## 03 · Sách và buổi đọc (22)

| Figma ID   | Frame                          | Route                         | Thành phần                                       | Trạng thái                     | Mức rà soát          |
| ---------- | ------------------------------ | ----------------------------- | ------------------------------------------------ | ------------------------------ | -------------------- |
| `13:122`   | Thư viện sách                  | `/books`                      | `book-library-screen.tsx · book-card.tsx`        | Thư viện sách                  | Ảnh Figma + mã nguồn |
| `13:289`   | Chi tiết sách và phạm vi trang | `/books/:bookId`              | `book-detail-screen.tsx`                         | Chi tiết sách và phạm vi trang | Ảnh Figma + mã nguồn |
| `236:3265` | Quét trang sách                | `/book-scanner`               | `book-scanner-screen.tsx`                        | Quét trang sách                | Ảnh Figma + mã nguồn |
| `251:5962` | Căn khung và nhận diện trang   | `/book-scanner`               | `book-scanner-screen.tsx`                        | Căn khung nhận diện            | Ảnh Figma + mã nguồn |
| `13:339`   | Kiểm tra microphone            | `/reading-preparation`        | `reading-preparation-screen.tsx`                 | Kiểm tra microphone            | Ảnh Figma + mã nguồn |
| `11:41`    | Buổi đọc                       | `/reading/:sessionId`         | `reading-screen.tsx · reading-layout.tsx`        | Buổi đọc                       | Ảnh Figma + mã nguồn |
| `236:3596` | Báo cáo đối chiếu              | `/sessions/:sessionId/report` | `ReadingReport.tsx`                              | Báo cáo đối chiếu              | Ảnh Figma + mã nguồn |
| `251:6042` | Xác nhận xóa báo cáo           | `/sessions/:sessionId/report` | `ReadingReport.tsx`                              | Xác nhận xóa báo cáo           | Ảnh Figma + mã nguồn |
| `251:6144` | Chưa có báo cáo đối chiếu      | `/sessions/:sessionId/report` | `ReadingReport.tsx`                              | Chưa có báo cáo đối chiếu      | Ảnh Figma + mã nguồn |
| `244:5712` | Microphone sẵn sàng            | `/reading-preparation`        | `reading-preparation-screen.tsx`                 | Microphone sẵn sàng            | Ảnh Figma + mã nguồn |
| `15:452`   | Tạm dừng buổi đọc              | `/reading/:sessionId`         | `reading-screen.tsx · reading-status-dialog.tsx` | Tạm dừng buổi đọc              | Ảnh Figma + mã nguồn |
| `15:524`   | Trang sách chưa rõ             | `/reading/:sessionId`         | `reading-screen.tsx · reading-status-dialog.tsx` | Trang sách chưa rõ             | Ảnh Figma + mã nguồn |
| `15:586`   | Đang kết nối lại               | `/reading/:sessionId`         | `reading-screen.tsx · reading-status-dialog.tsx` | Đang kết nối lại               | Ảnh Figma + mã nguồn |
| `16:661`   | Cần cấp quyền microphone       | `/reading/:sessionId`         | `reading-screen.tsx · reading-status-dialog.tsx` | Cần cấp quyền microphone       | Ảnh Figma + mã nguồn |
| `16:723`   | Kết thúc buổi đọc              | `/reading/:sessionId`         | `session-complete.tsx`                           | Kết thúc buổi đọc              | Ảnh Figma + mã nguồn |
| `17:896`   | Nghe đọc mẫu                   | `/reading/:sessionId`         | `reading-screen.tsx · reading-controls.tsx`      | Nghe đọc mẫu                   | Ảnh Figma + mã nguồn |
| `19:1045`  | Chưa phát được âm thanh        | `/reading/:sessionId`         | `reading-screen.tsx · reading-status-dialog.tsx` | Không phát được âm thanh       | Ảnh Figma + mã nguồn |
| `244:5214` | Chưa nhận dạng được giọng đọc  | `/reading/:sessionId`         | `reading-screen.tsx · reading-status-dialog.tsx` | Không nhận dạng được giọng đọc | Ảnh Figma + mã nguồn |
| `18:943`   | Đọc lại từ cần luyện           | `/reading/:sessionId`         | `reading-screen.tsx · reading-controls.tsx`      | Đọc lại từ cần luyện           | Ảnh Figma + mã nguồn |
| `17:755`   | Chọn trang thủ công            | `/reading/:sessionId`         | `reading-screen.tsx · reading-layout.tsx`        | Chọn trang thủ công            | Ảnh Figma + mã nguồn |
| `15:648`   | Cần cấp quyền camera           | `/book-scanner`               | `book-scanner-screen.tsx`                        | Cần cấp quyền camera           | Ảnh Figma + mã nguồn |
| `246:6063` | Không có sách phù hợp          | `/books`                      | `book-library-screen.tsx`                        | Không có sách phù hợp          | Ảnh Figma + mã nguồn |

## 04 · Quản trị (19)

| Figma ID   | Frame                     | Route                                | Thành phần                                               | Trạng thái                | Mức rà soát          |
| ---------- | ------------------------- | ------------------------------------ | -------------------------------------------------------- | ------------------------- | -------------------- |
| `26:150`   | Đăng nhập quản trị        | `/admin/login`                       | `admin-login-screen.tsx`                                 | Đăng nhập quản trị        | Ảnh Figma + mã nguồn |
| `49:495`   | Danh sách phụ huynh       | `/admin/parents`                     | `admin-parents-screen.tsx`                               | Danh sách phụ huynh       | Ảnh Figma + mã nguồn |
| `238:3608` | Chi tiết phụ huynh        | `/admin/parents/:parentId`           | `admin-parent-detail-screen.tsx`                         | Chi tiết phụ huynh        | Ảnh Figma + mã nguồn |
| `245:4784` | Thêm phụ huynh            | `/admin/parents`                     | `admin-parent-form-modal.tsx`                            | Thêm phụ huynh            | Ảnh Figma + mã nguồn |
| `245:4874` | Sửa hồ sơ phụ huynh       | `/admin/parents/:parentId`           | `admin-parent-form-modal.tsx`                            | Sửa hồ sơ phụ huynh       | Ảnh Figma + mã nguồn |
| `245:4962` | Xác nhận xóa phụ huynh    | `/admin/parents/:parentId`           | `admin-parent-detail-screen.tsx`                         | Xác nhận xóa phụ huynh    | Ảnh Figma + mã nguồn |
| `238:3680` | Chất lượng thông tin sách | `/admin/metadata-quality`            | `admin-metadata-quality-screen.tsx`                      | Chất lượng thông tin sách | Ảnh Figma + mã nguồn |
| `25:2`     | Kho sách                  | `/admin/books`                       | `admin-books-screen.tsx`                                 | Kho sách                  | Ảnh Figma + mã nguồn |
| `25:53`    | Thêm sách mới             | `/admin/books/new`                   | `admin-new-book-screen.tsx`                              | Thêm sách mới             | Ảnh Figma + mã nguồn |
| `27:291`   | Chỉnh sửa thông tin sách  | `/admin/books/:bookId/edit`          | `admin-book-editor-screen.tsx`                           | Chỉnh sửa sách            | Ảnh Figma + mã nguồn |
| `25:84`    | Trang sách và tải ảnh     | `/admin/books/:bookId`               | `admin-book-detail-screen.tsx · admin-page-uploader.tsx` | Trang sách và tải ảnh     | Ảnh Figma + mã nguồn |
| `26:80`    | Kiểm tra nội dung OCR     | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`                            | Kiểm tra nội dung OCR     | Ảnh Figma + mã nguồn |
| `27:163`   | OCR đã xác minh           | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`                            | OCR đã xác minh           | Ảnh Figma + mã nguồn |
| `28:293`   | Đang xử lý OCR            | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`                            | Đang xử lý OCR            | Ảnh Figma + mã nguồn |
| `246:5586` | Tiến độ tải ảnh           | `/admin/books/:bookId`               | `admin-page-uploader.tsx`                                | Tiến độ tải ảnh           | Ảnh Figma + mã nguồn |
| `27:227`   | Ngừng hoạt động sách      | `/admin/books`                       | `admin-books-screen.tsx`                                 | Ngừng hoạt động sách      | Ảnh Figma + mã nguồn |
| `246:5865` | Ngừng sử dụng trang       | `/admin/books/:bookId`               | `admin-book-detail-screen.tsx`                           | Ngừng sử dụng trang       | Ảnh Figma + mã nguồn |
| `49:526`   | Nhật ký kiểm toán         | `/admin/audit-logs`                  | `admin-audit-screen.tsx`                                 | Nhật ký kiểm toán         | Ảnh Figma + mã nguồn |
| `49:561`   | Tình trạng vận hành       | `/admin/health`                      | `admin-health-screen.tsx`                                | Tình trạng vận hành       | Ảnh Figma + mã nguồn |

## 05 · Thao tác chi tiết · Web & Mobile (12)

| Figma ID   | Frame                                         | Route                                | Thành phần                      | Trạng thái                          | Mức rà soát          |
| ---------- | --------------------------------------------- | ------------------------------------ | ------------------------------- | ----------------------------------- | -------------------- |
| `318:7716` | Thiết lập kế hoạch đọc                        | `/reading-management`                | `reading-management-screen.tsx` | Thiết lập kế hoạch đọc              | Ảnh Figma + mã nguồn |
| `318:7856` | Thiết lập mục tiêu                            | `/reading-management`                | `reading-management-screen.tsx` | Thiết lập mục tiêu                  | Ảnh Figma + mã nguồn |
| `318:7996` | Thiết lập lịch nhắc                           | `/reading-management`                | `reading-management-screen.tsx` | Thiết lập lịch nhắc                 | Ảnh Figma + mã nguồn |
| `318:8134` | Đổi mật khẩu                                  | `/settings`                          | `account-settings-screen.tsx`   | Đổi mật khẩu                        | Ảnh Figma + mã nguồn |
| `318:8268` | Gửi phản hồi                                  | `/help-support`                      | `help-support-screen.tsx`       | Gửi phản hồi                        | Ảnh Figma + mã nguồn |
| `318:8402` | Nội dung phản hồi đã gửi                      | `/help-support`                      | `help-support-screen.tsx`       | Nội dung phản hồi đã gửi            | Ảnh Figma + mã nguồn |
| `321:8363` | Kiểm tra từ và vị trí · Kiểm tra nội dung OCR | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`   | Kiểm tra từ và vị trí · bản nháp    | Ảnh Figma + mã nguồn |
| `321:8485` | Lịch sử xử lý OCR · Kiểm tra nội dung OCR     | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`   | Lịch sử OCR · bản nháp              | Ảnh Figma + mã nguồn |
| `321:8599` | Kiểm tra từ và vị trí · OCR đã xác minh       | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`   | Kiểm tra từ và vị trí · đã xác minh | Ảnh Figma + mã nguồn |
| `321:8721` | Lịch sử xử lý OCR · OCR đã xác minh           | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`   | Lịch sử OCR · đã xác minh           | Ảnh Figma + mã nguồn |
| `321:8835` | Kiểm tra từ và vị trí · Đang xử lý OCR        | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`   | Kiểm tra từ và vị trí · đang xử lý  | Ảnh Figma + mã nguồn |
| `321:8957` | Lịch sử xử lý OCR · Đang xử lý OCR            | `/admin/books/:bookId/pages/:pageId` | `admin-ocr-review-screen.tsx`   | Lịch sử OCR · đang xử lý            | Ảnh Figma + mã nguồn |

## Kết quả rà soát

- Số frame Web desktop đã kiểm kê từ Figma: **85** (12 + 20 + 22 + 19 + 12).
- Cả 85 frame đã được mở ảnh Figma trực tiếp, đối chiếu với source, và ánh xạ tới route, component cùng state tương ứng.
- Việc đối chiếu ảnh được thực hiện trên thiết kế Figma và mã nguồn; chưa chụp runtime của worktree nên chưa xác nhận pixel-to-pixel trên ứng dụng đang chạy.
- **22 frame có thay đổi mã giao diện**: `25:53`, `27:291`, `26:80`, `27:163`, `28:293`, `321:8363`, `321:8485`, `321:8599`, `321:8721`, `321:8835`, `321:8957`, `23:216`, `233:3036`, `233:3186`, `13:122`, `13:289`, `246:6063`, `13:339`, `244:5712`, `236:3265`, `251:5962`, `15:648`.
- Chưa mở runtime của worktree cho bất kỳ route nào. Parent/admin cần phiên đăng nhập hợp lệ; microphone/camera cần cấp quyền trên thiết bị thật. Không dùng thông tin đăng nhập hoặc bỏ qua bảo vệ để kiểm tra các trạng thái này.
- Chỉ dùng các frame `Web · …` rộng 1440px; không đọc hoặc kiểm tra frame mobile.
- Các màn sửa hồ sơ bé và chi tiết sách còn một số thao tác nghiệp vụ phụ không có trong frame Figma; chúng vẫn được giữ trong giao diện để không làm mất chức năng.
- Các công cụ phân tích evidence OCR/revision vẫn có thể mở trong phần chi tiết thu gọn; Figma không hiển thị nhóm công cụ này trên khung chính.
