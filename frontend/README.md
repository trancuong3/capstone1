# ReadAlong Vision — Frontend

ReadAlong Vision là giao diện web hỗ trợ ba mẹ chọn sách, tạo hồ sơ cho bé và theo dõi một buổi đọc tương tác. Repository hiện chứa bản frontend responsive dành cho máy tính, máy tính bảng và điện thoại.

Phiên bản này là **frontend demo dùng dữ liệu mock**. Bạn có thể chạy toàn bộ giao diện mà không cần backend, database, tài khoản Supabase hay file `.env`.

## Trạng thái dự án

Các khu vực giao diện đã có:

- Đăng nhập, đăng ký và khôi phục mật khẩu.
- Hồ sơ ba mẹ và hồ sơ bé.
- Thư viện, tìm kiếm, lọc và chi tiết sách.
- Luồng đọc mô phỏng cùng các trạng thái camera, microphone, kết nối, câu hỏi và hoàn thành.
- Lịch sử đọc, báo cáo tiến bộ và danh sách từ cần luyện.
- Khu vực Admin quản lý sách, trang sách, OCR/revision, audit log và health.

Những thao tác trên chỉ thay đổi dữ liệu trong bộ nhớ của trình duyệt. Tải lại trang có thể đưa dữ liệu về fixture ban đầu.

## Yêu cầu môi trường

- Node.js `>= 22.13.0` (khuyến nghị Node 22 LTS)
- npm 10 trở lên
- Trình duyệt hiện đại; Chromium được dùng cho Playwright

## Bắt đầu trong 5 phút

Sau khi clone repository, mở PowerShell hoặc Terminal tại thư mục dự án:

```powershell
cd readalong-vision
cd frontend
npm ci
npm run dev
```

Sau đó mở [http://localhost:3000](http://localhost:3000). Route `/` sẽ chuyển đến `/login`.

Nếu đã đứng sẵn trong thư mục `frontend`, chỉ cần chạy:

```powershell
npm ci
npm run dev
```

Dữ liệu đăng nhập minh họa:

- Phụ huynh: `minhanh@example.com` / `matkhau123`
- Admin: `admin@example.com` / `matkhau123`

Đây là tài khoản và mật khẩu giả chỉ dùng cho demo cục bộ. Chúng không mở được tài khoản hoặc hệ thống thật.

### Lộ trình xem nhanh

1. Mở `/login` và đăng nhập bằng tài khoản phụ huynh mock.
2. Tại `/dashboard`, chọn Bé An rồi mở thư viện sách.
3. Chọn “Chú Mèo Nhỏ”, xem trước trang và bắt đầu buổi đọc.
4. Mở `/reports` hoặc `/sessions` để xem dữ liệu báo cáo mẫu.
5. Mở `/admin/login` để xem luồng quản trị nội dung mock.

Để dừng development server, quay lại Terminal và nhấn `Ctrl+C`.

## Cấu trúc thư mục

```text
frontend/
├── app/                  # Next.js routes và layouts
├── components/           # Screen và UI component dùng chung
├── hooks/                # Hook truy cập typed services
├── lib/api/              # Service interfaces và error contract
├── lib/mock/             # Mock adapters, store và fixture
├── lib/utils/            # Mapper, parser và UI rules
├── public/               # Asset tĩnh xuất từ Figma
├── tests/                # Unit, component và Playwright tests
└── types/                # DTO và UI types
```

## Lệnh kiểm tra

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

- `npm run verify` chạy lần lượt Prettier check, ESLint, TypeScript và Vitest.
- `npm run test:e2e` build production trước, sau đó để Playwright khởi động server cục bộ.
- Sau `npm run build`, có thể tự chạy production bằng `npm run start -- --hostname 127.0.0.1`.

Người chỉ muốn xem giao diện không bắt buộc chạy các lệnh kiểm tra này. Thành viên chuẩn bị mở pull request nên chạy ít nhất `npm run verify` và `npm run build`.

## Route đã triển khai

| Khu vực  | Route                                  | Mục đích                                                   |
| -------- | -------------------------------------- | ---------------------------------------------------------- |
| Root     | `/`                                    | Chuyển hướng đến đăng nhập                                 |
| Auth     | `/login`                               | Đăng nhập phụ huynh                                        |
| Auth     | `/register`                            | Đăng ký tài khoản phụ huynh                                |
| Auth     | `/forgot-password`                     | Yêu cầu khôi phục mật khẩu                                 |
| Auth     | `/reset-password`                      | Đặt mật khẩu mới và trạng thái token                       |
| Parent   | `/dashboard`                           | Tổng quan gia đình và lối tắt đọc sách/báo cáo             |
| Parent   | `/profile`                             | Xem, chỉnh sửa hồ sơ phụ huynh                             |
| Parent   | `/children`                            | Danh sách hồ sơ bé                                         |
| Parent   | `/children/new`                        | Tạo hồ sơ bé; nhận `from=register` cho onboarding          |
| Parent   | `/children/[childId]`                  | Xem/chỉnh sửa hồ sơ bé thuộc tài khoản hiện tại            |
| Books    | `/books`                               | Tìm kiếm, lọc danh mục ACTIVE + VERIFIED                   |
| Books    | `/books/[bookId]`                      | Chi tiết, trang xem trước và bắt đầu đọc                   |
| Reading  | `/reading/[sessionId]`                 | Trình diễn trạng thái buổi đọc, không dùng camera/mic thật |
| Sessions | `/sessions`                            | Lịch sử buổi đọc theo bé                                   |
| Sessions | `/sessions/[sessionId]`                | Chi tiết lịch sử gắn revision                              |
| Reports  | `/reports`                             | Báo cáo tiến bộ 30 ngày                                    |
| Reports  | `/reports/difficult-words`             | Từ khó trong cửa sổ 90 ngày                                |
| Admin    | `/admin/login`                         | Đăng nhập Admin mock                                       |
| Admin    | `/admin/books`                         | Danh mục, tìm kiếm và lọc vận hành                         |
| Admin    | `/admin/books/new`                     | Tạo sách                                                   |
| Admin    | `/admin/books/[bookId]`                | Chi tiết sách, upload trang, lifecycle                     |
| Admin    | `/admin/books/[bookId]/pages/[pageId]` | Review OCR/revision, verify và reprocess                   |
| Admin    | `/admin/audit-logs`                    | Nhật ký kiểm toán an toàn                                  |
| Admin    | `/admin/health`                        | Trạng thái vận hành mô phỏng                               |

## Demo UI state

Query `state` chỉ chọn fixture giao diện cục bộ; không phải API/error code mới và không thay đổi contract đóng băng.

### Auth

- `/login?state=loading|invalid-credentials|safe-error`
- `/register?state=loading|email-used|validation-error|safe-error`
- `/forgot-password?state=loading|submitted|safe-error`
- `/reset-password?state=loading|invalid-token|expired-token|success|safe-error`

### Parent và hồ sơ

- `/dashboard?state=loading|empty|error`
- `/profile?state=loading|error`; edit, validation, submitting và success được kích hoạt bằng form
- `/children?state=loading|empty|error`
- `/children/new?state=error`
- `/children/new?from=register` cho bước tạo hồ sơ đầu tiên
- `/children/[childId]?state=loading|not-found|error`

ID bé có dữ liệu: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`. ID không thuộc tài khoản hoặc không tồn tại dùng cùng một safe 404 để tránh enumeration.

### Books

- `/books?state=loading|empty|error`
- Tìm kiếm, lọc lớp và no-result được kích hoạt trực tiếp trên trang
- `/books/[bookId]?state=loading|error|not-found|unavailable`

ID sách ACTIVE + VERIFIED mẫu: `20000000-0000-4000-8000-000000000001`.

### Reading

```text
/reading/mock-session-001?state=ready
/reading/mock-session-001?state=reading
/reading/mock-session-001?state=camera-denied
/reading/mock-session-001?state=microphone-denied
/reading/mock-session-001?state=page-confidence-low
/reading/mock-session-001?state=manual-page
/reading/mock-session-001?state=paused
/reading/mock-session-001?state=reconnecting
/reading/mock-session-001?state=reconnecting&reconnect=timeout
/reading/mock-session-001?state=stt-error
/reading/mock-session-001?state=tts-error
/reading/mock-session-001?state=page-turn
/reading/mock-session-001?state=question
/reading/mock-session-001?state=complete
```

Các trạng thái mất evidence (`PAUSED`, `RECONNECTING`, lỗi provider, camera/mic denied, `PAGE_CONFIDENCE_LOW`, page turn) ngừng suy luận lỗi đọc của bé.

### Sessions và Reports

- `/sessions?state=loading|empty|error|not-found`
- `/sessions/mock-session-001?state=loading|error|not-found|incomplete|no-events|no-questions`
- `/reports?state=loading|empty|error|not-found|no-prior-period`
- `/reports/difficult-words?state=loading|empty|error|not-found|insufficient-evidence`

Báo cáo dùng cửa sổ lịch 30 ngày, từ khó dùng 90 ngày, theo `Asia/Ho_Chi_Minh`. Metric không đủ dữ liệu giữ nguyên `null`, không đổi thành `0`.

### Admin

- `/admin/login?state=loading|invalid-credentials|unauthenticated|forbidden|error`
- `/admin/books?state=loading|empty|no-result|error|unauthenticated|forbidden`
- `/admin/books/new?state=error`
- `/admin/books/[bookId]?state=loading|error|invalid-upload|upload-failure|invalid-lifecycle`
- `/admin/books/[bookId]/pages/[pageId]?state=loading|error|ocr-reprocess-invalid-state`
- `/admin/audit-logs?state=loading|empty|error`
- `/admin/health?state=loading|degraded|unavailable|error`

Fixture Admin tiêu biểu:

- Book ACTIVE: `82000000-0000-4000-8000-000000000001`
- Book RETIRED: `82000000-0000-4000-8000-000000000002`
- Page/revision VERIFIED: `83000000-0000-4000-8000-000000000001`
- Page/revision PROCESSING: `83000000-0000-4000-8000-000000000002`
- Page/revision NEEDS_REVIEW: `83000000-0000-4000-8000-000000000003`

## Kiến trúc mock service

Luồng phụ thuộc là:

```text
page/screen → typed service interface → provider → mock adapter → local mock store/fixture
```

- `app/`: route entrypoint và parse query đã định kiểu; không chứa fixture/logic mock.
- `components/`: screen và component trình bày dùng lại.
- `types/`: DTO/type theo Blueprint và các UI view model có hậu tố `UI`.
- `lib/api/`: service interface, request/response contract và safe service error.
- `lib/mock/`: fixture/store cùng mock implementation, tách khỏi component.
- `lib/utils/`: mapper DTO → view model, scenario parser và quy tắc trình bày thuần.
- `components/providers/`: dependency injection; đây là điểm thay mock adapter bằng API adapter sau này mà không viết lại screen.

Service interface đang có:

- Auth: `AuthService`.
- Parent/Reading/Reports: `ProfileService`, `ChildService`, `BookService`, `ReadingService`, `ReadingSocketAdapter`, `DevicePermissionService`, `PageMatchService`, `TutorService`, `ComprehensionService`, `SessionService`, `ReportService`, `DifficultWordService`.
- Admin: `AdminAuthService`, `AdminBookService`, `AdminPageService`, `OcrReviewService`, `RevisionService`, `AuditService`, `HealthService`.

Component không import fixture trực tiếp. Subscription trả hàm cleanup; các mock delay là promise hữu hạn, còn screen bỏ qua kết quả đến muộn sau khi unmount hoặc khi request mới đã thay thế request cũ. Code không dùng `any` hoặc `@ts-ignore`.

Store Admin và store Parent/Reading/Reports là hai đồ thị fixture xác định, độc lập nhau. Vì vậy mutation trong khu vực Admin không tự lan sang catalog/báo cáo phía phụ huynh trong cùng bản demo; các invariant revision bất biến, reprocess và lịch sử được kiểm chứng riêng trong mock Admin.

## Design system và responsive

UI dùng cùng một cây component cho desktop/tablet/mobile; không có ứng dụng mobile riêng. Các node Mobile trong Figma chỉ là tham chiếu reflow tại 390px.

Token chính nằm ở `app/globals.css`:

- Font Nunito variable; heading `32px/800`, body và button `20px`, label `16px/700`
- Primary `#147d87`, ink `#213c42`, canvas `#f6faf8`, cream `#fff8eb`, sky `#ddf3f5`, border `#d5e3de`
- Spacing `4/8/12/16/24/32px`; radius control `16px`, card `24px`

Component dùng chung gồm `Button`, `Card`, `TextField`, `SelectField`, `Modal`, `StatusMessage`, `EmptyState`, `Skeleton`, `BrandHeader`, `AppShell`, book/child headers, book cards/page thumbnails, reading controls/status dialog và report metrics/charts.

Các viewport nghiệm thu mục tiêu: `1440`, `1024`, `768` và `390` px.

## Ranh giới frontend/backend

Chưa triển khai hoặc kết nối thật:

- FastAPI, Supabase Auth/PostgreSQL/Storage, RLS và database persistence
- Session/cookie auth enforcement; đăng nhập/đăng xuất hiện chỉ là UI mock
- HTTP API, WebSocket, reading-session token và realtime server
- Camera, microphone, MediaDevices, ghi/stream audio/video
- OpenCV, OCR/Tesseract, page matching thực, STT, TTS hoặc provider AI
- Alignment/scoring, reading-event inference, Tutor/comprehension engine thật
- Upload/storage, operational health và audit backend thật
- Email recovery/reset delivery thật

Camera/page preview, reconnect, OCR, upload progress, TTS help, comprehension, reports và lifecycle đều là trình diễn xác định bằng typed mock. Không tự động phát âm thanh. Expected answer không được đưa vào payload/UI trước khi trả lời; revision VERIFIED giữ bất biến và reprocess tạo revision mới trong mock store.

Khi tích hợp backend, giữ nguyên component và thay implementation tại các provider bằng API adapter tuân thủ DTO/status/error/authorization trong Blueprint. Không đưa Supabase service key hoặc credential provider vào frontend.

## Bảo mật khi phát triển

- Không commit `.env`, access token, API key, cookie, private key hoặc dữ liệu người dùng thật.
- Chỉ đưa biến môi trường không bí mật và bắt buộc cho trình duyệt vào `NEXT_PUBLIC_*`.
- Nếu sau này cần biến môi trường, commit `.env.example` chỉ chứa tên biến và giá trị minh họa.
- Tài khoản, UUID, session token và báo cáo hiện tại đều là fixture mock.
- Nếu một secret từng bị commit, phải thu hồi/rotate secret; xóa dòng khỏi commit mới là chưa đủ.

## Cách cộng tác

1. Đồng bộ nhánh mới nhất trước khi bắt đầu.
2. Tạo branch riêng, ví dụ `feature/book-search` hoặc `fix/mobile-navigation`.
3. Không commit `node_modules`, `.next`, `test-results`, `artifacts` hoặc `.env`.
4. Chạy kiểm tra trước khi push.
5. Mở pull request và mô tả route, state, test đã thay đổi.

Không tự thay đổi DTO, status, error code hoặc safety invariant nếu chưa thống nhất với tài liệu contract.

## Nguồn thiết kế và contract

- Blueprint v1.7.1 FINAL CODING FREEZE là nguồn contract/hành vi.
- Coding Handoff v1.7.1 quy định thứ tự ưu tiên và safety invariant.
- [Figma ReadAlong Vision](https://www.figma.com/design/gfqkWdrUEBr63jpJUS27eP) là nguồn giao diện trực quan. Thành viên cần được chủ file cấp quyền Figma riêng; không chia sẻ access token qua GitHub. File có frame riêng cho Auth, tạo/chọn hồ sơ, thư viện/chi tiết sách và Reading; các màn Parent management, Reports và Admin không có frame Web riêng nên dùng Blueprint cùng token/component Figma hiện hữu.
