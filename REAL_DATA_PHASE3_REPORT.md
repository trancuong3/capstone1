# Phase 3 — Lịch sử đọc, báo cáo và từ khó của Parent

Ngày: 2026-10-08. Repository: `D:\Project\capston1_new\capstone1`.
Nhánh giữ nguyên: `feature/linh-real-data`.

Phase 3 trong báo cáo này theo kế hoạch chốt lại trong hội thoại: chỉ hoàn thiện các tab dữ liệu Parent, không phải triển khai Admin hay Auth. Các thay đổi chưa commit từ trước được giữ nguyên.

## Route và luồng dữ liệu

| Route UI | Service frontend | GET FastAPI |
| --- | --- | --- |
| `/sessions` | `SessionService.list`, `getBook` | `/reading/history?child_id=...&cursor=...&limit=...`; `/reading/history/{session_id}/book` |
| `/sessions/[sessionId]` | `SessionService.get`, `getBook`, ChildService hiện có | `/reading/history/{session_id}`; `/reading/history/{session_id}/book` |
| `/reports` | `ReportService.get` | `/system/progress/{child_id}?period_start=...&period_end=...` |
| `/reports/difficult-words` | `DifficultWordService.list` | `/system/difficult-words/{child_id}?period_start=...&period_end=...` |

Luồng giữ nguyên mẫu Dashboard: page → screen → hooks/provider hiện có → `lib/api` → router → Service/Repository trong file router → ORM/database.

Đã bổ sung GET `/reading/history/{session_id}/book` **trong router reading hiện có**, dùng lại `CatalogBookResponse`/Book DTO, không thay đổi response/status của endpoint legacy. `SessionService.getBook` là phương thức đọc bổ sung để nối endpoint này; các phương thức cũ vẫn giữ nguyên.

## Hoàn thiện trong lượt này

- Lịch sử không tra sách từ catalog ACTIVE hiện tại nữa. Sách RETIRED vẫn có thể hiển thị metadata trong phiên thuộc phụ huynh đang đăng nhập; điều này không làm sách RETIRED xuất hiện trong thư viện để bắt đầu đọc.
- Backend kiểm tra role Parent và truy vấn theo `ChildProfile.ParentId`. Tài nguyên không thuộc tài khoản trả safe 404 trước khi lấy events/assessment/answers.
- Phân trang được giới hạn ở component lịch sử; không sửa helper dùng chung trong `lib/utils`. Cursor backend kiểm tra ASCII, độ dài và giới hạn, không chuyển chuỗi số quá dài thành int không kiểm soát.
- Frontend validate DTO, child ID/session ID, mối liên kết event/answer và kỳ báo cáo. Metadata sách sai ID không được hiển thị.
- Loading, empty thật, not-found, safe error/retry và unavailable được giữ riêng. Các màn unavailable có retry và điều hướng quản lý hồ sơ bé.
- Duration lấy từ timestamp hợp lệ; phiên chưa kết thúc giữ null. Không coi wall-clock duration là active-reading time.
- Assessment không tương thích giữ null. Không remap COMPLETED/IN_PROGRESS, MISPRONUNCIATION/DETECTED thành enum frontend khi chưa được nhóm chốt.
- Events không xuất raw metadata. Câu hỏi đọc hiểu không xuất ExpectedAnswer/AcceptedAnswers; chỉ hiện câu trả lời thực tế và kết quả có sẵn.
- Revision đã chọn lấy từ phiên; revision tham chiếu lấy từ sự kiện đã ghi nhận, không thay bằng pointer hiện tại. UI nói rõ nguồn và hiển thị “Chưa ghi nhận” khi chưa có ID.
- Báo cáo/từ khó đọc JSON đã lưu nếu đầy đủ contract. Thiếu báo cáo, thiếu key hoặc JSON không tương thích trả unavailable, không tạo báo cáo 0/từ giả.
- Nội dung UI ghi đúng nguồn báo cáo đã lưu, không tuyên bố frontend/backend đã chạy thuật toán tổng hợp chưa triển khai.
- Luyện từ ngoài phạm vi: từ chối an toàn, không gọi API ghi, không phát âm thanh hoặc báo thành công mô phỏng.

## File chỉnh sửa/tạo trong lượt Phase 3

| File | Nội dung |
| --- | --- |
| `backend/app/api/routes/reading.py` | Đọc sách theo phiên có owner guard; cursor/duration an toàn; gỡ raw event metadata |
| `frontend/lib/api/session-service.ts` | Đọc history/detail/book qua adapter typed và kiểm tra liên kết DTO |
| `frontend/lib/api/report-service.ts` | Validate child và kỳ báo cáo, không fallback |
| `frontend/lib/api/difficult-word-service.ts` | Rà factory đọc thật và thao tác practice chưa sẵn sàng; format trong phạm vi |
| `frontend/components/reports/session-history-screen.tsx` | Metadata theo phiên, phân trang giới hạn, unavailable/retry |
| `frontend/components/reports/session-detail-screen.tsx` | Metadata theo phiên, nguồn revision đúng, unavailable/retry |
| `frontend/components/reports/progress-report-screen.tsx` | Unavailable/retry và mô tả nguồn báo cáo |
| `frontend/components/reports/difficult-words-screen.tsx` | Unavailable/retry, mô tả dữ liệu thật, không claim thuật toán chưa chạy |
| `frontend/components/reports/difficult-word-item.tsx` | Lỗi practice an toàn; không hiển thị thành công/mô phỏng giả |
| `backend/test_parent_reports.py` | Mới: 26 test history/report/ownership/HTTP/contract |
| `frontend/test/real-parent-report-services.test.ts` | Mới: test service đọc thật với HTTP/token test doubles |
| `frontend/test/real-parent-reports-ui.test.tsx` | Mới: test UI dữ liệu/empty/loading/retry/not-found/unavailable/pagination |
| `REAL_DATA_PHASE3_REPORT.md` | Báo cáo này |

Các app pages, schema reading/system và factory wiring đã có trong working tree được rà soát và tái sử dụng, không viết lại trong lượt này. Không sửa thêm Auth/Admin, Books Phase 2, provider dùng chung, model, migration, env hoặc dependencies; không tạo `lib/http` hay thư mục backend services/repositories.

## Command và kết quả thực tế

Frontend chạy trong `frontend/`, backend trong `backend/`.

| Command/check | Kết quả |
| --- | --- |
| `npx vitest run test/api-client.test.ts test/real-book-service.test.ts test/real-books-ui.test.tsx test/real-parent-report-services.test.ts test/real-parent-reports-ui.test.tsx` | PASS: 5 files, 70 tests, gồm 39 test Phase 3 và 31 regression Phase 2/API |
| `.\.venv\Scripts\python.exe -B -m unittest test_data_access test_book_data test_parent_reports -v` | PASS: 45 tests, gồm 26 Phase 3 và 19 regression identity/catalog |
| `npm run lint` | PASS sau khi sửa key trong các component test |
| Prettier check các file frontend Phase 3 | PASS; đã format lại đúng file có cảnh báo |
| `npm run typecheck` | FAIL: lỗi có sẵn ở Auth so sánh mode supabase/mock, generated validator trỏ route đã xóa và test cũ import mock đã xóa; không có diagnostic ở các file Phase 3 mới/sửa |
| `npm run build` | Compile thành công, FAIL ở TypeScript do các lỗi nêu trên; không coi production build đã đạt |
| `git diff --check` | PASS |
| Rà runtime import `lib/mock`, `any`, `@ts-ignore` trong API/screens/pages Phase 3 | Không tìm thấy |

Test dùng fixture/HTTP doubles **chỉ trong test**, không đưa dữ liệu mẫu vào runtime. Chưa chạy toàn bộ suite legacy để tuyên bố đạt, chưa chạy Playwright/trực quan ở lượt này.

## Đối chiếu database thật — chỉ đọc

Đã dùng kết nối backend hiện có, transaction READ ONLY, statement timeout, rollback. Chỉ in tổng số, không in tên, ID hồ sơ, credential hoặc raw report/event.

Kiểm tra các hồ sơ có parent role trong database:

- Hồ sơ bé đã kiểm tra: **5**.
- Trang đầu lịch sử (limit 2) tương thích, tải được cả metadata sách: **2 hồ sơ**.
- Trang đầu lịch sử chưa tương thích DTO: **3 hồ sơ**.
- Báo cáo sẵn sàng cho kỳ mặc định đang truy vấn: **0/5**.
- Từ khó sẵn sàng cho kỳ mặc định đang truy vấn: **0/5**.

Đây là kiểm tra trực tiếp Repository/Service với database thật, không phải đăng nhập một tài khoản thật qua HTTP/browser. Chưa xác nhận chi tiết mọi phiên hoặc mọi trang lịch sử bằng dữ liệu live. Việc 2 trang đầu đạt không đảm bảo các trang cũ có enum/JSON tương thích.

## Giới hạn và bàn giao

- Những mục chưa có hoặc chưa tương thích báo chưa sẵn sàng và có retry; không che thành empty hoặc bịa dữ liệu. Nhóm phụ trách contract/data cần chốt mapping state/event và dữ liệu report/evidence trước khi các mục đó hiển thị đầy đủ.
- Không tự chuyển avg_fluency/total_books hay Accuracy/WCPM thành các metric frontend khác, không tự chọn thuật toán difficulty score.
- Không triển khai ghi báo cáo, tạo bằng chứng, TTS/AI/realtime hoặc chỉnh database trong task này.
- Build/typecheck vẫn cần xử lý lỗi ngoài phạm vi trước nghiệm thu toàn dự án. Các API legacy thiếu guard vẫn là việc riêng của người phụ trách backend; báo cáo này không chứng nhận an toàn cho toàn server.
- Chưa commit/push, không tự chuyển sang Phase 4.
