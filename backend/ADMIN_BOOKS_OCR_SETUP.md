# Admin Books OCR — triển khai local và Supabase

## Trạng thái

Các endpoint và UI OCR nằm trên nhánh `feature/admin-book-ocr-integration`. Chỉ xác nhận upload ảnh thật thành công sau khi cấu hình Backend, bucket, khóa server-side, migration và dữ liệu đã được kiểm tra trực tiếp trên Supabase project tương ứng.

## Cấu hình Backend

Các biến bắt buộc hiện có là `DATABASE_URL`, `SUPABASE_URL` và `SUPABASE_KEY`. OCR còn cần cấu hình **chỉ ở phía Backend**:

```env
SUPABASE_STORAGE_BUCKET=<exact-existing-bucket-name>
SUPABASE_SECRET_KEY=<server-only-secret-key>
# Hoặc dùng tên tương thích hệ thống cũ:
# SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
# Chỉ khai báo nếu Tesseract không nằm trong PATH:
# TESSERACT_CMD=C:\\Program Files\\Tesseract-OCR\\tesseract.exe
```

Thay `<exact-existing-bucket-name>` bằng tên bucket thực tế trong Supabase Dashboard → Storage. Không được giả định rằng bucket `book-pages` đã tồn tại. Ưu tiên bucket private và để Backend tạo signed URL thời hạn ngắn. Không đưa server-side key vào Frontend hoặc commit secret vào Git.

Cấu hình dotenv được nạp theo thứ tự: `backend/.env`, file `.env` ở thư mục repository và file `.env` ở thư mục workspace cha (nếu có). Biến môi trường đã được đặt trong tiến trình có ưu tiên cao hơn giá trị trong file. Sửa file đang được dự án sử dụng rồi **khởi động lại Uvicorn**, vì config Python và client Supabase được khởi tạo khi import module.

Ví dụ vị trí mã nguồn trên Windows:

```text
F:\\capstone1-main\\capstone1-main\\backend\\.env
F:\\capstone1-main\\capstone1-main\\.env
F:\\capstone1-main\\.env
```

Chỉ cần dùng vị trí phù hợp; không tạo nhiều file chứa các khóa khác nhau nếu không cần thiết.

## PostgreSQL migration

Áp dụng migration mới theo quy trình migration của dự án:

`supabase/migrations/20261013210000_add_pagerevisions_drafttext.sql`

Migration chỉ bổ sung `public.pagerevisions.drafttext TEXT` với `IF NOT EXISTS`; không xóa bảng hoặc dữ liệu. Trước khi áp dụng, xác minh schema thật và đảm bảo `public.pagerevisions` là bảng đang dùng. Không chạy script phá hủy hoặc `DROP TABLE ... CASCADE`.

## OCR cục bộ

1. Cài Tesseract OCR 5.x trên máy chạy Backend.
2. Cài dữ liệu tiếng Việt `vie.traineddata` tương thích.
3. Nếu Tesseract không có trong `PATH`, khai báo `TESSERACT_CMD` trỏ tới executable thực tế.
4. Cài dependencies trong `backend/requirements.txt`.
5. OCR chạy cục bộ bằng Tesseract và OpenCV; không có fallback OCR cloud.

## Nâng cấp và đánh giá chất lượng OCR\n\nĐọc hướng dẫn `backend/OCR_QUALITY_GUIDE.md` để biết pipeline candidate selection, các biến cấu hình và cách benchmark với ground truth đã được con người kiểm tra.\n\nCác biến tùy chọn trong Backend:\n\n- `OCR_TESSERACT_TIMEOUT_SECONDS`: timeout mỗi lượt Tesseract (mặc định 20 giây, giới hạn 5–60).\n- `OCR_LOW_CONFIDENCE_THRESHOLD`: ngưỡng ưu tiên kiểm duyệt, từ 0 đến 1 (mặc định 0.65). Đây không phải xác suất OCR đúng.\n\nPipeline mặc định đánh giá một số cách tiền xử lý và PSM. Mỗi trang có thể cần nhiều lượt OCR hơn bản cũ; theo dõi thời gian phản hồi ở môi trường triển khai thực tế. Không coi confidence là bằng chứng thay thế cho Admin review.\n\n## Chẩn đoán lỗi upload HTTP 503

Backend ghi log có cấu trúc theo giai đoạn, gồm `request_id`, `event`, `stage`, `book_id` / `page_id` khi đã có, `exception_type`, `http_status`, `error_code` khi có và `elapsed_ms`. Không ghi secret key, token, nội dung ảnh/OCR hoặc signed URL.

Các giai đoạn thường gặp gồm:

- `storage_configuration`: bucket hoặc khóa server-side chưa được cấu hình / không khởi tạo được client.
- `storage_upload`: Storage từ chối lưu ảnh hoặc request đến Storage gặp lỗi.
- `tesseract_preflight`: tiến trình Backend không tìm thấy Tesseract hoặc dữ liệu ngôn ngữ.
- `ocr_processing`: ảnh không thể được xử lý hoặc không có từ OCR hợp lệ.
- `database_persist` / `database_commit`: lỗi ghi dữ liệu.
- `cleanup`: dọn object không thành công sau một lỗi chính.
- `response_validation`: dữ liệu response không thể được dựng sau khi persist.

Mã `X-Request-ID` được thêm vào response. Nếu Frontend hiển thị “Mã yêu cầu”, tìm cùng giá trị trong log Uvicorn để đối chiếu các tầng. Thông báo gửi cho browser chỉ lấy từ danh sách allowlist; lỗi nội bộ không xác định vẫn bị ẩn.

### Kiểm tra cấu hình mà tiến trình Python nhìn thấy

Chạy tại PowerShell dùng đúng virtual environment của Backend:

```powershell
cd F:\\capstone1-main\\capstone1-main\\backend
python -c "from app.services.runtime_diagnostics import runtime_configuration_diagnostics; print(runtime_configuration_diagnostics())"
```

Hàm chỉ xuất trạng thái boolean/nullable, không xuất URL, tên bucket, command đầy đủ hay giá trị khóa. Kết quả mong muốn tối thiểu:

- `supabase_url_configured: True`
- `supabase_storage_bucket_configured: True`
- `server_side_key_configured: True`
- `tesseract_executable_available: True`
- `vietnamese_language_available: True`

Nếu `supabase_storage_bucket_configured` là `False`, thêm `SUPABASE_STORAGE_BUCKET` vào đúng file `.env` được nạp, dùng tên bucket có thật trong project. Nếu `server_side_key_configured` là `False`, khai báo `SUPABASE_SECRET_KEY` hoặc `SUPABASE_SERVICE_ROLE_KEY` chỉ ở Backend. Nếu bucket hoặc quyền upload bị từ chối, kiểm tra bucket và key có thuộc cùng project không cũng như quyền ghi trong Storage.

Sau khi đổi cấu hình, dừng tiến trình bằng `Ctrl+C` rồi khởi động lại:

```powershell
& F:\\capstone1-main\\.venv\\Scripts\\Activate.ps1
cd F:\\capstone1-main\\capstone1-main\\backend
python -m uvicorn app.sever:app --reload --host 127.0.0.1 --port 8000
```

Test mock chỉ xác nhận hành vi code, không chứng minh bucket Supabase thật đã tồn tại hoặc có quyền ghi.

## Bảo vệ Admin và API

Các endpoint ghi Admin dùng token Supabase và xác minh `profiles.role = 'admin'`. Migration `20260928144208_phase4_auth_profiles.sql` tạo trigger để `profiles.id = auth.users.id` với tài khoản Auth mới và khai báo khóa ngoại `NOT VALID` do profile legacy. Hãy xác minh tài khoản Admin có hàng `profiles` cùng UUID với Auth user và `role = 'admin'`; không bỏ kiểm tra quyền để lách lỗi.

Các endpoint:

- `POST /books/admin/catalog`
- `POST /books/admin/catalog/{book_id}/pages` (multipart `image`, `page_number`)
- `PUT /books/admin/pages/{page_id}/revisions/{revision_id}/draft`
- `POST /books/admin/pages/{page_id}/verify`
- `POST /books/admin/pages/{page_id}/reprocess`

Object path được lưu ở `bookpages.imagepath`; không lưu signed URL tạm thời. Bounding box OCR được lưu ở `pagerevisionwords.boundingbox` dưới dạng JSON array `[x,y,w,h]`. Revision mới có trạng thái `NEEDS_REVIEW`; chỉ Admin mới được xác minh.

## Kiểm thử và xác minh dữ liệu

Chạy test Backend:

```powershell
cd F:\\capstone1-main\\capstone1-main\\backend
python -m unittest discover -v
```

Sau khi upload thật thành công, kiểm tra trực tiếp ở Supabase bảng `bookpages`, `pagerevisions` và `pagerevisionwords`: `imagepath` phải là object path; bounding box phải nằm trong khoảng 0–1; draft phải tồn tại sau reload; revision mới phải cần kiểm duyệt. Xác minh ảnh đã tồn tại trong đúng bucket private. Không dùng dữ liệu mock thay bằng chứng thực tế.
