# Task 2 — Tiến bộ đọc: bàn giao Phase 1–5

Ngày kiểm tra: 2026-10-18. Repository: `capstone1`.
Base main đã đối chiếu GitHub: `0ca1be775bbd79088fa4eb91b13a990b9e148cae`.
Nhánh làm việc: `feature/linh-reading-progress`. Các kết quả dưới đây ghi nhận khi bàn giao Phase 5, trước bước Git Phase 6.

## Chức năng đã thực hiện

- Mặc định đọc snapshot của kỳ gần nhất, không ép ngày kết thúc phải là hôm nay. Sort PeriodEnd, PeriodStart, GeneratedAt, Id giảm dần; chọn đúng kỳ thì lấy generation mới nhất của kỳ đó.
- API danh sách kỳ có ownership, các kỳ duy nhất và phân trang page-N/limit+1. Không trả Summary thô; query phân trang chỉ chọn metadata.
- API progress đọc độc lập các chỉ số, từ và nhóm so sánh. Null/invalid không thành 0; chỉ số hợp lệ khác vẫn hiện. Legacy avg_fluency/total_books được ghi rõ là trường cũ, không đổi ý nghĩa/đơn vị.
- Frontend dùng adapter có xác thực hiện có, Zod, không mock fallback. Bộ lọc riêng chọn bé/kỳ, tải thêm kỳ, giữ URL khi reload/back và reset kỳ khi đổi bé. Component đổi key khi URL đổi, response muộn của lựa chọn cũ không ghi đè dữ liệu mới.
- Cards, biểu đồ/bảng hỗ trợ thiếu dữ liệu; số 0 thật giữ nguyên. So sánh chỉ hiển thị dữ liệu hợp lệ đã lưu. Hiển thị ngày kỳ thật và giờ tạo theo Asia/Ho_Chi_Minh.
- Loading, no-child, report-not-found, unavailable, unsupported, partial và network error không bị gom thành báo cáo 0. Danh sách kỳ lỗi không che báo cáo đã tải thành công.

## Bằng chứng kiểm thử

| Kiểm tra                       | Kết quả                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Baseline frontend trước sửa    | Typecheck đạt; 7 file/91 tests liên quan đạt; lint 0 lỗi/8 cảnh báo có sẵn                              |
| Backend liên quan              | 85/85 tests: parent reports, reading progress, reading history, reading content                         |
| Backend full discovery         | 209/209 tests đạt, cùng cơ chế unittest discover của CI; cấu hình giả, HTTPX network transport bị chặn  |
| Frontend full Vitest           | 497/497 tests đạt; `frontend/test-results/progress-unit-summary.json`                                   |
| Typecheck                      | `npm run typecheck` đạt                                                                                 |
| Format                         | Prettier check đạt cho toàn bộ file frontend thay đổi và hai tài liệu Task 2                            |
| Lint                           | `npm run lint`: 0 lỗi, 8 cảnh báo có sẵn ngoài phạm vi                                                  |
| Build                          | `npm run build` đạt                                                                                     |
| Browser lần 1                  | 10/10 desktop/mobile: 4 Progress và 6 History                                                           |
| Browser lần 2 sau chỉnh layout | 8/8 desktop/mobile: 4 Progress và 4 regression liên thông History/Report/Words, unavailable/retry       |
| Giao diện                      | Đã xem ảnh desktop/mobile, kiểm tra không tràn ngang; sửa nút tải kỳ khỏi xuống dòng trên desktop       |
| Git diff                       | Chỉ các file Progress/test/fixture liên quan; không sửa writer/model/env/dependency hoặc helper History |

Lệnh browser:

```powershell
cd frontend
npx playwright test --config=playwright.real-data.config.ts reading-progress.pw.ts reading-history.pw.ts
npx playwright test --config=playwright.real-data.config.ts reading-progress.pw.ts real-data.pw.ts --grep 'Progress|Parent stored history|Parent unavailable reports'
```

Browser dùng server test tạm cổng 3106, dummy auth và API fixtures để kiểm chứng giao diện; không phải dữ liệu chạy thật. Server test được dừng khi Playwright kết thúc. Unit backend dùng fixture và chặn mạng, không gọi provider/ghi Supabase. Log ConnectError ở signed URL là đường lỗi dự kiến của test.

## Đối chiếu Supabase chỉ đọc

Đã chạy transaction READ ONLY, statement_timeout, rollback và dispose; không INSERT/UPDATE/DELETE. Chỉ in thống kê, không in tài khoản/ID/email/Summary hoặc credentials.

- 7 báo cáo thuộc 4 nhóm child/owner: 2 complete, 5 partial legacy.
- Kỳ đã lưu: 2026-07-11–2026-10-08 (1), 2026-08-01–2026-08-31 (3), 2026-09-01–2026-09-30 (2), 2026-09-09–2026-10-08 (1).
- Đọc exact period thành công 7 lần, kiểm tra metadata/paging cho cả 4 nhóm; latest đúng thứ tự đã chốt. Đây là tổng project tại thời điểm kiểm tra, không phải tổng của một tài khoản.
- Smoke HTTP qua ASGI (không mở cổng): 15 request đọc thành công qua router/schema/repository và database thật, 8 request truy cập bé của parent khác bị chặn 404. Chỉ dependency xác thực được override trong test; kiểm tra role parent và ownership vẫn chạy thật với database. Không coi smoke này là đã đăng nhập thử bằng trình duyệt/tài khoản thật.

## Phạm vi được giữ nguyên

- Endpoint Từ cần luyện riêng vẫn mặc định 90 ngày và exact-window như trước; link trên Progress ghi rõ hai kỳ không tự đồng bộ.
- Task 1 Lịch sử, live reading/camera/mic/audio, AI, admin, đăng nhập, DB schema và cấu hình không bị sửa.
- Task này không tự tạo/cập nhật báo cáo khi kết thúc phiên đọc. Kết quả tính tạm ở màn hình hoàn thành không tự biến thành ProgressReport. Nếu không có snapshot, UI báo chưa có báo cáo.
- Chưa tính lại trend, chưa diễn giải đơn vị avg_fluency; không có kỳ so sánh hợp lệ thì không kết luận tăng/giảm.
- Cursor là offset pagination, không bảo đảm snapshot bất biến nếu DB đồng thời thêm báo cáo.

## Nghiệm thu thủ công

Ban đầu người dùng chọn **“Tôi sẽ tự chạy và kiểm tra sau”**. Sau đó đã yêu cầu chạy dự án, kiểm tra và xác nhận **“ok rồi dừng đi”**, rồi yêu cầu triển khai Phase 6 Task 2. Backend/frontend thật đã được dừng, xác nhận không còn listener ở 8000/3000. Đây là xác nhận chạy thử tổng quát, không ghi nhận thay người dùng rằng từng mục checklist đều đã được kiểm tra riêng.

1. Chạy backend/frontend bằng cấu hình hiện có, đăng nhập tài khoản parent có báo cáo, mở tab Tiến bộ.
2. Kiểm tra kỳ mặc định là kỳ đã lưu gần nhất, kể cả ngày kết thúc cũ hơn hôm nay.
3. Chọn kỳ cũ; kiểm tra reload/back vẫn đúng kỳ và đúng bé. Nếu nhiều kỳ thì thử Tải thêm kỳ.
4. Đổi bé: kỳ phải về Mới nhất, không thấy dữ liệu bé trước. Bé chưa có báo cáo vẫn đổi được bộ lọc.
5. Báo cáo cũ/thiếu trường: chỉ số chưa có không hiện 0; legacy được ghi rõ. Báo cáo có 0 thật phải giữ 0.
6. Mở Lịch sử và Từ cần luyện để kiểm tra hồi quy. Không kỳ vọng buổi đọc mới tự cập nhật báo cáo trong task này.

Phase 6 được người dùng cho phép: rà phạm vi, commit/push nhánh và tạo PR vào main. Không tự merge hoặc sửa lỗi ngoài Task 2. Không đưa env, secret, log, ảnh test hoặc test-results vào commit.

## Rà soát trước commit Phase 6

- Main trên GitHub vẫn ở base `0ca1be7`; không cần merge/rebase các thay đổi của team.
- Các file runtime/test thay đổi chỉ thuộc phần Progress đã chốt. Không đưa log chạy thử hoặc dữ liệu tài khoản vào diff.
- `npm run format:check` toàn frontend chưa đạt: 24 file ngoài Task 2 có lỗi format. Đã đối chiếu từng file: không khác `origin/main`, nên đây là lỗi nền; không sửa lan phạm vi. Prettier check riêng toàn bộ file frontend Task 2 đạt.
- Không đánh dấu full format hoặc toàn bộ E2E mặc định là đã đạt. Browser dùng các lệnh scoped đã ghi ở trên. Ảnh desktop/mobile đã xem tại máy, chưa đính kèm lên PR.
