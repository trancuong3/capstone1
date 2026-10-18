# Task 2 — Tiến bộ đọc: Phase 1–5

Base: main `0ca1be775bbd79088fa4eb91b13a990b9e148cae`, nhánh `feature/linh-reading-progress`.

## Phạm vi

Đọc snapshot đã lưu trong `progressreports`, không tính lại từ phiên đọc và không tự tạo báo cáo. Không sửa Task 1, bộ đọc, đăng nhập, admin, AI, database/migration hoặc API Từ cần luyện. Không commit/push/PR trong Phase 1–5.

Luồng thực tế: reports/page → ProgressReportScreen → report-service → requestApi (Supabase Auth) → owned-progress router → ProgressService → ProgressRepository → ProgressReport/ChildProfile → PostgreSQL → public schema → UI. Service/repository hiện ở file router; giữ vị trí đó, không refactor kiến trúc.

## Hợp đồng

- GET `/system/progress/{child_id}` không có ngày: kỳ có PeriodEnd DESC, PeriodStart DESC, GeneratedAt DESC, Id DESC đầu tiên. Có cả hai ngày: đúng kỳ, bản GeneratedAt/Id mới nhất. Không bỏ qua báo cáo mới chỉ vì summary chưa đọc được.
- GET `/system/progress/{child_id}/periods`: các kỳ duy nhất, metadata công khai, cursor page-N và limit 1–100, lấy limit+1. Cùng kỳ chỉ lấy generation mới nhất. Đây là offset pagination, không cam kết snapshot khi DB thay đổi.
- Kiểm tra parent và quyền sở hữu trước query báo cáo. Thiếu token 401, sai role 403, không thuộc sở hữu/không có báo cáo 404. Sai ngày/cursor 422. Danh sách kỳ rỗng là 200 items=[]; lỗi DB không biến thành rỗng.
- Public DTO gồm ID, child, ngày kỳ, generated_at, chỉ số nullable, trạng thái khả dụng từng nhóm, trạng thái complete/partial/unsupported. Không trả Summary thô. Giá trị thiếu/sai không thành 0. Giá trị 0 đã lưu được giữ nguyên.
- Legacy avg_fluency/total_books hợp lệ chỉ mang nhãn trường cũ, không suy ra % chính xác hoặc số phiên. Không diễn giải đơn vị avg_fluency.
- So sánh chỉ đọc previous_period/trend_deltas hợp lệ đã lưu, không tự tính hoặc mặc định 30 ngày. Từ cần luyện riêng giữ hợp đồng 90 ngày hiện có.
- URL childId/period_start/period_end; thiếu một ngày, ngày không tồn tại, query lặp hoặc đảo ngược là lỗi rõ ràng. Đổi bé bỏ kỳ cũ; response muộn không ghi đè lựa chọn mới.

## Các phase và file

1. Khảo sát baseline/DB chỉ đọc, chốt hợp đồng và tài liệu này.
2. `backend/app/api/routes/system.py` (chỉ Progress), `backend/app/schemas/system.py` (Progress DTO), test riêng `backend/test_reading_progress.py`, cập nhật assertion Progress trong `backend/test_parent_reports.py`.
3. `frontend/lib/api/report-service.ts`, phần Progress trong `frontend/types/reports.ts`, `frontend/app/(app)/reports/page.tsx`; mới `frontend/lib/utils/progress-report-state.ts`.
4. `frontend/components/reports/progress-report-screen.tsx`, `progress-chart.tsx`, phần Progress trong `frontend/lib/utils/report-mappers.ts`; mới `progress-report-filters.tsx`. Không sửa ChildSelector dùng chung.
5. Unit/API/UI/browser tests, typecheck/lint/build, regression history/words và DB read-only smoke. Tests mới trong frontend/test/reading-progress-*, test/browser/reading-progress.pw.ts; cập nhật fixture/assertion Progress cũ nếu DTO ảnh hưởng. Ghi bằng chứng vào READING_PROGRESS_VERIFICATION.md, bàn giao checklist nghiệm thu. Không tự coi test fixture là dữ liệu chạy thật.

## Baseline frontend trước sửa

- Typecheck đạt; 7 file test liên quan đạt 91/91.
- Lint: 0 lỗi, 8 cảnh báo có sẵn ở book-detail-screen, device-permission-service, reading-socket-adapter (ngoài phạm vi).
- Backend/DB và full-suite sẽ ghi riêng trong báo cáo kiểm chứng.

## Chống conflict

system.py, schema, types và mapper là file chung: chỉ sửa block Progress, không format toàn file Python hoặc sửa helper History. File test/fixture chỉ thay phần Progress bị ảnh hưởng. Nhánh riêng không bảo đảm không conflict nếu đồng đội sửa cùng đoạn.

## Trạng thái bàn giao

Phase 1–4 đã triển khai trên nhánh riêng. Phase 5 gồm unit/API/UI/browser, DB read-only smoke và tài liệu kiểm chứng trong `READING_PROGRESS_VERIFICATION.md`. Ban đầu người dùng chọn tự kiểm tra sau; sau đó đã yêu cầu chạy dự án, xác nhận “ok rồi” và yêu cầu dừng. Người dùng đã yêu cầu Phase 6: rà diff, commit/push và mở PR vào main, không tự merge.
