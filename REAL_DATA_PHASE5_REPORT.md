# Báo cáo Phase 5 — Dọn runtime mock trong phạm vi đã chuyển dữ liệu

Ngày: 08/10/2026.
Repository: `D:\Project\capston1_new\capstone1`.
Branch giữ nguyên: `feature/linh-real-data`.

## Kết quả

Đã dọn wiring demo và các handler mô phỏng/ghi không còn dùng trong các màn đọc dữ liệu thật của Phase 2–4. Không triển khai backend mới, không sửa Auth, DTO, API, model hoặc database. Không commit/push/pull và chưa chuyển Phase 6.

- Layout Admin chỉ còn `AdminServicesProvider`, không mount `AdminStoreProvider` làm local store.
- Profile và trang tạo sách Admin không parse/truyền scenario nữa. Các route Books/Sessions/Reports bỏ khai báo query `state` không dùng; giữ nguyên childId, bookId, sessionId và pagination.
- Chi tiết sách Admin bỏ form/modal/handler sửa metadata hoặc đổi lifecycle đã bị khóa. Nút khóa vẫn giữ để diễn đạt khả năng chưa sẵn sàng. `Tải lại` gọi lại API đọc, không chạy flow giả.
- OCR review bỏ `wordsFromText`: không còn tọa độ bbox tự sinh, word index/text giả từ editor. Bỏ handler và dialog save/verify/reprocess/lifecycle không được triển khai.
- Văn bản, từ và bbox OCR chỉ lấy từ revision API đã validate. Chọn revision và tải lại vẫn dùng API thật; reload vô hiệu hóa response chọn revision cũ để tránh ghi đè kết quả mới.
- Trang `/admin/books/new` giữ route, heading và link quay lại nhưng không còn form submit vào API tạo chưa tồn tại. Hiển thị thông báo chưa sẵn sàng, không tạo dữ liệu.
- Uploader tương thích chỉ hiển thị trạng thái chưa sẵn sàng: input file và nút upload bị khóa. Bỏ queue/progress/object URL, callback thành công và câu “OCR mock đang xử lý bản R1”. Uploader vẫn không được mount ở màn chi tiết sách.
- Provider vẫn dùng factory thật; sửa comment để phân biệt service đọc đã nối với Reading/AI còn unavailable. Giữ props tương thích của consumer cũ, đánh dấu deprecated; các props này không chọn mock implementation.
- Không xóa file project, dữ liệu hoặc component dùng chung; chỉ bỏ code không còn dùng trong file đã kiểm tra. Không sửa/xóa legacy tests của nhóm để che lỗi.

Luồng dữ liệu giữ nguyên:

`app → component/hook → typed service trong lib/api → FastAPI → repository/ORM → Supabase database`.

## Kiểm tra thực tế

### Frontend

Chạy tại `frontend`:

```powershell
npx vitest run test/api-client.test.ts test/real-book-service.test.ts test/real-books-ui.test.tsx test/real-parent-report-services.test.ts test/real-parent-reports-ui.test.tsx test/real-admin-services.test.ts test/real-admin-ui.test.tsx test/real-data-runtime-cleanup.test.tsx
npm run lint
npm run typecheck
npm run build
```

| Kiểm tra | Kết quả |
| --- | --- |
| Vitest dữ liệu thật Phase 2–5 | 8 files, 117 tests PASS; thêm 8 tests Phase 5 |
| ESLint toàn frontend | PASS, exit 0 |
| Prettier `--check` 16 files frontend của Phase 5 | PASS, exit 0 |
| `git diff --check` | PASS |
| Typecheck | FAIL bởi các lỗi đã có từ Phase 4; không có diagnostic ở file Phase 5 |
| Production build | Compile thành công, FAIL tại TypeScript vì lỗi cũ |
| Playwright / visual 1440px và 390px | Chưa chạy; thuộc nghiệm thu Phase 6 |

Test mới chứng minh:

1. Các route đã chuyển không parse/truyền scenario hoặc khai báo demo state.
2. Layout Admin không mount mock store; protected layout vẫn gọi `requireAppRole("admin")`.
3. Các adapter đọc và provider không import mock implementation.
4. Component Admin chỉ đọc không có handler ghi hoặc hàm sinh bbox giả.
5. Trang tạo sách không có form/nút tạo hoặc request ghi.
6. Uploader bị khóa, không nhận file, không tạo queue/progress hoặc gọi completion callback.
7. Props Admin `scenario="empty"`, `authMode="mock"` tương thích không thay được catalog API thực tế.
8. Props demo Parent không thay được BookService đọc thật.

HTTP test doubles/fixture chỉ tồn tại trong test, không phải fallback runtime hoặc dữ liệu Supabase thật. 117 tests là suite phạm vi dữ liệu thật, không phải toàn bộ `npm test` legacy.

Lỗi typecheck/build còn nguyên:

- 9 so sánh Auth giữa literal `supabase` và `mock` trong `components/auth`.
- Tests legacy import `@/lib/mock/*` đã bị xóa, kéo theo một số lỗi implicit-any.
- Hai validator `.next/dev/types` vẫn tham chiếu route Auth/backend cũ không tồn tại.

Không phục hồi mock, xóa tests, sửa Auth hoặc bật `ignoreBuildErrors` để làm build xanh. Do đó chưa nhận là đã nghiệm thu production toàn dự án.

### Backend

Chạy tại `backend`:

```powershell
.venv/Scripts/python.exe -B -m unittest test_data_access test_book_data test_parent_reports test_admin_data
```

68 tests PASS. Phase 5 không sửa file backend và không truy vấn/ghi Supabase live.

### Rà soát source

- `rg` tại `frontend/app`, `components`, `lib`, `hooks`: không có import/path `@/lib/mock` hoặc `mock-`.
- `rg` tại component Admin ngoài login: không còn `wordsFromText`, “OCR mock” hoặc lời gọi `saveDraft/verify/reprocess/upload/updateStatus/create`.
- `rg` tại Books/Sessions/Reports/Profile và Admin protected routes: không còn parse hoặc truyền demo scenario.
- DTOs, role guard, backend schema/model, Auth và cấu hình env không bị sửa trong phase này.

## File Phase 5 sửa hoặc tạo

Route/layout sửa:

- `frontend/app/admin/layout.tsx`
- `frontend/app/admin/(protected)/books/new/page.tsx`
- `frontend/app/(app)/profile/page.tsx`
- `frontend/app/(app)/books/page.tsx`
- `frontend/app/(app)/books/[bookId]/page.tsx`
- `frontend/app/(app)/sessions/page.tsx`
- `frontend/app/(app)/sessions/[sessionId]/page.tsx`
- `frontend/app/(app)/reports/page.tsx`
- `frontend/app/(app)/reports/difficult-words/page.tsx`

Component/provider sửa:

- `frontend/components/admin/admin-book-detail-screen.tsx`
- `frontend/components/admin/admin-ocr-review-screen.tsx`
- `frontend/components/admin/admin-new-book-screen.tsx`
- `frontend/components/admin/admin-page-uploader.tsx`
- `frontend/components/providers/app-services-provider.tsx`
- `frontend/components/providers/admin-services-provider.tsx`

Tạo mới:

- `frontend/test/real-data-runtime-cleanup.test.tsx`
- `REAL_DATA_PHASE5_REPORT.md`

Giữ nguyên các thay đổi chưa commit của Phase 1–4. Git status tổng còn chứa chúng, không phải tất cả đều do Phase 5.

## Giới hạn và phần giữ lại có chủ ý

- Đây là dọn runtime trong **phạm vi đã chuyển**, không phải xóa mọi chữ/type “mock” trong repository.
- Không sửa Auth login/register/forgot/reset hoặc Admin login. Các helper/type demo còn được Auth hoặc legacy tests dùng được giữ để không mở rộng phạm vi hay tạo conflict.
- `AdminStoreProvider`/context tương thích còn file nhưng không còn được layout runtime mount. Các common form/utility không còn được các màn chỉ đọc sử dụng vẫn được giữ để không xóa tài sản dùng chung của nhóm.
- Props deprecated được giữ cho consumer cũ/Reading và test, nhưng bị bỏ qua bởi implementation dữ liệu thật; có test xác nhận.
- Service Reading, WebSocket, page match, tutor, comprehension và device permission vẫn unavailable như trước; chưa triển khai AI/realtime hoặc giả thành dữ liệu thật.
- Interface ghi của Admin vẫn reject 501, không gọi API và không giả thành công. API ghi thật/upload/OCR cần task được phân công riêng.
- Các thiếu hụt contract ảnh/revision/bbox và report đã ghi ở Phase 3–4 chưa được sửa bằng database mutation hoặc đoán mapping. Không chạy probe live mới ở Phase 5.
- Chưa tự chạy Phase 6, chưa stage/commit/push và không có server mới được khởi động.
