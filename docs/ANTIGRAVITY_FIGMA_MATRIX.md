# ViRead Figma ↔ Code Alignment Matrix

**Date**: 2026-11-17
**Branch**: `feature/antigravity-figma-overnight-20261117`
**Figma File**: [ReadAlong Vision · Bạn nhỏ cùng đọc](https://www.figma.com/design/gfqkWdrUEBr63jpJUS27eP/ReadAlong-Vision-%C2%B7-B%E1%BA%A1n-nh%E1%BB%8F-c%C3%B9ng-%C4%91%E1%BB%8Dc?node-id=2-6) (`gfqkWdrUEBr63jpJUS27eP`, root node `2:6`)

> **Ghi chú trung thực về nguồn kiểm chứng**:
> 1. Trong môi trường cloud VM hiện tại không có Figma MCP kết nối trực tiếp.
> 2. Dữ liệu đối chiếu Figma kế thừa trực tiếp từ **49 frame độ phân giải cao** đã được đọc từ `2:6` và lưu biên bản tại `frontend/FIGMA_ALIGNMENT_AUDIT.md` (phiên `c2b79947-8af6-4c7b-9367-b19965561ca7`), kết hợp với kiểm tra mã nguồn và **Playwright Visual/Responsive QA thực tế** ở 4 kích thước (`390px`, `768px`, `1024px`, `1440px`).
> 3. Các màn hình **không có frame riêng trên Figma** (Giải trí, Xạ thủ ghép câu, Kể chuyện qua tranh, Karaoke & Chấm điểm hát, Báo cáo chất lượng sách, Huấn luyện OCR) được phân loại rõ là `PARTIAL` (*suy ra từ Design System*), không tự nhận là khớp pixel với một frame chưa tồn tại.
> 4. Khoảng ~120 biến thể trạng thái phụ còn lại trên trang `00 · Giao diện Web & Mobile` (~170 frame tổng cộng trừ 49 frame đã đọc trực tiếp) được ghi nhận là `BLOCKED` về mặt so khớp ảnh trực tiếp từ Figma MCP trên cloud VM, dù các trạng thái runtime (loading, empty, error, offline, dialog) đã được kiểm thử bằng Vitest & Playwright.

## 1. Design System Tokens (`frontend/app/globals.css`)

| Token | Giá trị Figma | Biến CSS / Utility | Trạng thái |
|---|---|---|---|
| Primary | `#147D87` | `--ra-color-primary` / `bg-primary`, `text-primary` | MATCHED |
| Primary Hover | `#0E6D76` | `--ra-color-primary-hover` / `bg-primary-hover` | MATCHED |
| Ink | `#213C42` | `--ra-color-ink` / `text-ink` | MATCHED |
| Muted | `#526970` | `--ra-color-muted` / `text-muted` | MATCHED |
| Canvas | `#F6FAF8` | `--ra-color-canvas` / `bg-canvas` | MATCHED |
| Cream | `#FFF8EB` | `--ra-color-cream` / `bg-cream` | MATCHED |
| Sky | `#DDF3F5` | `--ra-color-sky` / `bg-sky` | MATCHED |
| Border | `#D5E3DE` | `--ra-color-border` / `border-border` | MATCHED |
| White | `#FFFFFF` | `--ra-color-white` / `bg-white` | MATCHED |
| Desk (Reading) | `#DCE8E4` | `--ra-color-desk` / `bg-desk` | MATCHED |
| Highlight (Current Word) | `#FFD766` | `--ra-color-highlight` / `bg-highlight` | MATCHED |
| Font family | Nunito Variable | `--font-sans` | MATCHED |
| Heading size | `32px` desktop / `26px` mobile | `--ra-font-size-heading` / `text-heading` | MATCHED |
| Body size | `16px` | `--ra-font-size-body` / `text-body` | MATCHED |
| Label size | `16px` desktop / `14px` mobile | `--ra-font-size-label` / `text-label` | MATCHED |
| Spacing base | `4px` grid | `--spacing: 0.25rem` | MATCHED |
| Control radius | `16px` | `--radius-control` / `rounded-control` | MATCHED |
| Card radius | `24px` | `--radius-card` / `rounded-card` | MATCHED |

## 2. Bảng đối chiếu 46 Route (`page.tsx`) ↔ Figma

### 2.1. Tài khoản & Xác thực (6 routes)

| Route | Frame Figma | Node ID | Component chính | Phân loại | Kiểm thử & Ghi chú |
|---|---|---|---|---|---|
| `/` | Điều hướng gốc | — | `app/page.tsx` | MATCHED | Redirect hợp lệ về `/login` hoặc `/dashboard` |
| `/login` | Đăng nhập | `22:28` | `login-screen.tsx`, `auth-shell.tsx` | MATCHED | Card `560px` căn giữa trên nền `#F6FAF8`, label trong ô input; đã chụp QA `390–1440px` |
| `/register` | Đăng ký | `78:447` | `register-screen.tsx` | MATCHED | Đồng bộ khung `560px` và trạng thái xác nhận email; đã chụp QA `390–1440px` |
| `/forgot-password` | Quên mật khẩu | `82:474` | `forgot-password-screen.tsx` | MATCHED | Card `560px` căn giữa + trạng thái đã gửi email |
| `/reset-password` | Khôi phục mật khẩu | `79:459` | `reset-password-screen.tsx` | MATCHED | Đồng bộ khung `560px`, trạng thái thành công/hết hạn |
| `/admin/login` | Admin · Đăng nhập | `30:1146`, `30:1208` | `admin-login-screen.tsx` | MATCHED | Bố cục khiên + huy hiệu `ADMIN`, `text-heading` responsive |

### 2.2. Phụ huynh, Hồ sơ & Giải trí (13 routes)

| Route | Frame Figma | Node ID | Component chính | Phân loại | Kiểm thử & Ghi chú |
|---|---|---|---|---|---|
| `/dashboard` | Tổng quan phụ huynh | `21:2` | `dashboard-screen.tsx` | MATCHED | Khung `744px`, minh họa sách `96×96`, lưới 2 cột thẻ bé (avatar `88px`), đã sửa token `text-warning`; QA `390–1440px` |
| `/profile` | Hồ sơ ba mẹ & Sửa hồ sơ | `23:117`, `233:3186` | `parent-profile-screen.tsx`, `parent-profile-form.tsx` | MATCHED | Xem `1120px`, màn sửa riêng `744px`, thẻ bé liên kết; QA `390–1440px` |
| `/settings` | Cài đặt & Đổi mật khẩu | `23:216`, `318:8134` | `account-settings-screen.tsx` | MATCHED | Khung `960px`, màn đổi mật khẩu riêng `744px`; QA `390–1440px` |
| `/help-support` | Trợ giúp & Gửi phản hồi | `233:3100`, `318:8268` | `help-support-screen.tsx` | MATCHED | Khung `1120px`, FAQ + màn gửi góp ý riêng; QA `390–1440px` |
| `/device-permissions` | — | — | `app/(app)/device-permissions/page.tsx` | NOT_APPLICABLE | Route chỉ redirect sang `/dashboard?focus=child-selection` |
| `/children` | Danh sách hồ sơ bé | `234:2840` | `children-list-screen.tsx` | MATCHED | Khung `1120px`, lưới 2 cột thẻ hồ sơ bé |
| `/children/new` | Tạo hồ sơ bé | `234:2926` | `child-profile-screen.tsx` | MATCHED | Form `744px`, header gọn cho bước tạo hồ sơ |
| `/children/:childId` | Chi tiết / sửa hồ sơ bé | `35:304` | `child-profile-screen.tsx` | MATCHED | Form `744px` ở mọi trạng thái (kể cả lỗi/không tìm thấy), modal xác nhận xóa |
| `/entertainment` | *Không có frame riêng* | Suy ra từ DS | `entertainment-screen.tsx` | PARTIAL | **Suy ra từ Design System** (`1120px`, `ButtonLink`, thẻ trắng/kem đồng bộ); QA `390–1440px` |
| `/entertainment/picture-description` | *Không có frame riêng* | Suy ra từ DS | `picture-description-screen.tsx` | PARTIAL | **Suy ra từ Design System**; kiểm tra cổng chọn bé + responsive `390–1440px` |
| `/entertainment/sentence-shooter` | *Không có frame riêng* | Suy ra từ DS | `sentence-shooter-screen.tsx` | PARTIAL | **Suy ra từ Design System** (giữ nền trò chơi tươi sáng cho bé); responsive `390–1440px` |
| `/karaoke` | *Không có frame riêng* | Suy ra từ DS | `karaoke-library-screen.tsx` | PARTIAL | **Suy ra từ Design System** (`text-label`, `text-body`, `Card`); QA Playwright `karaoke.pw.ts` |
| `/karaoke/:songId` | *Không có frame riêng* | Suy ra từ DS | `karaoke-stage.tsx`, `karaoke-score-card.tsx` | PARTIAL | **Suy ra từ Design System** + tính năng chấm điểm hát P2, nút đầu trang xếp dọc an toàn trên mobile `390px` |

### 2.3. Thư viện sách & Luyện đọc (6 routes)

| Route | Frame Figma | Node ID | Component chính | Phân loại | Kiểm thử & Ghi chú |
|---|---|---|---|---|---|
| `/books` | Thư viện sách | `13:122`, `108:156` | `book-library-screen.tsx` | MATCHED | `BookChildHeader` riêng (không lặp nav phụ huynh), khung `1130px`, bộ lọc khối lớp, bìa kem `BookCover`; QA `390–1440px` |
| `/books/:bookId` | Chi tiết sách | `13:289`, `233:3036` | `book-detail-screen.tsx` | MATCHED | Bìa kem bên trái `306px`, nút `Chuẩn bị đọc` ưu tiên trước bộ chọn trang |
| `/book-scanner` | Quét trang sách | `236:3265` | `book-scanner-screen.tsx` | MATCHED | Khung `960px`, trạng thái tắt camera & xác nhận quyền rõ ràng; QA `390–1440px` |
| `/book-reports` | *Không có frame riêng* | Suy ra từ DS | `parent-book-reports-screen.tsx` | PARTIAL | **Suy ra từ Design System**; đã chuẩn hóa `max-w-[1120px]` trong `AppShell` và nút `w-auto` |
| `/reading-preparation` | Chuẩn bị đọc sách | `13:339` | `reading-preparation-screen.tsx` | MATCHED | Khung `960px`, kiểm tra microphone tường minh trước khi tạo phiên; QA `390–1440px` |
| `/reading/:sessionId` | Buổi luyện đọc | `11:41`, `245:4784`, `245:4874` | `reading-screen.tsx`, `reading-layout.tsx`, `session-complete.tsx` | MATCHED | Mặt bàn `#DCE8E4`, thanh điều khiển bên dưới trang sách, tô sáng từ `#FFD766`, giữ nguyên ngữ nghĩa đúng/sai và đã sửa token màu phụ |

### 2.4. Tiến bộ, Lịch sử & Quản lý đọc (6 routes)

| Route | Frame Figma | Node ID | Component chính | Phân loại | Kiểm thử & Ghi chú |
|---|---|---|---|---|---|
| `/reports` | Tiến bộ của bé | `23:147` | `progress-report-screen.tsx` | MATCHED | Khung `1120px`, 4 thẻ chỉ số, biểu đồ cột, đánh giá đọc; QA `390–1440px` |
| `/reports/difficult-words` | Từ cần luyện | `237:3233` | `difficult-words-screen.tsx` | MATCHED | Khung `1120px`, danh sách từ cần luyện theo kỳ; QA `390–1440px` |
| `/sessions` | Lịch sử buổi đọc | `23:185` | `session-history-screen.tsx` | MATCHED | Khung `1120px`, thẻ lịch sử dọc + phân trang; QA `390–1440px` |
| `/sessions/:sessionId` | Chi tiết buổi đọc | `23:84` | `session-detail-screen.tsx` | MATCHED | Khung `1120px`, thẻ chỉ số `text-heading` co giãn an toàn ở `390px`; QA `390–1440px` |
| `/sessions/:sessionId/report` | Báo cáo đối chiếu | `236:3596` | `ReadingReport.tsx` | MATCHED | Đồng bộ `rounded-card`, `border-border`, giữ nguyên màu ngữ nghĩa đúng/sai |
| `/reading-management` | Quản lý đọc & 3 màn biểu mẫu | `234:2628`, `318:7716`, `318:7856`, `318:7996`, `275:4418` | `reading-management-screen.tsx` | MATCHED | Khung `1120px`, phân cấp `h1` (`32px`) > `h2` (`24px`), 3 màn tạo/sửa toàn trang (`.figma-form-page`); QA `390–1440px` |

### 2.5. Quản trị hệ thống — Admin (15 routes)

| Route | Frame Figma | Node ID | Component chính | Phân loại | Kiểm thử & Ghi chú |
|---|---|---|---|---|---|
| `/admin` | Điều hướng Admin | `49:495` | `admin-layout.tsx` | MATCHED | Thanh điều hướng ngang trên cùng, vùng nội dung chuẩn `1280px` (`max-w-[1360px]` + `xl:px-10`) |
| `/admin/parents` | Danh sách phụ huynh | `25:2`, `275:4095`, `275:4792` | `admin-parents-screen.tsx` | MATCHED | Lưới 2 cột thẻ phụ huynh + modal tạo/sửa trắng theo Figma |
| `/admin/parents/:parentId` | Chi tiết phụ huynh | `49:526` | `admin-parent-detail-screen.tsx` | MATCHED | Khung `1280px`, `Thông tin Parent`, thẻ trẻ em có avatar chữ cái đầu |
| `/admin/books` | Kho sách | `49:561` | `admin-books-screen.tsx` | MATCHED | Bộ lọc 3 cột, dòng tổng quan gọn, **3 nút thao tác xếp lưới 3 cột ngang (`sm:grid-cols-3`)** đúng Figma |
| `/admin/books/new` | Tạo sách mới | `238:3608` | `admin-new-book-screen.tsx` | MATCHED | Biểu mẫu `960px`, tiêu đề phần `24px` (`text-2xl`) |
| `/admin/books/:bookId` | Chi tiết sách & trang | `25:53` | `admin-book-detail-screen.tsx` | MATCHED | Thông tin sách + danh sách trang & trạng thái OCR |
| `/admin/books/:bookId/edit` | Chỉnh sửa sách | `238:3680` | `admin-book-editor-screen.tsx` | MATCHED | Biểu mẫu `960px` đồng bộ với tạo sách |
| `/admin/books/:bookId/pages/:pageId` | Duyệt OCR trang sách | `25:84` | `admin-ocr-review-screen.tsx` | MATCHED | Giữ nguyên 3 mức màu độ tin cậy OCR & khung từ trên ảnh |
| `/admin/audit-logs` | Nhật ký hệ thống | `26:80` | `admin-audit-screen.tsx` | MATCHED | Tiêu đề sự kiện `24px`, 2 ô thông tin viền, khối `Metadata an toàn` nền `bg-sky` |
| `/admin/health` | Trạng thái vận hành | `27:291` | `admin-health-screen.tsx` | MATCHED | Thẻ tổng quan + lưới 2 cột dịch vụ với tiêu đề `24px` |
| `/admin/metadata-quality` | Chất lượng metadata | `26:150` | `admin-metadata-quality-screen.tsx` | MATCHED | Chỉ số KPI `32px` + danh sách sách cần kiểm tra |
| `/admin/viread-training` | *Không có frame riêng* | Suy ra từ DS | `admin-viread-training-screen.tsx` | PARTIAL | **Suy ra từ Design System**; dùng `AdminLayout`, `Button`, `Card` của ViRead |
| `/admin/karaoke` | Quản lý bài hát | `275:4976` | `admin-karaoke-list-screen.tsx` | MATCHED | Danh sách bài hát quản trị đồng bộ `AdminLayout` |
| `/admin/karaoke/new` | Thêm bài hát | Cùng nhóm `275:4976` | `admin-karaoke-editor-screen.tsx` | MATCHED | Biểu mẫu thêm bài hát và lời đồng bộ token |
| `/admin/karaoke/:songId/edit` | Sửa bài hát | Cùng nhóm `275:4976` | `admin-karaoke-editor-screen.tsx` | MATCHED | Biểu mẫu cập nhật bài hát và lời đồng bộ token |

## 3. Tổng hợp kết quả phân loại

| Nhóm | MATCHED (Có frame Figma) | PARTIAL (Suy ra từ Design System) | NOT_APPLICABLE | BLOCKED (Chưa so pixel trực tiếp qua MCP) | Tổng route `page.tsx` |
|---|---|---|---|---|---|
| Tài khoản & Xác thực | 6 | 0 | 0 | 0 | 6 |
| Phụ huynh, Hồ sơ & Giải trí | 7 | 5 | 1 | 0 | 13 |
| Thư viện sách & Luyện đọc | 5 | 1 | 0 | 0 | 6 |
| Tiến bộ, Lịch sử & Quản lý đọc | 6 | 0 | 0 | 0 | 6 |
| Quản trị (Admin) | 14 | 1 | 0 | 0 | 15 |
| **Tổng cộng (46 routes)** | **38** | **7** | **1** | **0 route (~120 frame phụ)** | **46** |
