# Báo cáo nghiệm thu frontend ReadAlong Vision

Ngày nghiệm thu: 12/09/2026
Phạm vi: frontend web Next.js responsive, Nhóm 1–6
Kết luận: **Đạt nghiệm thu frontend với các giới hạn mock và repository được công bố bên dưới.**

## 1. Nguồn đối chiếu và nguyên tắc

- Blueprint: `ReadAlong_Vision_Capstone1_Master_Blueprint_v1.7.1_FINAL_CODING_FREEZE.docx` (tài liệu bàn giao ngoài repository).
- Coding Handoff: `ReadAlong_Vision_v1.7.1_Coding_Handoff.md` (tài liệu bàn giao ngoài repository).
- Figma: https://www.figma.com/design/gfqkWdrUEBr63jpJUS27eP.
- Blueprint là nguồn contract/hành vi; Figma là nguồn giao diện trực quan.
- Không thêm backend, database, Supabase, WebSocket, camera processing, OCR, STT/TTS hoặc AI thật.
- Mobile node trong Figma chỉ dùng làm tham chiếu reflow 390px; code dùng một cây component responsive.

Safety invariant được giữ xuyên suốt:

> No valid evidence → no child-error inference.

## 2. Kết quả tổng quan

| Hạng mục           | Kết quả                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Route ứng dụng     | 24/24 route có entry hợp lệ; build có thêm `/_not-found` của framework                            |
| Dead route/link    | Không phát hiện link nội bộ trỏ đến route thiếu; route matrix trả HTTP dưới 400                   |
| Responsive         | Toàn bộ route được chạy ở 1440, 1024, 768 và 390px; không có horizontal overflow                  |
| Browser runtime    | Route matrix không ghi nhận `console.error` hoặc `pageerror`                                      |
| Unit/component     | 25 files, 120/120 tests PASS                                                                      |
| Playwright         | 136 PASS, 4 SKIP có chủ đích, 0 FAIL                                                              |
| Production build   | PASS, Next.js 16.3.4                                                                              |
| Static safety scan | 0 secret pattern, 0 `.env*` thật, 0 `any`, 0 `@ts-ignore`, 0 tích hợp dịch vụ thật                |
| Mobile app riêng   | Không có `android`, `ios`, `mobile`, React Native, Flutter hoặc route `/mobile`                   |
| Git metadata       | Không có thư mục `.git` trong workspace được mount; không thể xác định tracked/untracked bằng Git |

## 3. Repository

Lệnh `git status --short` trả về:

```text
fatal: not a git repository (or any of the parent directories): .git
```

Vì vậy không thể lập danh sách tracked/untracked theo Git hoặc tạo diff đáng tin cậy. Không file người dùng nào bị xóa hay hoàn tác. Danh sách file sửa trong đợt nghiệm thu được lấy từ phạm vi công việc và thời điểm sửa trong workspace, trình bày tại mục 13.

Kiểm tra cấu trúc:

- Không có ứng dụng mobile riêng.
- Không có component desktop/mobile trùng chỉ để xử lý breakpoint.
- Không có `.env` thật; `.gitignore` loại trừ `.env*`.
- Không có credential hoặc private key pattern.
- Không có server còn lắng nghe cổng 3000 sau khi Playwright kết thúc.

## 4. Quy ước layout

- **R**: `app/layout.tsx` — `lang="vi"`, Nunito Variable và global tokens.
- **P**: R + `app/(app)/layout.tsx` — `AppStoreProvider → AppShell`.
- **A**: R + `app/admin/layout.tsx` — `AdminStoreProvider → AdminServicesProvider → AdminLayout`.
- Books và Reading vẫn thuộc P, nhưng shell ẩn navigation thường để giữ trải nghiệm tập trung.

## 5. Route inventory

| Route                                  | Page / layout                                    | Component chính                              | Typed service                                                                  | UI states                                                                                                                            | Điều hướng                        | Trạng thái |
| -------------------------------------- | ------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------- |
| `/`                                    | `app/page.tsx` / R                               | redirect                                     | —                                                                              | redirect                                                                                                                             | → login                           | Hoàn tất   |
| `/login`                               | `app/(auth)/login/page.tsx` / R                  | `LoginScreen`, `LoginForm`                   | `AuthService`                                                                  | loading, invalid credentials, generic error, validation, submitting                                                                  | → dashboard, register, forgot     | Hoàn tất   |
| `/register`                            | `app/(auth)/register/page.tsx` / R               | `RegisterScreen`, `RegisterForm`             | `AuthService`                                                                  | loading, email-used an toàn, validation, error, submitting                                                                           | → child onboarding; → login       | Hoàn tất   |
| `/forgot-password`                     | `app/(auth)/forgot-password/page.tsx` / R        | `ForgotPasswordScreen`, `ForgotPasswordForm` | `AuthService`                                                                  | input, loading, submitted, resend, safe error                                                                                        | → login                           | Hoàn tất   |
| `/reset-password`                      | `app/(auth)/reset-password/page.tsx` / R         | `ResetPasswordScreen`, `ResetPasswordForm`   | `AuthService`                                                                  | loading, invalid/expired token, success, validation, error                                                                           | → login/forgot                    | Hoàn tất   |
| `/dashboard`                           | `app/(app)/dashboard/page.tsx` / P               | `DashboardScreen`                            | `ProfileService`, `ChildService`                                               | loading, empty, một/nhiều child, error/retry                                                                                         | → child, books, reports, sessions | Hoàn tất   |
| `/profile`                             | `app/(app)/profile/page.tsx` / P                 | `ParentProfileScreen`, form                  | `ProfileService`                                                               | loading, view/edit, validation, submitting, success, error                                                                           | AppShell                          | Hoàn tất   |
| `/children`                            | `app/(app)/children/page.tsx` / P                | `ChildrenListScreen`                         | `ChildService`                                                                 | loading, empty, ready, error/retry                                                                                                   | → new/detail                      | Hoàn tất   |
| `/children/new`                        | `app/(app)/children/new/page.tsx` / P            | `ChildProfileScreen`, form                   | `ChildService`                                                                 | create, onboarding, validation, saving, error                                                                                        | → books hoặc detail; → list       | Hoàn tất   |
| `/children/[childId]`                  | `app/(app)/children/[childId]/page.tsx` / P      | `ChildProfileScreen`, form                   | `ChildService`                                                                 | loading, edit, validation, saving, success, safe 404, error                                                                          | → books/list                      | Hoàn tất   |
| `/books`                               | `app/(app)/books/page.tsx` / P                   | `BookLibraryScreen`                          | `BookService`, `ChildService`                                                  | loading, empty, search, filter, no-result, error/retry                                                                               | → detail/dashboard                | Hoàn tất   |
| `/books/[bookId]`                      | `app/(app)/books/[bookId]/page.tsx` / P          | `BookDetailScreen`                           | `BookService`, `ChildService`, `ReadingService`                                | loading, preview, unavailable, not-found, start/error                                                                                | → books/reading                   | Hoàn tất   |
| `/reading/[sessionId]`                 | `app/(app)/reading/[sessionId]/page.tsx` / P     | `ReadingScreen` và reading components        | Reading, Book, Child, Socket, Permission, Match, Tutor, Comprehension services | ready, reading, permission denied, low-confidence, manual, paused, reconnect, STT/TTS, page-turn, question, complete, safe 404/error | → detail/books/dashboard/session  | Hoàn tất   |
| `/sessions`                            | `app/(app)/sessions/page.tsx` / P                | `SessionHistoryScreen`                       | `SessionService`, `ChildService`, `BookService`                                | loading, empty, ready, safe error/not-found, pagination                                                                              | → detail/books/new child          | Hoàn tất   |
| `/sessions/[sessionId]`                | `app/(app)/sessions/[sessionId]/page.tsx` / P    | `SessionDetailScreen`                        | `SessionService`, `ChildService`, `BookService`                                | loading, ready, incomplete, no events/questions, safe 404/error                                                                      | → sessions                        | Hoàn tất   |
| `/reports`                             | `app/(app)/reports/page.tsx` / P                 | `ProgressReportScreen`                       | `ReportService`, `ChildService`                                                | loading, empty, success, no prior period, nullable metrics, safe error/not-found                                                     | → history/books/difficult words   | Hoàn tất   |
| `/reports/difficult-words`             | `app/(app)/reports/difficult-words/page.tsx` / P | `DifficultWordsScreen`                       | `DifficultWordService`, `ChildService`                                         | loading, empty, ready, insufficient evidence, safe error/not-found                                                                   | → report/books                    | Hoàn tất   |
| `/admin/login`                         | `app/admin/login/page.tsx` / A                   | `AdminLoginScreen`                           | `AdminAuthService`                                                             | validation, submitting, invalid credentials, unauthenticated, forbidden, error                                                       | → admin books                     | Hoàn tất   |
| `/admin/books`                         | `app/admin/books/page.tsx` / A                   | `AdminBooksScreen`                           | `AdminBookService`                                                             | loading, empty/no-result, search/filter, forbidden, error/retry                                                                      | → new/detail/login                | Hoàn tất   |
| `/admin/books/new`                     | `app/admin/books/new/page.tsx` / A               | `AdminNewBookScreen`, form                   | `AdminBookService`                                                             | validation, submitting, error                                                                                                        | → detail/list                     | Hoàn tất   |
| `/admin/books/[bookId]`                | `app/admin/books/[bookId]/page.tsx` / A          | `AdminBookDetailScreen`, uploader            | `AdminBookService`, `AdminPageService`                                         | loading, safe 404/error, edit, upload validation/progress/failure, lifecycle                                                         | → list/OCR page                   | Hoàn tất   |
| `/admin/books/[bookId]/pages/[pageId]` | nested page / A                                  | `AdminOcrReviewScreen`                       | Book, Page, OCR, Revision services                                             | PROCESSING, NEEDS_REVIEW, VERIFIED, save/verify/reprocess, history, safe 404/error                                                   | → book detail                     | Hoàn tất   |
| `/admin/audit-logs`                    | `app/admin/audit-logs/page.tsx` / A              | `AdminAuditScreen`                           | `AuditService`                                                                 | loading, empty, ready, filters, pagination, error                                                                                    | Admin nav                         | Hoàn tất   |
| `/admin/health`                        | `app/admin/health/page.tsx` / A                  | `AdminHealthScreen`                          | `HealthService`                                                                | loading, healthy, degraded, unavailable, error/retry                                                                                 | Admin nav                         | Hoàn tất   |

## 6. Figma frame → route

### Web frames có đối chiếu trực tiếp

| Node      | Nội dung                  | Route/state                                          |
| --------- | ------------------------- | ---------------------------------------------------- |
| `22:28`   | Web · Đăng nhập           | `/login`                                             |
| `78:447`  | Web · Đăng ký             | `/register`                                          |
| `82:474`  | Nhập email khôi phục      | `/forgot-password`                                   |
| `83:487`  | Kiểm tra email            | `/forgot-password?state=submitted`                   |
| `108:139` | Hướng dẫn email khôi phục | Nội dung trong flow forgot; email thật ngoài phạm vi |
| `108:156` | Đặt mật khẩu mới          | `/reset-password`                                    |
| `108:175` | Reset thành công          | `/reset-password?state=success`                      |
| `112:173` | Đã yêu cầu gửi lại        | Resend state trên forgot                             |
| `83:535`  | Tạo hồ sơ bé              | `/children/new?from=register`                        |
| `13:61`   | Chọn hồ sơ bé             | Khu vực chọn bé trên `/dashboard`                    |
| `13:122`  | Chọn sách                 | `/books`                                             |
| `13:289`  | Chi tiết sách             | `/books/[bookId]`                                    |
| `13:339`  | Sẵn sàng đọc              | Reading `ready`                                      |
| `11:41`   | Đang đọc                  | Reading `reading`                                    |
| `15:452`  | Tạm dừng                  | Reading `paused`                                     |
| `15:524`  | Page confidence thấp      | Reading `page-confidence-low`                        |
| `17:755`  | Chọn trang thủ công       | Reading `manual-page`                                |
| `15:586`  | Kết nối lại               | Reading `reconnecting`                               |
| `15:648`  | Camera denied             | Reading `camera-denied`                              |
| `16:661`  | Microphone denied         | Reading `microphone-denied`                          |
| `16:723`  | Xác nhận dừng             | Finish dialog                                        |
| `17:896`  | Nghe mẫu từ               | Tutor/TTS interaction                                |
| `17:951`  | Câu hỏi đọc hiểu          | Reading `question`                                   |
| `18:990`  | Thử lại                   | Question result                                      |
| `18:1028` | Trả lời đúng              | Question result                                      |
| `19:1045` | Nghe lại                  | Tutor retry                                          |
| `18:943`  | Hoàn thành                | Reading `complete`                                   |
| `39:2097` | Trợ giúp đọc              | Tutor/help                                           |

### Mobile nodes dùng làm reference 390px

| Node                                                                                   | Ánh xạ                    |
| -------------------------------------------------------------------------------------- | ------------------------- |
| `79:459`, `81:466`                                                                     | Login và Register         |
| `82:496`, `83:506`, `83:520`, `108:192`, `112:198`                                     | Forgot/check email/resend |
| `108:204`, `108:218`                                                                   | Reset và reset success    |
| `29:1157`                                                                              | Chọn hồ sơ                |
| `30:1146`, `30:1208`                                                                   | Books và book detail      |
| `30:1186`, `29:1102`                                                                   | Reading ready và active   |
| `31:1271`, `31:1334`, `32:1347`, `32:1410`, `32:1473`, `32:1536`, `39:2174`, `39:2195` | Responsive reading states |

Không có frame Web chuyên biệt cho parent management đầy đủ, Sessions, Reports hoặc Admin. Các route đó dùng Blueprint cùng token/component đã xác nhận từ Figma; không được báo cáo là pixel-match một frame không tồn tại.

Sai khác có chủ đích: secondary action trong frame microphone denied là “Nhờ ba mẹ”, nhưng không có route/contract cho hành động đó. UI nghiệm thu dùng “Kết thúc an toàn” để tránh nút no-op và giữ đường thoát an toàn.

## 7. Design system và component dùng chung

Design tokens tại `app/globals.css`:

| Nhóm       | Giá trị                                                            |
| ---------- | ------------------------------------------------------------------ |
| Font       | Nunito Variable, fallback rounded/system                           |
| Typography | heading 32px; body/button 20px; label 16px; heading weight 800/900 |
| Brand      | primary `#147d87`, hover `#0e6d76`, ink `#213c42`, muted `#526970` |
| Surface    | canvas `#f6faf8`, cream `#fff8eb`, sky `#ddf3f5`, border `#d5e3de` |
| Feedback   | success, danger, warning, purple và highlight semantic colors      |
| Spacing    | 4, 8, 12, 16, 24, 32px                                             |
| Radius     | control 16px, card 24px                                            |
| A11y       | focus-visible 3px, reduced-motion override, `lang="vi"`            |

Component tái sử dụng:

- Foundation: `Button`, `ButtonLink`, `Card`, `TextField`, `SelectField`, `Modal`, `StatusMessage`, `EmptyState`, `Skeleton`, `BrandHeader`.
- Shell: `AuthShell`, `AppShell`, `AdminLayout`, `AdminPageHeader`, `AdminStatusBadge`.
- Child/Books: profile card/form, child header, `BookCard`, `BookCover`, page thumbnail.
- Reading: layout, ready, controls, progress, viewer, camera preview, word overlay, dialogs, status banner, page selector, tutor, question, completion.
- Reports: page header, child selector, metric card, progress chart, history/event items và difficult-word item.
- Dependency injection: Auth/App/Admin service và store providers.

## 8. Typed mock architecture

Luồng phụ thuộc:

```text
page/screen → typed service interface → provider → mock adapter → local store/fixture
```

Service inventory:

- Auth: `AuthService`.
- Parent/catalog: `ProfileService`, `ChildService`, `BookService`.
- Reading: `ReadingService`, `ReadingSocketAdapter`, `DevicePermissionService`, `PageMatchService`, `TutorService`, `ComprehensionService`.
- History/report: `SessionService`, `ReportService`, `DifficultWordService`.
- Admin: `AdminAuthService`, `AdminBookService`, `AdminPageService`, `OcrReviewService`, `RevisionService`, `AuditService`, `HealthService`.

Kết quả audit:

- Component không import fixture trực tiếp.
- Canonical DTO/type, UI model, mapper, fixture và implementation được tách.
- Page entry không chứa mock fixture/logic.
- Không có `any` hoặc `@ts-ignore`.
- Không gọi dịch vụ thật.
- Subscription có cleanup; screen bỏ qua promise đến muộn sau unmount hoặc request mới.
- Có thể thay implementation tại provider mà không viết lại screen.

Store Admin và store Parent/Reading/Reports là hai fixture graph độc lập. Mutation Admin không tự lan sang catalog/report của phụ huynh; refresh cũng khởi tạo lại dữ liệu. Đây là giới hạn demo, không phải persistence.

## 9. UI state và cách demo

README là nguồn hướng dẫn đầy đủ. Các URL chính:

- Auth: `/login?state=loading|invalid-credentials|safe-error`; `/register?state=loading|email-used|validation-error|safe-error`; forgot submitted; reset invalid/expired/success.
- Parent: `/dashboard?state=loading|empty|error`; profile form states; children loading/empty/not-found/error.
- Books: `/books?state=loading|empty|error`; search/filter/no-result; detail not-found/unavailable/error.
- Reading: `/reading/mock-session-001?state=ready|reading|camera-denied|microphone-denied|page-confidence-low|manual-page|paused|reconnecting|stt-error|tts-error|page-turn|question|complete`.
- Sessions/Reports: loading, empty, error, no prior period, nullable metric, insufficient evidence và not-found qua `state`.
- Admin: loading/empty/error/forbidden, upload/lifecycle failures, health degraded/unavailable; PROCESSING/NEEDS_REVIEW/VERIFIED dùng fixture page ID rõ ràng.

Fixture ID và tài khoản demo nằm tại `README.md`.

## 10. Safety và contract

Các invariant đã được kiểm tra bằng unit/component và E2E:

- PAUSED, RECONNECTING, provider failure, permission denied, PAGE_CONFIDENCE_LOW và invalid evidence không kết luận bé đọc sai.
- Child/session/report không thuộc parent hiện tại trả generic safe 404.
- Admin nested OCR kiểm tra page thực sự thuộc book trong URL.
- Recovery luôn dùng thông báo không tiết lộ email tồn tại.
- Expected answer không xuất hiện trong question DTO/payload/UI trước khi trả lời.
- Parent catalog và Reading chỉ dùng sách ACTIVE + VERIFIED.
- Eligibility của sách Admin trỏ đúng `current_verified_revision_id`, không dùng revision mới nhất đang review.
- VERIFIED revision bất biến; reprocess tạo revision mới và giữ revision cũ.
- Khi chọn revision lịch sử, UI không cho reprocess sai nguồn.
- Session history giữ revision ID lịch sử.
- Null metric không bị đổi thành 0.
- TTS retry không tăng difficult-word evidence.
- Upload Admin kiểm tra JPEG/PNG/WebP, tối đa 12 MB, page number, kích thước và duplicate.
- Không hiển thị secret, token hoặc internal exception.

## 11. Accessibility và responsive

Các sửa đổi:

- Full-page loading/error/not-found có `h1`; card/metric dùng heading đúng cấp.
- Field có label và error association; focus-visible toàn cục rõ ràng.
- Modal giữ focus, xử lý initial Tab/Shift+Tab, wrap hai đầu, Escape và trả focus.
- Touch target được mở rộng; action chỉ có icon có accessible name.
- Status quan trọng dùng live region phù hợp; không báo reconnecting giả khi vừa mount.
- OCR bbox được mô tả như một accessible image; từng bbox trang trí bị ẩn khỏi accessibility tree.
- Trạng thái không chỉ dựa vào màu; contrast primary-on-sky được tăng.
- `prefers-reduced-motion` được hỗ trợ.
- Không tự động phát âm thanh.

Responsive:

- Route matrix chạy tất cả 24 route ở 1440, 1024, 768 và 390px.
- Screenshot production được tạo cho toàn bộ route ở 1440 và 390px trong `test-results/`.
- Đã kiểm tra trực quan Auth, Parent, Books, Reading, Sessions/Reports và Admin ở hai kích thước; không thấy overflow, chồng lớp, ảnh méo hoặc control bị che.
- Book filter dùng một fieldset responsive duy nhất; mobile cuộn ngang đầy đủ “Tất cả” và lớp 1–5.
- Admin OCR chuyển từ hai cột sang một cột sử dụng được ở 390px.

## 12. Lỗi đã sửa trong nghiệm thu

1. Admin logout trước đây không gọi service; nay await sign-out, chống lặp và điều hướng an toàn.
2. Forgot-password có action `mailto:` rỗng; đã thay bằng action hợp lệ.
3. Onboarding child sau đăng ký đi sai đích; nay tới catalog với `childId`.
4. Mobile book filter thiếu lựa chọn; đã hợp nhất fieldset đầy đủ.
5. Modal chưa giữ focus ở initial Tab/Shift+Tab; đã sửa và thêm test.
6. Reading báo reconnecting giả ở trạng thái bình thường; đã khởi tạo connected.
7. Microphone denied có nút không hoạt động; nay có safe exit.
8. Full-page Reading error/not-found thiếu `h1`; đã sửa.
9. Focus, contrast, heading semantics, touch target, reduced-motion và OCR accessibility được chuẩn hóa.
10. Reading có thể nhận book không hợp lệ; nay qua `BookService` eligibility boundary.
11. Admin eligibility từng lấy revision mới nhất thay vì verified pointer; đã sửa.
12. Upload/revision validation còn lỏng; đã bổ sung validation contract.
13. Nested OCR có thể ghép book và page khác nhau; nay trả safe 404.
14. Reprocess revision lịch sử có mô tả sai nguồn; nay chỉ cho reprocess verified revision hiện hành.
15. Ba Admin scenario query silent no-op bị loại khỏi type/parser; trạng thái dùng fixture ID.
16. Các async Admin/Reading action có thể nhận kết quả muộn sau unmount; nay có mounted/request guard.
17. UI timer thừa ở Book Detail được bỏ.

## 13. File thay đổi trong đợt nghiệm thu

### App và tài liệu

- `app/admin/layout.tsx`
- `app/globals.css`
- `README.md`
- `FRONTEND_ACCEPTANCE_REPORT.md`

### Components

- Admin: `admin-audit-screen.tsx`, `admin-book-detail-screen.tsx`, `admin-books-screen.tsx`, `admin-health-screen.tsx`, `admin-layout.tsx`, `admin-login-screen.tsx`, `admin-new-book-screen.tsx`, `admin-ocr-review-screen.tsx`.
- Auth: `forgot-password-screen.tsx`.
- Books: `book-card.tsx`, `book-cover.tsx`, `book-detail-screen.tsx`, `book-library-screen.tsx`.
- Child/Dashboard: `child-profile-screen.tsx`, `dashboard-screen.tsx`.
- Common/Layout: `brand-header.tsx`, `button.tsx`, `empty-state.tsx`, `modal.tsx`, `select-field.tsx`, `text-field.tsx`, `app-shell.tsx`.
- Providers: `app-services-provider.tsx`.
- Reading: `comprehension-question.tsx`, `reading-screen.tsx`, `status-banner.tsx`.
- Reports: `difficult-words-screen.tsx`, `metric-card.tsx`, `progress-report-screen.tsx`, `session-detail-screen.tsx`, `session-event-list.tsx`, `session-history-item.tsx`, `session-history-screen.tsx`.

### API, mock, mapper và type

- `lib/api/admin-auth-service.ts`.
- `lib/mock/mock-admin-auth-service.ts`, `mock-admin-book-service.ts`, `mock-admin-page-service.ts`, `mock-book-service.ts`, `mock-comprehension-service.ts`, `mock-ocr-review-service.ts`, `mock-reading-service.ts`, `mock-revision-service.ts`, `mock-tutor-service.ts`.
- `lib/utils/admin-mappers.ts`, `admin-revision.ts`, `admin-scenario.ts`, `admin-upload.ts`.
- `types/admin.ts`.

### Tests

- Admin: `admin-async-cleanup.test.tsx`, `admin-components.test.tsx`, `admin-ocr-review-screen.test.tsx`.
- Auth/Books/Common: `forgot-password-screen.test.tsx`, `book-library-screen.test.tsx`, `empty-state.test.tsx`, `modal.test.tsx`.
- Reading/Reports: `reading-async-cleanup.test.tsx`, `reading-screen.test.tsx`, `group5-components.test.tsx`.
- Services: `mock-admin-services.test.ts`, `mock-reading-services.test.ts`.
- E2E: `acceptance.spec.ts`, `auth.spec.ts`, `group2.spec.ts`, `group6.spec.ts`.

## 14. Command và kết quả thực tế

Môi trường:

| Command              | Kết quả                           |
| -------------------- | --------------------------------- |
| `node --version`     | `v22.19.0`                        |
| `npm --version`      | `10.9.3`                          |
| `git status --short` | FAIL do workspace không có `.git` |

Baseline trước sửa:

- `npm run verify`: PASS; 21 test files, 94 tests.
- Clean production build: PASS sau khi xóa cache `.next` bị khóa.
- Playwright baseline: 132/132 PASS sau khi xóa `test-results` bị khóa.

Final:

| Command                            | Kết quả                                          |
| ---------------------------------- | ------------------------------------------------ |
| `npm run format`                   | PASS                                             |
| `npm run format:check`             | PASS                                             |
| `npm run lint`                     | PASS                                             |
| `npm run typecheck`                | PASS                                             |
| `npm test`                         | PASS — 25 files, 120 tests                       |
| `npm run build`                    | PASS — 25 route entries gồm `/_not-found`        |
| `npx playwright test`              | PASS — 136 passed, 4 skipped, 0 failed, 2.8 phút |
| Secret/env/mobile/unsafe-type scan | PASS — tất cả 0 hit                              |
| Route/console/overflow matrix      | PASS — 24 route × 4 viewport                     |
| Cổng 3000 sau test                 | 0 listener                                       |

Lần `npm test` đầu trong sandbox không khởi động vì Windows trả `EPERM` khi Vite ghi `node_modules/.vite-temp`; không test nào chạy trong lần đó. Chạy lại đúng command ngoài sandbox đã PASS 120/120. Đây là lỗi quyền môi trường, không phải test failure.

Bốn Playwright skip là bốn bản sao acceptance matrix trong project `mobile-chromium`. Matrix tự đặt đủ bốn viewport trong `desktop-chromium` để tránh chạy trùng; các flow Nhóm 1–6 vẫn chạy trên cả desktop và mobile projects.

## 15. Giới hạn còn lại và phần đang mock

- Workspace không có Git metadata nên không thể chứng minh tracked/untracked hay clean working tree.
- Không có Figma frame riêng cho Parent management hoàn chỉnh, Sessions, Reports và Admin; các màn này theo Blueprint và visual language chung.
- Không có backend/API/auth session/persistence thật.
- Không có Supabase, database/RLS/storage, email delivery hoặc cookie enforcement thật.
- Không có MediaDevices, camera/mic recording, WebSocket/realtime server, OCR, page matching, STT, TTS hoặc AI thật.
- Upload, OCR progress, health, audit, tutor, comprehension, reports và lifecycle là deterministic typed mock.
- Admin và parent fixture graph độc lập; reload reset dữ liệu.
- Tutor/Comprehension bind canonical mock session; unknown session vẫn trả safe 404.
- Mock latency promise là hữu hạn nhưng không có AbortSignal ở service contract; UI guards ngăn state update muộn và subscription có cleanup.
- Chưa tích hợp một scanner accessibility tự động như axe; semantic, keyboard/focus, dialog và responsive được kiểm tra bằng component test, E2E và visual review.

## 16. Hướng dẫn chạy cho người mới

Từ thư mục `frontend` của repository:

```powershell
npm install
npm run dev
```

Mở http://localhost:3000. Tài khoản mock và state URL xem tại `README.md`.

Kiểm tra trước khi bàn giao:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npx playwright test
```

Nếu Windows báo `EPERM` ở artifact sinh tự động, dừng server Node đang chạy, xác minh đúng đường dẫn trong frontend rồi xóa `.next` hoặc `test-results` và chạy lại. Không cần tạo `.env`.

## 17. Kết luận

Frontend đáp ứng phạm vi Nhóm 1–6, route/navigation, responsive, typed mock architecture, safety invariant và các flow E2E đã nêu. Không có blocker frontend còn mở trong phạm vi nghiệm thu. Các giới hạn còn lại đều thuộc metadata Git, độ phủ Figma hoặc tích hợp backend/AI đã được loại khỏi phạm vi.
