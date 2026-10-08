# Phase 6 — Kiểm tra và bàn giao phạm vi dữ liệu thật

Ngày kiểm tra: 08/10/2026.

Repository: `D:\Project\capston1_new\capstone1`.
Nhánh: `feature/linh-real-data`.

## Kết luận

Đã thực hiện kiểm tra Phase 6. Các bộ test mới của phạm vi chuyển dữ liệu thật đạt; **toàn dự án chưa đạt điều kiện nghiệm thu production**, vì TypeScript/build và bộ test legacy vẫn lỗi.

Không sửa Auth, database, migration, env, dependencies hay các test legacy để làm kết quả xanh. Không commit/push, không pull main hoặc đổi nhánh. Các thay đổi chưa commit của Phase 1–5 được giữ nguyên.

Luồng runtime đã triển khai ở các phase trước vẫn là:

`app → component/hook → typed service trong lib/api → FastAPI router/service/repository → Supabase database`.

Phase 6 chỉ thêm bộ kiểm tra trình duyệt và báo cáo; không sửa code nghiệp vụ frontend/backend.

## Kết quả command thực tế

Các command frontend chạy tại `frontend`; command Python chạy tại `backend`.

| Command/kiểm tra                                                                                                     | Kết quả                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                                                                                                       | PASS, exit 0                                                                                                                            |
| `npm run typecheck`                                                                                                  | FAIL, exit 1: Auth so sánh `supabase` với `mock`, tests cũ import mock đã xóa; không có diagnostic ở các file Playwright mới            |
| `npm test` toàn frontend                                                                                             | FAIL: 47 files gồm 23 PASS và 24 FAIL; 240 tests thu thập được gồm 212 PASS và 28 FAIL; 14 suites lỗi khi thu thập vì thiếu module mock |
| Vitest riêng phạm vi dữ liệu thật, command bên dưới                                                                  | PASS: 8 files, 117 tests                                                                                                                |
| `npx playwright test --config=playwright.real-data.config.ts`                                                        | PASS, exit 0: 18 PASS, 4 SKIP có chủ ý; khoảng 1,7 phút                                                                                 |
| `npm run build` lần cuối                                                                                             | Compile thành công, FAIL tại TypeScript với các lỗi Auth/tests cũ; chưa tạo build production dùng được                                  |
| `npx prettier --check playwright.real-data.config.ts test/browser/real-data-fixture.ts test/browser/real-data.pw.ts` | PASS, exit 0                                                                                                                            |
| `git diff --check`                                                                                                   | PASS                                                                                                                                    |
| `.venv/Scripts/python.exe -B -m unittest test_data_access test_book_data test_parent_reports test_admin_data`        | PASS: 68 tests, exit 0                                                                                                                  |

Command Vitest đã chạy:

```powershell
npx vitest run test/api-client.test.ts test/real-book-service.test.ts test/real-books-ui.test.tsx test/real-parent-report-services.test.ts test/real-parent-reports-ui.test.tsx test/real-admin-services.test.ts test/real-admin-ui.test.tsx test/real-data-runtime-cleanup.test.tsx
```

Ở lần typecheck đầu, `.next/dev/types` còn tham chiếu hai API route đã bị xóa. Sau khi dev server tái sinh artifacts cho Playwright, lần typecheck/build cuối không còn hai diagnostic đó. Không xóa file source hay thay cấu hình TypeScript để bỏ qua lỗi.

## Playwright: phạm vi và giới hạn bằng chứng

Bộ kiểm tra mới chạy **dev server**, với HTTP test doubles cô lập. Đây là kiểm tra UI và integration giữa UI với typed adapters, **không phải E2E Supabase/FastAPI live**, không chứng minh email verification, đăng nhập thật hay production authorization hoạt động.

- Dùng cơ chế Auth fixture đã có trong repository; không thêm hoặc sửa bypass production. Fixture hiện có không hoạt động khi `NODE_ENV=production`.
- Token kiểm thử sinh ngẫu nhiên và được chia sẻ qua process environment giữa Playwright/server/worker. Không ghi token vào source hoặc `.env`.
- Dùng URL/key Supabase giả trong process của server kiểm thử, không dùng tài khoản hay key thật.
- Cookie SDK chứa session giả, chỉ phục vụ API bị intercept trong browser; không phải JWT được Supabase xác minh.
- Mọi browser request ngoài dev server và API test bị chặn. API test chỉ cho GET/OPTIONS; các request ghi hoặc endpoint không được khai báo khiến test thất bại.
- Fixture và SVG minh họa chỉ nằm trong `frontend/test/browser`, không được import bởi component/service runtime. Không khôi phục folder mock của ứng dụng.
- Không bật backend live và không thực hiện mutation vào Supabase trong Phase 6.

### Luồng đã kiểm tra trên desktop và mobile

1. Dashboard → chọn bé → thư viện → chi tiết sách; metadata hiển thị, preview unavailable và nút đọc bị khóa.
2. Tìm kiếm → không có kết quả → xóa bộ lọc bằng bàn phím → API lỗi an toàn → retry thành công. Query `state=empty` không thay dữ liệu API.
3. Catalog API trả rỗng và sách không tồn tại/không được cung cấp trả 404.
4. Lịch sử đã lưu → chi tiết buổi đọc chưa hoàn tất → số liệu báo cáo → từ khó; luyện từ chưa được triển khai không giả thành công.
5. History/reports/words trả 501 → thông báo chờ bổ sung → retry. Không biến lỗi/thiếu dữ liệu thành số 0 giả.
6. Admin catalog → metadata sách vẫn hiển thị khi dữ liệu trang chưa sẵn sàng → retry → audit nullable actor/resource → health và kiểm tra lại.
7. Admin OCR chỉ đọc → chọn revision đã lưu → không sửa văn bản/chạy OCR/tạo sách giả.

7 luồng × 2 project desktop/mobile = 14 ca. Thêm 4 ca route matrix = 18 ca đạt. Bốn bản lặp của matrix ở project mobile được skip vì matrix desktop đã tự kiểm tra cả bốn chiều rộng; không phải tính năng bị bỏ qua.

### Route matrix và responsive

Kiểm tra 15 route × 4 chiều rộng = 60 lượt mở trang:

| Nhóm                   | Route                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard/hồ sơ có sẵn | `/dashboard`, `/profile`, `/children`                                                                                                     |
| Sách Parent            | `/books`, `/books/[bookId]`                                                                                                               |
| Lịch sử/báo cáo Parent | `/sessions`, `/sessions/[sessionId]`, `/reports`, `/reports/difficult-words`                                                              |
| Admin                  | `/admin/books`, `/admin/books/[bookId]`, `/admin/books/[bookId]/pages/[pageId]`, `/admin/audit-logs`, `/admin/health`, `/admin/books/new` |

Chiều rộng: **1440px, 1024px, 768px, 390px**. Kiểm tra response 200, heading hiển thị, loading hoàn tất, nội dung Admin đã tải và không tràn ngang toàn trang. Không có `pageerror` hoặc console error ngoài lỗi HTTP 503 cố ý của preview trong fixture ở lần chạy cuối.

Đã lưu 30 ảnh full-page của 15 route tại 1440px/390px. Đã xem trực quan các ảnh đại diện Dashboard, thư viện, báo cáo, OCR review, audit ở cả hai kích thước và chi tiết sách 390px: bố cục/nhãn/nút không chồng lấp; thanh bộ lọc thư viện mobile cuộn ngang trong vùng riêng, không làm tràn trang. Đây không phải đối chiếu lại pixel-perfect với Figma.

Ảnh và JSON kết quả nằm dưới `frontend/test-results/real-data/` và `frontend/test-results/real-data-summary.json`, được Git ignore, không đưa vào source. Chạy lại bộ test sẽ tái tạo chúng.

Hai lỗi của bộ kiểm thử đã được sửa trong quá trình nghiệm thu:

- Đồng bộ token fixture giữa config/worker/server để tránh redirect nhầm về login.
- Chờ nội dung Admin tải trước screenshot và dùng `caret: "initial"`; screenshot mặc định từng thêm `caret-color: transparent` vào input trong lúc hydrate, gây cảnh báo hydration do chính test. Không sửa Auth hay thêm `suppressHydrationWarning` để che cảnh báo. Lần chạy cuối không còn cảnh báo này.

## File tạo trong Phase 6

1. `frontend/playwright.real-data.config.ts`: config riêng, server loopback port 3106, dummy env và hai viewport/project.
2. `frontend/test/browser/real-data-fixture.ts`: fixture HTTP/session chỉ cho test, chặn request ngoài phạm vi và request ghi.
3. `frontend/test/browser/real-data.pw.ts`: bảy luồng Parent/Admin và bốn route matrix responsive.
4. `REAL_DATA_PHASE6_REPORT.md`: báo cáo này.

Không sửa `playwright.config.ts`, `package.json`, lockfile, `.gitignore`, Auth guard, `lib/supabase`, model/schema/database hay `.env`. Không tạo `lib/http` và không đổi API/DTO. Git status tổng vẫn chứa các file Phase 1–5, không phải tất cả do Phase 6 tạo.

Tái sử dụng ứng dụng và các thành phần hiện tại: Dashboard/ChildProfileCard, các màn Books/Reports/Admin, typed service adapters, providers/hooks, Button/Card/StatusMessage/EmptyState và cơ chế Auth fixture có sẵn. Không thêm UI framework hoặc dependency.

## Các điểm còn chặn nghiệm thu toàn dự án

### 1. Auth và test legacy

- Chín diagnostic TS2367 nằm ở `components/auth`: login, register, forgot-password và reset-password vẫn có nhánh so sánh mock, trong khi mode đã cố định là Supabase.
- `frontend/tests/**` vẫn import `@/lib/mock/*` đã bị xóa; một số test còn kỳ vọng provider/demo/Reading mock cũ.
- Cần task/phạm vi riêng được nhóm chấp thuận để dọn nhánh Auth không còn dùng và migrate test legacy theo service hiện tại. Không phục hồi mock runtime, xóa tests hay dùng `ignoreBuildErrors` để làm xanh.

### 2. Dữ liệu Supabase chưa khớp contract đầy đủ

Các thiếu hụt ảnh/revision/bbox, lịch sử và report đã ghi trong `REAL_DATA_PHASE3_REPORT.md`/`REAL_DATA_PHASE4_REPORT.md` vẫn chưa được sửa trong database. Phase 6 không chạy lại probe live; số liệu snapshot của Phase 4 không phải tình trạng live đã xác nhận lại hôm nay.

Nhóm database/backend cần thống nhất mapping và bổ sung dữ liệu hợp lệ trước khi nghiệm thu preview/OCR/reports live. Không đoán Storage bucket, URL ảnh, revision number hoặc bbox; không chế dữ liệu báo cáo thay cho dữ liệu thiếu.

### 3. Chức năng chưa có API và bảo mật ngoài phạm vi

- Reading/AI/realtime/tutor/comprehension vẫn unavailable; nút bắt đầu đọc không tạo session giả.
- Ghi/upload/OCR/verify/lifecycle Admin chưa nối API: UI chỉ đọc hoặc hiển thị chưa sẵn sàng.
- Guard đã kiểm tra ở các API đọc mới không đồng nghĩa toàn bộ legacy CRUD backend đã được bảo vệ. Cần audit riêng trước khi deploy; không coi 68 unit tests là bằng chứng mọi endpoint đều an toàn.

## Bàn giao và bước tiếp theo

1. Nhóm review diff của branch `feature/linh-real-data` và báo cáo Phase 2–6.
2. Thống nhất người sửa Auth/tests legacy và người bổ sung contract dữ liệu Supabase; tránh hai người cùng sửa một file.
3. Sau khi sửa các blocker, chạy lại lint/typecheck/full tests/build, sau đó đăng nhập Parent/Admin thật trên local frontend/backend để kiểm tra quyền và dữ liệu thật. Không gửi mật khẩu/key qua chat.
4. Chỉ commit/push/tạo PR khi bạn yêu cầu. Chưa đủ bằng chứng để kết luận production-ready.

Đã dừng dev server kiểm thử khi Playwright kết thúc; kiểm tra cuối không còn listener tại 3000, 3106 hoặc 8000. Dừng công việc ở Phase 6, không tự chuyển sang task khác.

## Cập nhật sau kiểm tra local và trước commit

- Đã sửa validator UUID của sách và nhật ký Admin để chấp nhận UUID dạng canonical mà PostgreSQL/Pydantic hỗ trợ (`z.guid()`), không đổi ID hay dữ liệu trong database. Đã thêm regression tests cho UUID không có RFC version/variant bits và ID không hợp lệ.
- Đã bổ sung `NEXT_PUBLIC_API_URL=http://127.0.0.1:8000` vào `frontend/.env.local` để local frontend gọi backend. File này được Git ignore, không nằm trong commit; mỗi thành viên tự cấu hình environment local.
- Người dùng xác nhận Kho sách hoạt động. Payload nhật ký từ database đã qua validator frontend sau khi sửa, không trả raw metadata nhạy cảm.
- Người dùng tự chạy SQL thêm hai báo cáo thử nghiệm cho hồ sơ bé của mình: kỳ 30 ngày và 90 ngày. Người dùng xác nhận cả Tiến bộ và Từ cần luyện hiển thị qua FastAPI/database. Đây là dữ liệu seed để kiểm tra đường đọc, không phải kết quả đọc thực tế hay báo cáo do hệ thống tự tổng hợp. SQL và dữ liệu seed không nằm trong commit này.
- Trước commit, đã chạy lại `npm run lint` (PASS), bộ Vitest tám file nêu trên (PASS: **133 tests**) và bốn bộ unittest backend (PASS: **68 tests**).
- Typecheck, full legacy tests, Playwright và production build không chạy lại trong lượt commit này. Các lỗi và giới hạn bằng chứng ghi ở trên vẫn chưa được giải quyết; không kết luận production-ready.
- Frontend/backend local đã dừng theo yêu cầu người dùng; commit/push không khởi động lại server hoặc ghi database.
