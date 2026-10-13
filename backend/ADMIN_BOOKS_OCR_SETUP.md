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

## Chẩn đoán lỗi upload HTTP 503

Frontend chỉ hiển thị một danh sách cho phép gồm các thông báo cấu hình đã được xác nhận là an toàn; nội dung lỗi nội bộ bất kỳ khác vẫn bị ẩn.

Nếu upload trả về `503`, hãy đọc thông báo trong trạng thái thất bại trên màn hình Admin và kiểm tra log cửa sổ Uvicorn. Backend ghi giai đoạn thất bại (`storage_upload`, `ocr_preflight`, `ocr_processing`, hoặc `database_commit`) cùng loại exception; log không nên chứa khóa, token hoặc nội dung response riêng tư.

Trên đúng môi trường Python đang dùng để khởi chạy Backend, kiểm tra cấu hình mà tiến trình có thể nhìn thấy mà không in ra giá trị bí mật:

```powershell
python -c "import os; from dotenv import load_dotenv; load_dotenv(); print('SUPABASE_STORAGE_BUCKET configured:', bool(os.getenv('SUPABASE_STORAGE_BUCKET'))); print('Server-side key configured:', bool(os.getenv('SUPABASE_SECRET_KEY') or os.getenv('SUPABASE_SERVICE_ROLE_KEY'))); print('TESSERACT_CMD configured:', bool(os.getenv('TESSERACT_CMD')))"
python -c "import pytesseract; print('Tesseract version:', pytesseract.get_tesseract_version()); print('Languages:', ', '.join(pytesseract.get_languages(config='')))"
```

Diễn giải:

- `SUPABASE_STORAGE_BUCKET configured: False`: thêm biến này vào file `.env` mà Backend thực sự nạp, dùng đúng tên bucket đã tạo trong project Supabase.
- `Server-side key configured: False`: cấu hình `SUPABASE_SECRET_KEY` hoặc `SUPABASE_SERVICE_ROLE_KEY` ở Backend. Không dùng khóa bí mật ở Frontend và không commit khóa vào Git.
- Nếu Storage đã cấu hình nhưng log chỉ ra lỗi upload từ API, kiểm tra bucket có tồn tại trong đúng project URL và server-side key có quyền ghi vào bucket đó.
- Nếu thông báo nêu Tesseract, đặt `TESSERACT_CMD` nếu cần và xác minh lệnh kiểm tra Tesseract được chạy trong cùng môi trường với tiến trình Uvicorn.

Chỉ sau khi xác minh cấu hình trên môi trường thật mới kết luận upload đã hoạt động. Unit test dùng mock không chứng minh bucket thật có thể ghi được.

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
