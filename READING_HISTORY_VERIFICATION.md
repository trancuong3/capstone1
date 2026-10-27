# Task 1 — Báo cáo kiểm chứng Lịch sử đọc

Ngày: 2026-10-17. Nhánh: `feature/linh-reading-history`, base `93900ef`.

## Trạng thái

Phase 2–4 đã triển khai; kiểm thử kỹ thuật Phase 5 đã hoàn tất. Sau đó người dùng đã yêu cầu chạy dự án, kiểm tra và dừng lại, rồi yêu cầu triển khai Phase 6 Task 1. Phase 6 thực hiện bàn giao commit/push/PR, không tự merge. Chưa làm Task 2. Không coi việc chạy thử là xác nhận riêng cho từng case trong checklist bên dưới nếu người dùng chưa báo chi tiết.

Ứng dụng lấy dữ liệu history qua FastAPI/SQLAlchemy/database Supabase. Fixture chỉ nằm trong test, không có mock fallback trong runtime. Không có migration, seed hoặc thao tác ghi database trong task này. Không sửa `.env`, dependency, live reading writer, camera, auth, admin hoặc thuật toán Progress.

## Hành vi đã triển khai và bằng chứng

| Yêu cầu                         | Cách xử lý                                                                          | Kiểm chứng                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| State lưu thật                  | `COMPLETED` → `FINISHED`; giữ `IN_PROGRESS`, `PAUSED`, `ABORTED`                    | Backend unit/HTTP, frontend service/UI, DB chỉ đọc                  |
| Giữ hợp đồng bộ đọc             | DTO history riêng, không nới live state enum                                        | Test `test_live_contract_is_not_broadened`; không có diff writer    |
| Thời lượng thật/null/0          | Tính bằng ended-start; thiếu mốc không gán 0 hoặc kết luận chưa hoàn thành          | Backend duration tests; frontend formatter/completed-without-end    |
| Quyền sở hữu                    | Parent/child/session/book scope giữ nguyên, 404 cho tài nguyên không thuộc gia đình | `test_parent_reports`, HTTP test và frontend response ID validation |
| Danh sách ổn định               | Sort StartedAt/Id giảm dần; offset cursor `page-N`; limit + 1                       | Query assertion, cursor/limit tests, DB paging smoke                |
| Điều hướng                      | API quyết định next cursor; đổi bé reset trang; quay lại đúng bé/trang              | UI tests và Playwright desktop/mobile                               |
| Request cũ                      | Không dùng response của bé đã bỏ chọn để thay kết quả bé mới                        | Deferred-response UI test                                           |
| Sự kiện lưu thật                | Nhận các enum đã xác minh; không biến detected thành confirmed                      | Backend enum/mixed-data tests; UI/browser labels                    |
| Chi tiết chưa tương thích       | Từng nhóm có absent/available/partial/unsupported, không giả thành empty            | Backend/UI/browser tests                                            |
| Điểm và metrics                 | Giữ Score hợp lệ; JSON chưa hỗ trợ để metrics null và báo partial; không tự tính    | Backend score/finite tests, UI test, DB assessment smoke            |
| Câu hỏi/đáp án                  | Giữ nhãn độ khó chuỗi, nguồn vị trí tùy chọn; null đúng/sai là chưa chấm            | Backend privacy/partial tests, UI/browser question tests            |
| Dữ liệu riêng tư                | Không trả metadata JSON, expected/accepted answers                                  | Backend serialization tests; UI không hiện server detail thô        |
| Giờ Việt Nam                    | Timezone cố định Asia/Ho_Chi_Minh cho thời gian hiển thị                            | Date-boundary test và ảnh browser                                   |
| Không phá metadata sách lịch sử | Sách RETIRED vẫn dùng endpoint sách thuộc phiên                                     | Backend tests, API/UI/browser regression                            |

## Kết quả kiểm tra kỹ thuật

- Backend: **60/60 test đạt**, gồm `test_parent_reports`, `test_reading_content_service`, `test_reading_history`. Chạy với env test cô lập và HTTPX transport thật bị chặn; log ConnectError của signed URL trong test reading content là dự kiến, không gọi provider thật.
- Frontend tập trung: **7 file, 91/91 test đạt**, gồm hai file mới `reading-history-services.test.ts`, `reading-history-ui.test.tsx` và các regression tests reports/session hiện có.
- Browser: **10/10 test đạt**, gồm 5 kịch bản trên desktop và mobile: paging/detail/back, đổi bé, dữ liệu chưa hỗ trợ/retry, và hai luồng history/report regression hiện có.
- Đã xem ảnh mobile của chi tiết; kiểm tra browser xác nhận không tràn ngang ở các màn list/detail/empty/unsupported đã test.
- `npm run typecheck`: đạt. `npm run build`: đạt trên phiên bản code cuối, sau chỉnh câu chữ giao diện.
- ESLint trên toàn bộ file frontend thay đổi: đạt. Format file frontend thay đổi và `git diff --check`: đạt tại lượt kiểm tra trước khi viết báo cáo này.
- Full unit suite không xanh toàn dự án: 14 test lỗi ổn định ngoài phạm vi được tái hiện trên snapshot sạch của commit base. Một lượt chạy song song còn gặp timeout test empty catalog; không sửa test/chức năng catalog trong task history.
- Full lint có **3 error camera, 8 warning** ngoài phạm vi. Ba error hooks trong `camera-preview.tsx` tái hiện nguyên trạng trên snapshot sạch của base.
- Lượt full suite cuối trên code đã cố định, với 4 worker: **471 test, 457 đạt và 14 lỗi**; 14 lỗi khớp đúng các case đã tái hiện trên base. Không còn lỗi mới của history. Báo cáo máy đọc được: `frontend/test-results/history-unit-summary.json` (artifact bị Git ignore).

### Lỗi nền đã đối chiếu với base

- `tests/dashboard/dashboard-screen.test.tsx`: 4 test thiếu App Router context.
- `tests/books/book-detail-screen.test.tsx`: 4 test thiếu `useSearchParams` trong navigation mock.
- `test/real-books-ui.test.tsx`: 4 test detail cùng lỗi navigation mock.
- `test/real-page-match-service.test.ts`: 2 test kỳ vọng `text`/`image_url` khác response adapter hiện có.
- `components/reading/camera-preview.tsx`: hooks được gọi có điều kiện ở 3 vị trí.

Snapshot kiểm chứng lấy từ `git archive HEAD frontend` tại base `93900ef`, tách trong thư mục tạm; không thay main/worktree để chạy baseline. Những file runtime lỗi này không nằm trong diff task history. Không tự sửa ngoài phạm vi để làm toàn bộ CI xanh.

## Kiểm tra database thật — chỉ đọc

Hai lượt kiểm tra đều đặt transaction `READ ONLY`, statement timeout, rollback và đóng engine; chỉ in số đếm kỹ thuật, không ghi tên/email/ID cá nhân, nội dung câu hỏi hoặc credentials vào báo cáo.

1. Kiểm tra list theo từng parent/child với limit 2, rồi gọi detail và historical book: **40 phiên thuộc 10 hồ sơ role parent**, **13 lần chuyển trang**, đọc được **5 event, 5 câu hỏi, 5 câu trả lời**. Tổng ID theo từng bé khớp SELECT count, không trùng/thiếu trong snapshot kiểm tra. Không khẳng định đây là tổng mọi phiên của mọi role.
2. Sau khi tách metrics và Score: kiểm tra **5 phiên có assessment**; **5/5 điểm đã lưu được giữ nguyên**, cả 5 báo metrics `partial` thay vì tự suy diễn key `Accuracy`/`WCPM`.

Đây là smoke test service/repository với DB thật, không phải kiểm tra đăng nhập browser bằng tài khoản của người dùng. Browser acceptance dùng HTTP fixtures cô lập và chặn external/write requests; không dùng fixture để thay dữ liệu ứng dụng thật.

## Lệnh frontend để chạy lại

Chạy tại `frontend`:

```powershell
npm run typecheck
npx vitest run test/reading-history-services.test.ts test/reading-history-ui.test.tsx test/real-parent-report-services.test.ts test/real-parent-reports-ui.test.tsx tests/reports/group5-components.test.tsx tests/reports/report-utils.test.ts tests/services/mock-report-services.test.ts
npx playwright test --config=playwright.real-data.config.ts --grep 'History:|Parent stored history|Parent unavailable reports/history'
npm run build
npx vitest run --maxWorkers=4 --reporter=json --outputFile=test-results/history-unit-summary.json
npm run lint
```

Hai lệnh cuối vẫn có lỗi nền đã mô tả; không đánh đồng với regression của history. Không cần key thật cho browser acceptance. Phải dùng backend/frontend cùng thay đổi DTO history; frontend mới không giả tương thích bằng cách bỏ qua validation của backend cũ.

## Checklist nghiệm thu để tham chiếu khi review

1. Chạy backend và frontend của nhánh này, đăng nhập parent hiện có; không cần insert thêm dữ liệu để kiểm tra những phiên đang lưu.
2. Vào Lịch sử, chọn bé có dữ liệu; kiểm tra state, thứ tự mới nhất trước, giờ Việt Nam và phân trang.
3. Mở chi tiết từ trang sau rồi bấm Lịch sử trong nội dung: phải trở lại đúng bé và trang.
4. Phiên hoàn thành thiếu ended_at vẫn mang nhãn hoàn thành, không có thời lượng giả. Event chưa xác nhận không được ghi là lỗi đã xác nhận.
5. Xem câu hỏi/đáp án và điểm đã lưu; nhóm chưa hỗ trợ có thông báo rõ. Đổi bé không được giữ dữ liệu bé trước.
6. Xác nhận đạt hoặc gửi đúng màn hình/lỗi còn gặp. Chỉ sau nghiệm thu và yêu cầu riêng mới làm commit/push/PR ở Phase 6.

Các server acceptance được tự dừng sau Playwright. Sau đó đã chạy frontend 3000 và backend 8000 theo yêu cầu của người dùng; kiểm tra HTTP của login/docs đạt 200. Điểm khởi động backend thực tế là `app.sever:app`, không phải `app.main:app`. Khi người dùng yêu cầu dừng, đã dừng cả hai và xác nhận không còn listener ở 3000/8000. Không sửa runtime hoặc dữ liệu khi chạy/dừng.

## Phase 6 — Bàn giao Git

- Nhánh riêng: `feature/linh-reading-history`, PR hướng vào `main`; không commit/push trực tiếp main.
- Fetch origin/main trước bàn giao: base vẫn là `93900ef`, không có commit mới cần tích hợp tại thời điểm kiểm tra.
- Kiểm tra lại typecheck, 91 frontend tests tập trung và 60 backend tests cô lập trước commit. Kết quả browser/build/full-suite ở trên thuộc lượt Phase 5 trên cùng runtime code; Phase 6 chỉ cập nhật báo cáo.
- Chỉ stage file thuộc history và test/tài liệu liên quan, không stage env/key hoặc test artifacts. Có rà added lines để phát hiện định dạng credential trước commit.
- Mô tả PR ghi rõ thay đổi DTO history có chủ đích theo kế hoạch, phạm vi không đụng Task 2/live reading và các lỗi baseline ngoài phạm vi. Không tự sửa workflow hoặc lỗi nền để làm CI xanh.
