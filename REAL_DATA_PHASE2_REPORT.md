# Phase 2 — Sách Parent dùng dữ liệu thật

Ngày kiểm tra: 2026-10-08.

Repository: `D:\Project\capston1_new\capstone1`.
Nhánh giữ nguyên: `feature/linh-real-data`.

Đây là Phase 2 **sách Parent theo kế hoạch được chốt lại trong hội thoại**. Tài liệu Phase 1 cũ có cách đánh số khác; không coi báo cáo này là hoàn thành các tab Parent/Admin còn lại.

## Phạm vi và kết quả

- Rà soát, hoàn thiện phần đọc dữ liệu đã có cho `/books` và `/books/[bookId]`; không viết lại từ đầu.
- Luồng: page → screen → hook/provider hiện có → `lib/api/book-service.ts` → FastAPI router → Service/Repository trong `book.py` → ORM/database.
- Dùng ba GET đang có trong phần thay đổi chưa commit: `/books/catalog`, `/books/catalog/{book_id}`, `/books/catalog/{book_id}/preview`. Không đổi endpoint/DTO legacy.
- Router kiểm tra token bằng dependency hiện có, kiểm tra role `parent` ở backend. Catalog chỉ nhận sách ACTIVE có ít nhất một trang ACTIVE trỏ đúng revision VERIFIED của chính trang đó.
- Tìm kiếm tên/tác giả, lọc tác giả và lớp được query ở backend; response được frontend validate trước khi hiển thị. Không import runtime mock.
- Thư viện phân biệt danh mục rỗng và không có kết quả lọc. Chỉ request danh mục không lọc thêm khi cần phân biệt hai trạng thái này.
- Sửa lỗi loading kéo dài khi không tải được hồ sơ bé: có thông báo an toàn, không tải sách cho hồ sơ không truy cập được, và có retry.
- Khi thiếu ảnh, giữ thông tin sách và có nút thử tải ảnh lại; không tự tạo URL từ đường dẫn Storage tương đối.
- Ảnh trang dùng URL từ API, bỏ câu văn mẫu trên thumbnail, dùng mô tả ảnh phù hợp accessibility. `unoptimized` tránh phụ thuộc danh sách remote image host khi hiển thị URL đã validate; không gửi ảnh qua Next image optimizer.
- URL hỏng hoặc chứa user/password không được dùng làm ảnh xem trước. Backend trả trạng thái an toàn thay vì lỗi parse URL không được xử lý.

## File chỉnh sửa trong lượt Phase 2 này

Các thay đổi ở file khác đã có trước lượt này và được giữ nguyên.

| File | Thay đổi trong lượt này |
| --- | --- |
| `backend/app/api/routes/book.py` | Bổ sung xử lý an toàn URL ảnh hỏng ở luồng Parent preview; không sửa các endpoint Admin/legacy |
| `backend/test_book_data.py` | Thêm kiểm tra token/role cho mọi GET Parent, SQL preview eligibility, URL ảnh hỏng/credentialed |
| `frontend/lib/api/book-service.ts` | Validate khoảng lớp và URL ảnh; vẫn giữ interface và factory đã có |
| `frontend/components/books/book-library-screen.tsx` | Retry hồ sơ, tránh loading kéo dài/stale catalog, giảm request danh mục lặp |
| `frontend/components/books/book-detail-screen.tsx` | Preview rỗng/thiếu có thông báo và retry, giữ metadata sách |
| `frontend/components/books/book-page-thumbnail.tsx` | Hiển thị URL ảnh thật, alt text, gỡ nội dung mẫu trên ảnh |
| `frontend/test/real-book-service.test.ts` | Bổ sung kiểm tra khoảng lớp sai và URL chứa credentials |
| `frontend/test/real-books-ui.test.tsx` | Kiểm tra empty, no results/clear filter, retry, hồ sơ không truy cập được, preview và unavailable |
| `REAL_DATA_PHASE2_REPORT.md` | Báo cáo này |

Không sửa thêm Auth, các tab reports/sessions/Admin, provider dùng chung, model, database schema, migration, env hoặc dependencies trong lượt này. Không tạo `lib/http`, router mới hay thư mục services/repositories.

## Kiểm tra đã chạy thực tế

Chạy frontend tại `frontend/`, backend tại `backend/`.

| Command/check | Kết quả |
| --- | --- |
| `npx vitest run test/api-client.test.ts test/real-book-service.test.ts test/real-books-ui.test.tsx` | PASS: 3 files, 31 tests; dùng HTTP/token test doubles chỉ trong tests, không chứng minh đăng nhập tài khoản thật |
| `.\.venv\Scripts\python.exe -B -m unittest test_data_access test_book_data -v` | PASS: 19 tests; gồm identity và catalog, không ghi database |
| `npx prettier --check components/books/book-library-screen.tsx components/books/book-detail-screen.tsx components/books/book-page-thumbnail.tsx lib/api/book-service.ts test/real-books-ui.test.tsx test/real-book-service.test.ts` | PASS |
| `npm run lint` | PASS |
| `npm run typecheck` | FAIL: lỗi Auth so sánh mode `supabase` với `mock`, test cũ import mock đã xóa và generated validator trỏ route đã xóa; không có diagnostic ở các file sách vừa sửa |
| `npm run build` | Compile thành công, sau đó FAIL ở bước TypeScript do các lỗi nêu trên; không gọi đây là production build đạt |
| `git diff --check` | PASS |
| Rà `lib/mock`, `@ts-ignore`, `any` trong phần frontend sách | Không tìm thấy |

### Đối chiếu database thật — chỉ đọc

Đã gọi CatalogRepository/CatalogService với kết nối backend hiện có, trong transaction `READ ONLY`, có statement timeout và rollback; chỉ in số lượng, không in token/credential, tên sách hoặc dữ liệu cá nhân.

- Sách đủ điều kiện Parent: **3**.
- Sách có URL preview dùng được: **0**.
- Sách chờ bổ sung ảnh: **3**.

Đây là kiểm tra query/service với database thật, **không phải** E2E đăng nhập Parent thật hay test qua server HTTP đang chạy. Không tạo user, bucket, ảnh hoặc dữ liệu giả để làm kết quả đẹp hơn.

## Giới hạn và bàn giao

- Ảnh cần người phụ trách bổ sung URL hoặc thống nhất bucket/access policy rồi triển khai chuyển đổi Storage path đúng contract. Hiện tại không đoán bucket.
- Bìa minh họa Figma hiện có là tài nguyên giao diện, không phải ảnh bìa lấy từ Supabase; không thêm trường cover URL vào DTO.
- Tạo phiên đọc/AI/realtime không thuộc Phase 2 đọc dữ liệu này; giữ nguyên phần đó, không báo thành công giả.
- Chưa chạy Playwright hoặc kiểm tra trực quan desktop/mobile trong lượt này. Nghiệm thu toàn dự án vẫn cần xử lý lỗi build/typecheck ngoài phạm vi và chạy kiểm tra Phase 6.
- Giữ nguyên API legacy chưa có đầy đủ Auth guard; kết quả catalog mới không chứng nhận an toàn cho toàn bộ server.
- Chưa commit, push hay mở PR; không tự chuyển sang Phase 3.
