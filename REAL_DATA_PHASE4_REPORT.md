# Báo cáo Phase 4 — Admin đọc dữ liệu thật

Ngày thực hiện: 08/10/2026.
Repository: `D:\Project\capston1_new\capstone1`.
Branch giữ nguyên: `feature/linh-real-data`.

## Phạm vi và kết quả

Đã triển khai code đọc Admin theo mẫu hiện tại:

`frontend/app → components → lib/api → FastAPI router/service/repository trong file route → database Supabase`.

Không tạo `lib/http`, không thêm thư mục service/repository backend. Các DTO đọc khớp interface Admin đã có. Giữ nguyên contract CRUD legacy, model, database, Auth và env. Không commit/push/pull hoặc tự chuyển Phase 5.

| Tab | Component tái sử dụng | Service frontend | API đọc |
| --- | --- | --- | --- |
| `/admin/books` | `AdminBooksScreen` | `AdminBookService` | `/books/admin/catalog` |
| `/admin/books/[bookId]` | `AdminBookDetailScreen` | `AdminBookService`, `AdminPageService` | `/books/admin/catalog/{id}`, `/books/admin/catalog/{id}/pages` |
| `/admin/books/[bookId]/pages/[pageId]` | `AdminOcrReviewScreen` | `AdminPageService`, `RevisionService`, `OcrReviewService` | `/books/admin/pages/{id}/image`, `/processing`, `/revisions`, `/revisions/{revisionId}` |
| `/admin/audit-logs` | `AdminAuditScreen` | `AuditService` | `/system/admin/audit-logs` |
| `/admin/health` | `AdminHealthScreen` | `HealthService` | `/system/admin/health` |

Các màn giữ component/common, layout và token cũ; không viết lại UI.

## Hành vi được bổ sung

- Tất cả 9 API đọc Admin xác minh token bằng dependency hiện có và kiểm tra role `admin` trong profiles trước khi đọc dữ liệu.
- Admin thấy sách ACTIVE/RETIRED từ DB; tìm tên/tác giả, lọc lifecycle và verification. Parent eligibility được kiểm tra bằng truy vấn hiện có, không gán mặc định.
- Đếm trạng thái từ revision mới nhất theo thứ tự `CreatedAt DESC, Id DESC`, thống nhất với processing/history. Trang chưa có revision không được giả thành PROCESSING.
- Giá trị enum không tương thích trả 501 thay vì được đếm thành 0. Phiên bản cần số nguyên dương nằm trong miền số nguyên an toàn của frontend; không tự chuyển `R1` thành 1.
- Metadata sách vẫn hiển thị khi API trang trả 501/503. Phân biệt sách thật chưa có trang với dữ liệu trang chưa phù hợp contract. Có tải lại và not-found/error an toàn.
- Ảnh chỉ dùng HTTP(S) hợp lệ, không chứa credentials; không đoán bucket/storage path. Kiểm tra kích thước và page ID. Dùng ảnh API trực tiếp với Next Image `unoptimized`.
- Revision được truy vấn theo cả page ID và revision ID. Frontend từ chối response chứa ID khác request, kể cả pages trả sai book ID.
- Văn bản hiển thị từ trường `VerifiedText`; null được giữ nguyên. Không giả có draft text hoặc OCR mới.
- Chỉ hiển thị bbox đã đáp ứng contract chuẩn hóa; không đoán cách chia pixel cho kích thước ảnh. Confidence ngoài [0,1] không được chấp nhận.
- Audit dùng filter chính xác, phân trang `page-N`, limit 1–100, cursor ASCII có giới hạn. Sắp xếp ngày + ID ổn định. UI chặn submit tải thêm lặp và loại ID trùng.
- Audit actor/resource/request nullable được giữ nguyên. Metadata JSON thô không trả về; DTO an toàn có `metadata: {}`. OCR metadata thô cũng không được xuất.
- Health thực hiện query đọc `SELECT 1` với timeout 4 giây. Chỉ trả trạng thái của API handler và database; không giả trạng thái Auth/OCR/STT/TTS. Overall chỉ bao gồm hai kiểm tra này.
- Nếu database lỗi trước bước kiểm tra role, endpoint không vượt qua quyền Admin để trả snapshot.
- Các action ghi giữ interface nhưng reject 501, không gọi HTTP ghi hoặc báo thành công giả. Nút sửa/status/OCR bị khóa; uploader không còn được mount ở chi tiết sách. Trang `/admin/books/new` tương thích còn form nhưng giải thích rõ API tạo chưa sẵn sàng; submit reject và không tạo dữ liệu.
- Đã bỏ tham số demo scenario ở 5 route đọc; không dùng query `state` để thay thế kết quả thật.

## Kiểm tra database thật (chỉ đọc)

Đã chạy hai probe bằng session hiện có, `SET TRANSACTION READ ONLY`, statement timeout 5 giây và rollback. Chỉ xuất số lượng/trạng thái, không xuất ID, tên tài khoản, nội dung riêng tư hoặc khóa.

| Kiểm tra | Kết quả |
| --- | --- |
| Có profile Admin thực tế để kiểm tra role | Có |
| Sách đọc được bằng Admin catalog | 5 |
| Sách RETIRED trong snapshot này | 0 |
| Tổng trang thực tế | 5 |
| Sách có API pages đáp ứng contract | 0/5 |
| Sách có pages trả unavailable | 5/5 |
| Audit log ở trang đầu, limit 10 | 5, không có trang kế |
| Health service trực tiếp | HEALTHY: API và database |
| Trang chưa có HTTP(S) ImagePath tuyệt đối | 5/5 |
| Revision chưa phù hợp contract số | 5/5 |
| Từ OCR chưa phù hợp bbox chuẩn hóa | 5/5 |

Đây là kiểm tra service/repository trực tiếp, không phải đăng nhập Admin trên trình duyệt hoặc kiểm chứng toàn bộ hệ thống vận hành. Chưa sửa dữ liệu để các trang OCR hiển thị được. Những phần chưa có dữ liệu phù hợp được bỏ qua theo yêu cầu, không fallback mock.

## Command và kết quả thực tế

Chạy tại `frontend`:

```powershell
npx vitest run test/api-client.test.ts test/real-book-service.test.ts test/real-books-ui.test.tsx test/real-parent-report-services.test.ts test/real-parent-reports-ui.test.tsx test/real-admin-services.test.ts test/real-admin-ui.test.tsx
npm run lint
npm run typecheck
npm run build
```

- Vitest phạm vi dữ liệu thật: 7 file, 109 tests PASS. Phase 4 riêng: 24 service + 15 component tests; 70 tests hồi quy Phase 2–3.
- ESLint toàn frontend: PASS, exit 0.
- Prettier `--check` 19 file frontend Phase 4: PASS, exit 0.
- `git diff --check`: PASS.
- Typecheck: FAIL bởi lỗi cũ ngoài code Phase 4 — 9 so sánh Auth `supabase`/`mock`, test legacy import module mock đã xóa, cùng hai validator `.next/dev` tham chiếu route API không còn tồn tại. Không có diagnostic ở file Admin/test mới của Phase 4.
- Production build: compile thành công, FAIL ở TypeScript với các lỗi trên. Không đặt `ignoreBuildErrors`, không phục hồi mock hoặc xóa test của người khác để làm xanh.
- Chưa chạy Playwright/kiểm tra hình ảnh trình duyệt tại 1440/390: để Phase 6; không nhận là đã nghiệm thu toàn bộ UI.

Chạy tại `backend`:

```powershell
.venv/Scripts/python.exe -B -m unittest test_data_access test_book_data test_parent_reports test_admin_data
```

68 tests PASS, trong đó 23 tests Phase 4. Kiểm tra authorization 401/403 cho cả 9 Admin read routes, SQL scoping, nullable audit/safe projection, pagination, revision/image/bbox và health success/failure. Test dùng dữ liệu kiểm thử cô lập, không tạo Supabase user hoặc ghi database.

## File được sửa hoặc tạo trong Phase 4

Backend sửa (bảo toàn phần Phase 2–3 đã có):

- `backend/app/api/routes/book.py`
- `backend/app/api/routes/system.py`
- `backend/app/schemas/book.py`
- `backend/app/schemas/system.py`

Frontend route sửa:

- `frontend/app/admin/(protected)/books/page.tsx`
- `frontend/app/admin/(protected)/books/[bookId]/page.tsx`
- `frontend/app/admin/(protected)/books/[bookId]/pages/[pageId]/page.tsx`
- `frontend/app/admin/(protected)/audit-logs/page.tsx`
- `frontend/app/admin/(protected)/health/page.tsx`

Frontend component sửa:

- `frontend/components/admin/admin-books-screen.tsx`
- `frontend/components/admin/admin-book-detail-screen.tsx`
- `frontend/components/admin/admin-ocr-review-screen.tsx`
- `frontend/components/admin/admin-audit-screen.tsx`
- `frontend/components/admin/admin-health-screen.tsx`
- `frontend/components/admin/admin-new-book-screen.tsx`

Frontend adapter sửa/format (factory đọc đã có từ các phase trước):

- `frontend/lib/api/admin-book-service.ts`
- `frontend/lib/api/admin-page-service.ts`
- `frontend/lib/api/revision-service.ts`
- `frontend/lib/api/ocr-review-service.ts`
- `frontend/lib/api/audit-service.ts`
- `frontend/lib/api/health-service.ts`

File mới:

- `backend/test_admin_data.py`
- `frontend/test/real-admin-services.test.ts`
- `frontend/test/real-admin-ui.test.tsx`
- `REAL_DATA_PHASE4_REPORT.md`

Git còn thay đổi Phase 1–3 và các thay đổi từ trước; danh sách trên không phải toàn bộ dirty worktree. Chưa stage/commit/push.

## Giới hạn giữ nguyên cho phase sau / người phụ trách khác

- Các mock legacy trong test, type/helper scenario còn tồn tại. Component uploader không được mount còn copy mock trong nhánh success cũ; chưa xóa file shared hoặc dọn toàn dự án trong Phase 4.
- Auth và route CRUD legacy không được viết lại. Guard mới bảo vệ đúng 9 endpoint đọc mới; không có nghĩa mọi endpoint legacy như `/system/logs` đã được audit/bảo vệ. Cần team backend xử lý riêng nếu được phân công.
- Chưa triển khai API ghi, upload Storage, OCR/TTS/STT hoặc sửa database để phù hợp contract.
- Không tự động chạy tiếp Phase 5.
