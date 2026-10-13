# Admin Books OCR — triển khai local và Supabase

## Trạng thái

Các endpoint và UI mới được phát triển trên nhánh `feature/admin-book-ocr-integration`. Việc tạo bucket, chạy migration trên Supabase thật và upload ảnh thật chỉ được xem là hoàn tất sau khi người vận hành áp dụng cấu hình và kiểm tra trực tiếp ở project Supabase tương ứng.

## Cấu hình Backend

Giữ nguyên các biến hiện có `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_KEY`. Bổ sung các biến **chỉ ở môi trường server**:

```env
SUPABASE_STORAGE_BUCKET=book-pages
SUPABASE_SECRET_KEY=<server-only-secret-key>
# Hoặc dùng tên tương thích hệ thống cũ:
# SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
# TESSERACT_CMD=C:\\Program Files\\Tesseract-OCR\\tesseract.exe
```

Tên bucket `book-pages` ở ví dụ là giá trị cần thống nhất khi tạo/cấu hình bucket; không có kết luận rằng bucket này đã tồn tại. Với nội dung sách của trẻ, ưu tiên bucket private và chỉ để Backend ký URL thời hạn ngắn. Không đưa secret key vào Frontend hoặc commit vào Git.

## PostgreSQL migration

Áp dụng migration mới theo quy trình migration của dự án:

`supabase/migrations/20261013210000_add_pagerevisions_drafttext.sql`

Migration chỉ thêm `public.pagerevisions.drafttext TEXT` với `IF NOT EXISTS`; không xóa bảng hoặc dữ liệu. Trước khi áp dụng, đối chiếu schema thật trên Supabase và bảo đảm `public.pagerevisions` là bảng vật lý đang sử dụng.

## OCR cục bộ

1. Cài Tesseract OCR 5.x trên máy chạy Backend.
2. Cài dữ liệu ngôn ngữ tiếng Việt `vie.traineddata` tương thích với bản Tesseract đó.
3. Nếu Tesseract không nằm trong PATH, khai báo `TESSERACT_CMD` trỏ tới executable thực tế.
4. Cài Python dependencies trong `backend/requirements.txt` và khởi động Backend như bình thường.
5. OCR báo `503` nếu Tesseract hoặc `vie.traineddata` chưa được cấu hình; không có fallback OCR cloud.

Các endpoint ghi Admin dùng token Supabase hiện hành và kiểm tra `profiles.role = 'admin'`. Migration `20260928144208_phase4_auth_profiles.sql` tạo trigger để `profiles.id = auth.users.id` đối với tài khoản Auth mới và khai báo khóa ngoại `NOT VALID` vì còn profile legacy có thể không có Auth tương ứng. Trước khi dùng OCR, hãy xác minh chính tài khoản Admin có hàng `profiles` với cùng UUID như Auth user và `role = 'admin'`. Profile legacy không có Auth ID tương ứng sẽ bị từ chối; không được bỏ kiểm tra role để lách vấn đề.

## API được bổ sung

- `POST /books/admin/catalog`
- `POST /books/admin/catalog/{book_id}/pages` (multipart `image`, `page_number`)
- `PUT /books/admin/pages/{page_id}/revisions/{revision_id}/draft`
- `POST /books/admin/pages/{page_id}/verify`
- `POST /books/admin/pages/{page_id}/reprocess`

Object path ảnh được lưu ở `bookpages.imagepath`; bbox mới được lưu trong `pagerevisionwords.boundingbox` dạng JSON array `[x,y,w,h]`. Revision number được lưu dưới dạng chuỗi số nguyên dương. `verifiedtext` chỉ dành cho nội dung đã xác minh; `drafttext` là nội dung nháp.

## Xác minh

Chạy bộ test Backend:

```powershell
cd backend
python -m pip install -r requirements.txt
python -m unittest discover -v
```

Kiểm tra trực tiếp ở Supabase (không chỉ dựa vào UI): tìm bản ghi mới trong `books`, `bookpages`, `pagerevisions`, `pagerevisionwords`; xác minh `imagepath` là object path, bbox ở khoảng 0–1, draft vẫn còn sau reload, và chỉ revision `VERIFIED` mới được trỏ bởi `currentverifiedrevisionid`. Kiểm tra một phiên đọc mới chỉ lấy revision đủ điều kiện. Không dùng thông tin mẫu để thay thế bằng chứng chạy thật.
