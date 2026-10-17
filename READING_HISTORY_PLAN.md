# Task 1 — Lịch sử đọc: kế hoạch triển khai

## Trạng thái Phase 1

- Ngày khảo sát: 2026-10-17, múi giờ `Asia/Ho_Chi_Minh`.
- Repository: `D:\Project\capston1_new\capstone1`.
- Nhánh: `feature/linh-reading-history`.
- Điểm xuất phát: `main` sau `git pull --ff-only origin main`, commit `93900ef0c39dbfe8199b5b1f99ae6bb9d394038f`.
- Phase 1 chỉ tạo nhánh, khảo sát code/database, chạy baseline và lập tài liệu này. Chưa thay đổi chức năng.
- Không chạy ứng dụng, ghi database, commit, push hoặc tạo PR trong Phase 1.

## 1. Mục tiêu và giới hạn

Hiển thị lịch sử đã lưu của đúng gia đình: chọn hồ sơ bé, xem các phiên mới nhất, phân trang và mở chi tiết. Phân biệt phiên chưa hoàn thành, phiên hoàn thành nhưng thiếu dữ liệu và phần dữ liệu chưa tương thích. Không dùng mock để lấp dữ liệu thiếu.

Làm xong và tích hợp Task 1 trước khi triển khai Task 2 — Tiến bộ đọc. Tài liệu này không quyết định hoặc triển khai thuật toán tổng hợp tiến bộ.

Không sửa luồng đăng nhập/đăng ký, dashboard, admin, từ cần luyện, OCR/camera, mic, âm thanh, AI tutor, thuật toán chấm đọc, luồng tạo/kết thúc phiên, cấu hình/key hoặc HTTP client dùng chung. Không thêm bảng, migration, dữ liệu mẫu hay SQL INSERT/UPDATE/DELETE. Không tách lại thư mục Service/Repository chỉ để thay kiến trúc.

## 2. Luồng thực tế đã kiểm tra

Frontend hiện đi qua page trong `app/(app)/sessions`, `SessionHistoryScreen`/`SessionDetailScreen`, `sessionService` trong `frontend/lib/api/session-service.ts`, rồi `requestApi` có xác thực và Zod validation. Danh sách lấy thêm metadata sách theo từng phiên để tạo view-model.

### API danh sách

- API: `GET /reading/history`.
- Router: `backend/app/api/routes/reading.py`, hàm `get_owned_history`.
- Input: `child_id` UUID; `limit` từ 1 đến 100, mặc định 20; cursor hiện có dạng `page-N`, giới hạn trang 100000.
- Service: `HistoryService.list` kiểm tra role parent, quyền sở hữu hồ sơ, giải mã cursor và tạo response.
- Repository: `HistoryRepository.owned_child`, `sessions`; query join `ChildProfile`, lọc parent và child, sắp xếp `StartedAt DESC, Id DESC`, offset và lấy `limit + 1`.
- ORM: `ReadingSession`, `ChildProfile` trong `backend/app/models`.
- PostgreSQL: `public.readingsessions`, `public.childprofiles`; role lấy từ `public.profiles`.
- Response hiện tại: `SessionHistoryRead`, các phần tử `SessionSummaryRead` trong `backend/app/schemas/reading.py`.

### API chi tiết

- API: `GET /reading/history/{session_id}`.
- Router: cùng file, hàm `get_owned_session_detail`; path UUID và dependency xác thực được kiểm tra trước.
- Service: `HistoryService.get`, `summary`; kiểm tra parent, lấy phiên thuộc gia đình rồi mới đọc dữ liệu liên quan.
- Repository: `session`, `events`, `fluency`, `questions`, `answer`.
- ORM/tables: `ReadingSession/readingsessions`, `ChildProfile/childprofiles`, `ReadingEvent/readingevents`, `FluencyAssessment/fluencyassessments`, `ComprehensionQuestion/comprehensionquestions`, `ComprehensionAnswer/comprehensionanswers`.
- Event sắp theo `StartMs, Id`; assessment lấy bản mới nhất; câu hỏi có thứ tự ổn định và câu trả lời mới nhất.
- Response hiện tại: `SessionDetailRead`; metadata sự kiện bị loại khỏi public response, không trả expected/accepted answers.

### API metadata sách lịch sử

- API: `GET /reading/history/{session_id}/book`.
- Router: cùng file, hàm `get_owned_session_book`.
- Service/Repository: `HistoryService.book` → `HistoryRepository.session_book`.
- ORM/tables: `Book/books` join `ReadingSession/readingsessions` và `ChildProfile/childprofiles`, lọc đúng parent.
- Response: `CatalogBookResponse` trong `backend/app/schemas/book.py`.
- Không lọc theo điều kiện được đọc ở catalog hiện tại: sách đã retire vẫn có metadata trong lịch sử nếu bản ghi còn tồn tại. Giữ hành vi này.

### Đối chiếu chuẩn và xử lý lỗi

Theo `BACKEND_FLOW_STANDARD.md`, request đi qua Router → validation → Service → Repository → ORM/PostgreSQL → response schema → JSON. Các bước của history đã có nhưng `HistoryService` và `HistoryRepository` đang được khai báo ngay trong file router. Giữ nguyên vị trí, không refactor ngoài yêu cầu.

History là luồng đọc database thật, không đọc fixture. Supabase Auth là phụ thuộc xác thực; các API history trên không gọi model AI/âm thanh. Query SELECT dùng AsyncSession hiện có, không có bước ghi/commit trong history. DB/transport lỗi phải là lỗi an toàn, không biến thành danh sách rỗng hoặc mock. Tài nguyên không thuộc gia đình trả 404; role không phù hợp trả 403; query/path sai trả lỗi validation. Hiện dữ liệu không khớp response schema có thể trả 501.

`HistoryService.require_child` còn được Progress sử dụng; `require_parent` còn được camera sử dụng. Không đổi hành vi các helper dùng chung đó trong task này.

## 3. Kết quả khảo sát database chỉ đọc

Đã truy vấn bằng transaction `READ ONLY`, có timeout và rollback. Không sửa dữ liệu. Các con số dưới đây là tổng dự án tại thời điểm khảo sát, không phải dữ liệu của riêng một tài khoản và có thể thay đổi.

| Nội dung           | Kết quả                                                                          | Ý nghĩa đối với history                                               |
| ------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Bảng nguồn         | Đủ các bảng phiên, bé, sách, sự kiện, fluency, câu hỏi, câu trả lời              | Không cần tạo thêm bảng để đọc lịch sử                                |
| Phiên đọc          | 41: `IN_PROGRESS` 23, `COMPLETED` 16, `PAUSED` 1, `ABORTED` 1                    | DB dùng state khác enum public hiện tại                               |
| Ràng buộc state DB | `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `ABORTED`                                  | Đây không chỉ là dữ liệu cũ; writer hiện tại cũng ghi các giá trị này |
| Thời gian          | Có 2 phiên `COMPLETED` thiếu `endedat`; không thấy duration âm                   | Không được kết luận chưa hoàn thành chỉ vì duration null              |
| Dữ liệu chi tiết   | Mỗi bảng event, assessment, question, answer có 5 dòng                           | Có dữ liệu thật, nhưng chưa chắc đúng public DTO hiện tại             |
| Event              | Có `MISPRONUNCIATION`; status có `DETECTED`, `FEEDBACK_GIVEN`, `IGNORED_BY_GATE` | Enum DTO hiện tại không nhận những giá trị này                        |
| Metrics JSON       | Các key ghi nhận là `Accuracy`, `WCPM`                                           | Không đủ căn cứ chuyển thành toàn bộ metrics snake_case hiện tại      |
| Độ khó câu hỏi     | Lưu chuỗi; các dòng khảo sát không phải chuỗi số                                 | DTO hiện yêu cầu float, có thể làm cả chi tiết trả 501                |

Không lưu tên, email, ID tài khoản, nội dung câu hỏi/câu trả lời hay credentials vào tài liệu khảo sát.

### Nguyên nhân tương thích đã xác nhận từ code

1. Writer `reading_content_service.py` tạo phiên bằng `IN_PROGRESS`, kết thúc bằng `COMPLETED`; endpoint đọc nội dung đã có mapping trạng thái riêng.
2. `HistoryService.summary` truyền nguyên state vào `SessionSummaryRead`, vốn chỉ nhận các trạng thái UI như `PAGE_READY`, `LISTENING`, `FINISHED`… Vì thế dữ liệu thực tế có thể làm danh sách trả 501. Zod frontend cũng đang thiếu state DB.
3. Chi tiết validate toàn bộ event và question trong cùng khối; enum event hoặc độ khó không tương thích có thể chặn cả phiên.
4. Assessment không khớp hiện bị đổi thành null, chưa phân biệt được không có assessment với có dữ liệu nhưng khác định dạng.
5. `formatDuration(null)` dùng chung đang trả “Chưa hoàn tất”, sai nghĩa với phiên hoàn thành thiếu giờ kết thúc.
6. Test cũ coi `IN_PROGRESS`/`COMPLETED` là không hỗ trợ. Baseline xanh không chứng minh tương thích database hiện tại.

## 4. Hợp đồng đọc sẽ áp dụng trong Phase 2–4

### Trạng thái và thời gian

- Dùng schema/type riêng cho summary lịch sử; không nới enum state của bộ đọc trực tiếp chỉ vì history.
- `COMPLETED` → public history `FINISHED`, cùng ý nghĩa hoàn thành với mapper đang có của reading content.
- `IN_PROGRESS` giữ là `IN_PROGRESS` trong history, nhãn “Đang thực hiện”; không giả định đang nghe mic hay đã nhận trang.
- `PAUSED`, `ABORTED` giữ nguyên; các state public đang hỗ trợ được giữ tương thích.
- State thực sự chưa biết không được âm thầm đổi thành `PAGE_READY`/`FINISHED`. Trả lỗi contract an toàn khi không thể đọc phần cốt lõi.
- Duration chỉ bằng `ended_at - started_at` nếu hai mốc hợp lệ; không thay bằng thời gian hiện tại, thời gian đọc tích cực hay số 0 tự tạo. Đây là thời gian trôi qua của phiên, có thể bao gồm tạm dừng.
- Phiên hoàn thành thiếu ended_at vẫn hiển thị hoàn thành, duration “Chưa có dữ liệu thời lượng”. Dùng formatter dành cho history, không đổi formatter của Progress.
- Hiển thị giờ Việt Nam `Asia/Ho_Chi_Minh`; giữ timestamp và phép tính thời lượng ở dạng datetime có timezone.

### Chi tiết tùy chọn

- Phần cơ bản của phiên không bị che chỉ vì dữ liệu tùy chọn khác định dạng. Thêm trạng thái khả dụng cho từng nhóm: không có dữ liệu / có dữ liệu đọc được / có dữ liệu nhưng chưa hỗ trợ hoặc chỉ đọc được một phần.
- Dữ liệu hợp lệ vẫn hiển thị; dữ liệu không hợp lệ không được bỏ rồi báo “không có”. Nếu một nhóm đọc được một phần, phải có thông báo rõ.
- Event history hỗ trợ thêm đúng các type/status đã xác minh, bằng DTO riêng thay vì đổi enum event của bộ đọc. Giữ ý nghĩa trạng thái: `DETECTED` không phải `CONFIRMED`; `MISPRONUNCIATION` không tự đổi thành `SUBSTITUTION`.
- Chỉ sự kiện thực sự `CONFIRMED` mới có thể mang nhãn bằng chứng đã xác nhận theo quy tắc hiện có. Các trạng thái chưa xác nhận không dùng để kết luận trẻ đọc sai.
- Câu hỏi/đáp án hiển thị trường đã lưu và được phép công khai. Độ khó history cho phép số hoặc nhãn chuỗi đã validate, không gán mức chữ thành điểm số. Source span thiếu/khác định dạng là tùy chọn, không được chặn prompt/answer hợp lệ.
- Giữ chấm đúng/sai null là chưa chấm. Không trả expected/accepted answers hoặc metadata JSON thô.
- Metrics khác định dạng báo chưa hỗ trợ, không tự suy luận đơn vị `Accuracy` hoặc quy đổi `WCPM` thành `reading_wpm`. Không tính lại điểm đọc trong task history.
- Điểm `Score` hợp lệ đã lưu vẫn được trả và hiển thị khi JSON metrics chưa tương thích; trường metrics để null và nhóm đánh giá mang trạng thái `partial`. Không vứt bỏ điểm thật cùng với JSON chưa hỗ trợ.
- Chỉ trả revision ID thực sự ghi nhận; không thay bằng revision hiện tại của sách. `report_id` không có liên kết thật thì để null.

### Phân trang, quyền và điều hướng

- Giữ query/cursor `page-N` và sort `StartedAt DESC, Id DESC`; lấy `limit + 1` để tính next cursor. Đây là offset pagination, không cam kết snapshot khi có phiên mới chèn giữa hai lần tải.
- Frontend dùng next cursor từ API khi đi tiếp. Chọn bé khác phải reset trang và không để response cũ ghi đè dữ liệu bé mới.
- Chi tiết mở từ danh sách giữ child/page trong liên kết quay lại; chỉ nhận UUID và số trang hợp lệ, không nhận URL redirect tùy ý. Mở trực tiếp chi tiết vẫn hoạt động.
- Không hiện dữ liệu gia đình khác; child/session/book phải được kiểm tra quyền ở backend, không chỉ dựa vào selector frontend.
- Database rỗng thật mới hiện empty state. Loading, lỗi quyền, lỗi mạng và định dạng chưa hỗ trợ không giả thành empty.

## 5. File dự kiến và ranh giới chống conflict

| File                                                                                   | Thay đổi được phép ở các phase tiếp theo                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `backend/app/api/routes/reading.py`                                                    | Chỉ block HistoryRepository/HistoryService và 3 endpoint history nếu cần; không sửa camera/create/finish |
| `backend/app/schemas/reading.py`                                                       | DTO history riêng và response detail liên quan; giữ hợp đồng live reading                                |
| `backend/test_parent_reports.py`                                                       | Sửa đúng kỳ vọng history đã cũ, giữ nguyên test Progress/ownership chung                                 |
| `backend/test_reading_history.py` (mới nếu cần)                                        | Test chuyên biệt tương thích dữ liệu history và HTTP contract                                            |
| `frontend/lib/api/session-service.ts`                                                  | Zod/type cho API history; giữ kiểm tra response ID và ownership                                          |
| `frontend/types/reading.ts`                                                            | Thêm history-only summary/event/question type và cập nhật detail/history response; không đổi live enums  |
| `frontend/types/reports.ts`                                                            | Chỉ type summary của history view-model, không đổi type/logic Progress                                   |
| `frontend/lib/utils/report-mappers.ts`                                                 | Mapper/formatter riêng history; không sửa `mapReportMetrics` hoặc hành vi Progress                       |
| `frontend/components/reports/session-history-screen.tsx`                               | Danh sách, chọn bé, cursor, state UI, response muộn                                                      |
| `frontend/components/reports/session-history-item.tsx`                                 | Nhãn trạng thái/thời lượng, liên kết chi tiết giữ ngữ cảnh                                               |
| `frontend/components/reports/session-detail-screen.tsx`                                | Thông tin thật, availability từng nhóm, liên kết quay lại                                                |
| `frontend/components/reports/session-event-list.tsx`                                   | Nhãn history event/state đã xác minh, không khẳng định lỗi khi chưa xác nhận                             |
| `frontend/app/(app)/sessions/page.tsx`, `sessions/[sessionId]/page.tsx`                | Chỉ khi cần truyền/validate ngữ cảnh phân trang quay lại                                                 |
| `frontend/test/reading-history-services.test.ts` (mới)                                 | Test contract API history                                                                                |
| `frontend/test/reading-history-ui.test.tsx` (mới)                                      | Test list/detail, nhãn thiếu dữ liệu, đổi bé, phân trang                                                 |
| `frontend/test/fixtures/report-data-fixture.ts`                                        | Chỉ cập nhật fixture history nếu DTO history thay đổi, không tạo fixture runtime                         |
| `frontend/test/real-parent-report-services.test.ts`, `real-parent-reports-ui.test.tsx` | Chỉ assertion history bị ảnh hưởng; chạy lại cả file để kiểm tra hồi quy Progress                        |

Không sửa file chỉ để format toàn bộ. Các file router/schema/mapper/type là file dùng chung nên vẫn có nguy cơ conflict nếu đồng đội sửa cùng đoạn; nhánh riêng không bảo đảm hết conflict. Giữ diff theo block, thông báo team các file trên và không gộp Task 2 vào PR này. Nếu cần thêm file ngoài danh sách, giải thích lý do liên quan trực tiếp trước khi mở rộng phạm vi.

## 6. Các phase tiếp theo và điều kiện hoàn tất

### Phase 2 — Backend history

Thêm history-only DTO và mapping state, xử lý dữ liệu tùy chọn theo hợp đồng mục 4. Giữ authorization, sort, paging và metadata sách lịch sử hiện có. Cập nhật các test cũ coi state thật là unsupported, bổ sung HTTP contract test. Không sửa writer hoặc DB.

Hoàn tất khi list đọc được state DB thật; detail cơ bản không chết vì nhóm tùy chọn; null/unsupported được phân biệt; kiểm tra ownership và dữ liệu riêng tư vẫn đạt. Backend thay đổi trước có thể chưa đọc được bởi frontend cũ; chỉ nghiệm thu toàn luồng sau Phase 3–4.

### Phase 3 — Frontend danh sách

Đồng bộ history DTO/Zod, hiển thị trạng thái và duration đúng; xử lý chọn bé, phân trang, loading/empty/error và response muộn. Không thay giao diện dashboard/header/footer.

Hoàn tất khi danh sách dùng API thật, không mock fallback, chọn bé không lẫn dữ liệu, thứ tự mới nhất trước và phân trang hoạt động.

### Phase 4 — Frontend chi tiết

Đồng bộ DTO detail, event labels và trạng thái khả dụng từng nhóm. Hiển thị prompt/answer được lưu, giữ null là chưa biết, không suy diễn metrics. Giữ child/page khi quay lại danh sách.

Hoàn tất khi dữ liệu cơ bản luôn đọc được nếu hợp lệ; nhóm chưa hỗ trợ có thông báo đúng; không làm lộ metadata/đáp án chuẩn hoặc kết luận sai về trẻ.

### Phase 5 — Kiểm thử và người dùng nghiệm thu

- Có/không có hồ sơ bé; lịch sử rỗng thật; nhiều phiên cần phân trang; cùng thời điểm bắt đầu; đổi bé khi request chưa xong.
- Các state DB thật và state UI đã hỗ trợ; state lạ; duration bằng 0 thật, null, âm/không hợp lệ; completed thiếu ended_at.
- Parent khác/role khác/token thiếu; child/session/book không thuộc gia đình; sách retire.
- Event type/status thật, không biến detected thành confirmed; dữ liệu optional thiếu, hợp lệ, không hợp lệ và hỗn hợp.
- Câu hỏi có độ khó chuỗi; chưa có câu trả lời hoặc chưa chấm; không trả expected answers/metadata.
- Đổi trang, mở chi tiết/quay lại đúng bé và trang; mở trực tiếp; lỗi mạng/thử lại; timezone Việt Nam.
- Unit/API/UI tests, typecheck, lint/build phù hợp; phân biệt lỗi mới và lỗi baseline nếu có. Sau đó mới chạy ứng dụng để người dùng kiểm tra khi được yêu cầu.
- Test dùng fixture/mocks riêng để kiểm chứng contract; ứng dụng thật vẫn lấy database. Không seed dữ liệu nếu chưa được yêu cầu.

### Phase 6 — Bàn giao Git

Sau người dùng nghiệm thu: kiểm tra diff/phạm vi, tổng hợp test và hạn chế, commit/push/tạo PR khi được yêu cầu. Không tự merge. Nếu được giao đồng bộ main trước PR, kiểm tra worktree và xử lý an toàn, không đè thay đổi của người khác.

Task 2 — Tiến bộ chỉ bắt đầu ở nhánh riêng sau khi Task 1 đã hoàn tất/tích hợp và người dùng xác nhận phạm vi dữ liệu/cách tổng hợp.

## 7. Baseline đã chạy ở Phase 1

- Backend: `test_parent_reports` + `test_reading_content_service`, **43/43 test đạt**. Chạy qua Python unittest với cấu hình test cô lập và chặn HTTPX transport thật; không gọi provider thật hoặc ghi Supabase. Một log signed-URL ConnectError từ transport bị chặn là dự kiến.
- Frontend: `npm run typecheck` đạt.
- Frontend Vitest: `test/real-parent-report-services.test.ts`, `test/real-parent-reports-ui.test.tsx`, `tests/reports/group5-components.test.tsx`, `tests/reports/report-utils.test.ts`: **4 file, 46 test đạt**.
- Chưa chạy full suite, build hoặc lint toàn dự án trong Phase 1; không coi các mục này là đã đạt.
- Baseline có test đang chặn `COMPLETED`/`IN_PROGRESS` và enum event thực tế. Phase 2 phải thay đúng kỳ vọng này theo hợp đồng history, nhưng vẫn giữ kiểm thử state thực sự không biết, duration không hợp lệ và không tự đoán metrics.

Phase 1 hoàn tất khi chỉ có tài liệu kế hoạch này trong diff, nhánh đúng base, các phát hiện được ghi lại và chưa có thay đổi runtime/database.

## 8. Cập nhật triển khai Phase 2–5

- Phase 2: đã triển khai DTO/history service và test backend; không sửa writer, ORM, camera hoặc helper quyền dùng chung.
- Phase 3: đã triển khai danh sách, nhãn state/thời lượng và dùng next cursor thật từ API.
- Phase 4: đã triển khai chi tiết, trạng thái khả dụng từng nhóm, điểm có sẵn, thời gian Việt Nam và giữ ngữ cảnh quay lại.
- Phase 5: đã hoàn tất kiểm thử kỹ thuật (unit/API/UI/browser và DB thật chỉ đọc). Người dùng chọn “Tôi sẽ tự chạy và kiểm tra sau”, vì vậy bàn giao code/báo cáo và không mở server. Không coi lựa chọn nhận bàn giao là đã duyệt nghiệm thu thủ công.
- Bổ sung đúng phạm vi kiểm thử: `frontend/test/browser/reading-history.pw.ts`; cập nhật fixture và selector history trong hai file `real-data-fixture.ts`, `real-data.pw.ts` cùng thư mục. `frontend/tests/services/mock-report-services.test.ts` chỉ đổi cursor test từ chuỗi tùy ý sang `page-2`, đúng hợp đồng backend đã có.
- Báo cáo kiểm chứng và checklist nghiệm thu: `READING_HISTORY_VERIFICATION.md`.
- Task 2 chưa triển khai. Sau khi chạy thử dự án và yêu cầu dừng server, người dùng đã yêu cầu triển khai Phase 6 Task 1: kiểm tra diff, commit/push nhánh và tạo PR vào main. Không tự merge.
