# Hát vui — triển khai và quản trị karaoke

Module độc lập với đọc sách: admin tải nhạc và lời lên, căn thời gian, nghe thử,
xuất bản; parent chọn bé rồi mở **Tổng quan → Hát vui**. Thêm bài không cần sửa
code, thêm SQL cho từng bài hoặc build lại ứng dụng. Không thu âm, xin quyền
microphone, gọi STT/TTS, chấm điểm hoặc ghi lịch sử/tiến bộ đọc.

## 1. Cấu hình và migration

Backend dùng cấu hình sẵn có trong `backend/.env`: `DATABASE_URL`,
`SUPABASE_URL`, `SUPABASE_KEY` và khóa server-only `SUPABASE_SECRET_KEY` hoặc
`SUPABASE_SERVICE_ROLE_KEY`. Frontend dùng URL/publishable key của **cùng
project**, và API URL trỏ tới backend. Không thêm server key vào `NEXT_PUBLIC_*`,
file lời, ảnh, Git hoặc nội dung trao đổi.

Migration: `supabase/migrations/20261114130000_add_karaoke.sql`.

Trước triển khai ở một môi trường mới:

1. Xác nhận target với chủ project; kiểm tra hai bảng `karaoke_songs`,
   `karaoke_song_versions`, bucket `viread-karaoke` và lịch sử migration.
2. Đọc và thử migration trên PostgreSQL disposable; giữ bản sao/backup theo quy
   trình dự án. Không chạy `db reset`, DROP hoặc push toàn bộ migration cũ chỉ
   để thêm karaoke.
3. Áp dụng đúng migration qua quy trình migration của nhóm. Migration có
   transaction và **không thiết kế để chạy lại lên schema đã tồn tại**; nếu đã
   áp dụng, đối chiếu schema/history thay vì chạy lại.
4. Kiểm tra bảng có RLS, anon/authenticated không truy cập trực tiếp, backend có
   quyền. Bucket private, tối đa 20 MiB, MIME `audio/mpeg`/`image/webp`.
5. Không mở bucket public hoặc bỏ kiểm tra role/ownership để xử lý lỗi.

Kết nối DB từ môi trường triển khai nên xác minh CA và hostname. CA lấy từ
Supabase Dashboard → Database settings → SSL configuration. Dự án hỗ trợ
`DATABASE_SSL_REQUIRED=true` và `DATABASE_SSL_ROOT_CERT=<đường dẫn CA>`; chế độ
transaction pooler yêu cầu port 6543 và cấu hình tương ứng. Không tắt kiểm tra
chứng chỉ để lách lỗi TLS. Xem [hướng dẫn Supabase](https://supabase.com/docs/guides/platform/ssl-enforcement).

`SUPABASE_STORAGE_BUCKET` cũ dành cho sách không quyết định bucket karaoke.
Module có adapter riêng cố định `viread-karaoke`. Không sửa policy bucket sách.
Policy restrictive mới chỉ chặn anon/authenticated với object karaoke, giữ
nguyên điều kiện truy cập bucket khác.

### Trạng thái môi trường làm việc này

Ngày 2026-11-15, người dùng đã xác nhận project `hgkklatgepyzbkkmwfvp` và cho
phép thêm phần karaoke. Migration đã áp dụng bằng TLS có xác minh CA/hostname,
đồng thời ghi version `20261114130000` vào `supabase_migrations.schema_migrations`.
Hai bảng có RLS, bucket private; kiểm tra trong transaction cho thấy số dòng
profiles/childprofiles/readingsessions/readingevents/progressreports không đổi.
Không chạy lại migration này trên project đó.

### Sửa trùng mã migration sau PR #110 — 2026-11-15

Hai migration karaoke và index từ Sentence Shooter đã dùng chung mã
`20261114130000`, khiến Supabase không ghi được lịch sử triển khai sau merge.
Giữ nguyên `20261114130000_add_karaoke.sql`; chỉ đổi tên file index thành
`20261115103616_pagerevisionwords_revision_order_idx.sql`, không đổi SQL bên trong.

Đã kiểm tra readonly trên đúng project: mã cũ thuộc `add_karaoke`, hai bảng
karaoke có RLS và index `ix_pagerevisionwords_revision_line_word_id` đã tồn tại.
Sau khi xác minh index hợp lệ và khớp đủ bốn cột theo đúng thứ tự, đã bổ sung
duy nhất bản ghi lịch sử `20261115103616` với nội dung migration index trong một
transaction. Không chạy lại CREATE TABLE/CREATE INDEX, không sửa bản ghi lịch sử
karaoke, dữ liệu đọc sách, bài hát, Storage hoặc quyền tài khoản.

Cần triển khai cả bản sửa tên file trong Git để không còn hai file trùng mã;
chỉ chạy lại check trên commit cũ không giải quyết lỗi này. Test
`backend/test_migration_versions.py` kiểm tra tên/mã thời gian hợp lệ và chặn
trùng mã qua bộ backend test hiện có, không cần đổi workflow.

Đã có bài thử **Ngôi sao nhỏ**, ID `0374bb5e-426e-4375-8c1f-2f11c529e786`,
được upload và xuất bản qua UI, phù hợp lớp 1–5. Tìm trong **Admin → Bài hát**
hoặc chọn hồ sơ bé rồi mở **Hát vui**. Có thể ẩn qua UI nếu không muốn dùng demo.

## 2. Chạy ứng dụng local

Tại thư mục repository đang làm việc:

```powershell
cd D:\Project\capston1_new\capstone1\backend
.\.venv\Scripts\python.exe -m uvicorn app.sever:app --host 127.0.0.1 --port 8000 --reload
```

Mở terminal khác:

```powershell
cd D:\Project\capston1_new\capstone1\frontend
npm.cmd run dev
```

Frontend: `http://localhost:3000`. Admin dùng tài khoản có `profiles.role=admin`,
`active=1`; parent dùng `role=parent`, `active=1` và hồ sơ bé thuộc tài khoản đó.
Không thay role trong database chỉ để vượt qua kiểm tra quyền. Backend
entrypoint chính xác là `app.sever:app`.

Khởi động backend thông thường còn chạy worker đọc sách/OCR theo cấu hình
hiện có; task karaoke không thay worker đó. Khi nghiệm thu cô lập, có thể đặt
`APP_ENVIRONMENT=test` **chỉ trong process thử** để không chạy worker ngoài phạm
vi; xác thực Supabase/role/ownership của karaoke vẫn là thật. Không đặt auth
fixtures development khi kiểm tra Supabase thật.

## 3. Chuẩn bị nội dung

| Nội dung     | Giới hạn                                                                      |
| ------------ | ----------------------------------------------------------------------------- |
| Nhạc         | MP3 MPEG Layer III, tối đa 20 MiB và 5 phút; backend đọc duration từ bytes    |
| Ảnh tùy chọn | JPEG/PNG/WebP, tối đa 2 MiB và 4096 px mỗi chiều; server chuẩn hóa WebP       |
| File lời     | UTF-8/BOM; TXT/LRC/JSON, tối đa 256 KiB                                       |
| Lời          | Tối đa 300 dòng, 300 ký tự/dòng, tổng 50.000 ký tự                            |
| Thời gian    | Số nguyên mili giây, `0 <= start < end <= duration`, đúng thứ tự, không chồng |

Lấy nhạc/lời mà nhóm có quyền sử dụng. Bài truyền thống và bản thu cụ thể có
thể có điều kiện khác nhau; “tải miễn phí” không tự chứng minh được quyền phân
phối. Điền nguồn và quyền sử dụng trước khi xuất bản. Nếu giấy phép yêu cầu
ghi công, phải có ghi công công khai cho người nghe, không chỉ ghi trong hai
trường quản trị `source_note`/`usage_note`.

Bộ thử sẵn trong [docs/karaoke-demo](docs/karaoke-demo/README.md): MP3 thật của
Alexander Blu có nguồn công bố CC BY 4.0, lời Việt mới, TXT/LRC/JSON và metadata.
Trường `author` của bộ này chứa tên, URL nguồn và giấy phép, được hiển thị cho
người nghe. Giữ các thông tin đó nếu sử dụng bộ thử.

## 4. Admin tạo và xuất bản

1. **Bài hát → Tạo bài hát**: nhập tên, tác giả/ghi công, nguồn, quyền sử dụng,
   lớp 1–5 phù hợp. Bấm **Tạo bản nháp**.
2. **Tải nhạc MP3**, thêm ảnh nếu có. Lưu các thay đổi form trước khi tải file.
   Upload thành công được lưu ngay vào draft trên server.
3. Nhập file lời hoặc dán/thêm dòng. TXT chỉ tạo text, không tự bịa thời gian.
   LRC gợi ý end bằng câu tiếp theo/duration; admin phải nghe và chỉnh lại.
   JSON giữ cả ID/thứ tự/mốc và báo lỗi khi sai format.
4. **Lưu lời và thời gian**. **Tải bản nghe thử / Căn thời gian** để nghe, đánh
   dấu đầu/cuối theo audio thực, nghe đoạn hoặc sửa mốc bằng ms. Sửa xong lưu
   lại và tải preview mới.
5. **Kiểm tra điều kiện xuất bản**, đối chiếu lời với nhạc, bấm Phát preview
   đúng revision. Sau đó **Xuất bản bài hát**, xác nhận.
6. Reload editor để kiểm tra trạng thái server. GET không tự tạo bản nháp.

Với hơn 25 dòng, dùng **Trang chỉnh lời** để chọn nhóm dòng cần sửa. Mỗi lần
lưu vẫn lưu toàn bộ lời, không chỉ trang đang thấy. Bộ phát dùng toàn bộ timeline;
đổi trang chỉnh lời không đổi vị trí nhạc.

Thay nhạc nháp sẽ xóa toàn bộ timing nháp; text được giữ. Không tái sử dụng
timing của file khác mà chưa kiểm tra. Chỉ nghe thử không tự xuất bản. Không có
autosave; lưu nháp và kiểm tra thông báo trước khi đóng tab.

### Sửa bài đang hiển thị

Mở editor, bấm **Tạo bản nháp từ bản xuất bản**. Bé vẫn dùng bản đang xuất bản;
nháp không xuất hiện trong catalog. Chỉ lần xuất bản tiếp theo mới đổi version
đang dùng. Bản cũ giữ lại; không xóa media nếu một version còn tham chiếu.

Ở danh sách, **Ẩn bài hát/Hiện lại** có xác nhận. Ẩn chặn catalog/cấp URL mới;
URL media đã cấp có thể dùng đến lúc hết hạn (tối đa 60 phút), không cam kết
thu hồi âm thanh tức thời.

## 5. Parent và bé

Ở Tổng quan chọn hồ sơ bé trước, rồi bấm **Hát vui**. Danh sách chỉ gồm bài đã
xuất bản, đang hiện và phù hợp lớp trong hồ sơ DB. API vẫn kiểm tra quyền sở
hữu, không tin child ID/lớp từ URL.

Chọn bài rồi bấm **Phát**; có Tạm dừng, Về đầu, thanh vị trí, âm lượng, Hát lại
và về thư viện. Dòng hiện tại có nhãn chữ, không chỉ đổi màu. Giữa các câu có
khoảng trống sẽ hiện nhạc dạo/kết, không giữ nổi bật một dòng đã hết hạn.

Rời trang, đổi bé/tài khoản hoặc mất phiên: nhạc dừng. Reload signed URL dừng
player và chờ người dùng bấm Phát, không tự phát. Nếu version thay đổi, UI yêu
cầu **Tải phiên bản mới**, không trộn lời cũ/nhạc mới. Tải lại toàn trang có thể
phải chọn lại bé vì AppStore hiện lưu lựa chọn trong memory.

## 6. Chẩn đoán an toàn

| Trạng thái      | Cách xử lý                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Danh sách trống | Kiểm tra bài đã xuất bản/đang hiện và lớp của bé; không chèn mock                                    |
| 401/403         | Đăng nhập lại hoặc kiểm tra đúng tài khoản/role/active; không bỏ guard                               |
| 404             | Bài ẩn/không tồn tại/ngoài lớp hoặc hồ sơ không thuộc tài khoản                                      |
| 409             | Revision/version đã đổi; sao lưu nháp rồi tải lại, không ghi đè cưỡng bức                            |
| 413/415/422     | Kiểm tra giới hạn và bytes MP3, ảnh/lời/mốc; đổi đuôi file không chuyển định dạng                    |
| 503             | Kiểm tra migration, cấu hình server-only, bucket, kết nối DB/Storage; không hiển thị lỗi SQL/key thô |
| MP3 không phát  | Thử file đúng bằng preview, kiểm tra URL/expiry/Range và duration; không sửa mốc tự động để che lỗi  |

Không log access/refresh token, service key, signed URL hoặc payload provider.
Các lỗi Storage riêng có mã log `karaoke_storage_upload_failed`,
`karaoke_storage_verification_failed`, `karaoke_storage_sign_failed`,
`karaoke_orphan_cleanup_failed` và `karaoke_orphan_reference_check_failed`.

### Object mồ côi

Upload và transaction DB không nguyên tử. Backend cố dọn object mới nếu ghi DB
thất bại và xác minh chắc chắn không có version tham chiếu. Nếu trạng thái
commit/DB mơ hồ, giữ object và kiểm tra thủ công. Danh sách path đang dùng:

```sql
SELECT song_id, id AS version_id, state, audio_path, cover_path
FROM public.karaoke_song_versions
ORDER BY song_id, version_no;
```

Chỉ so sánh object trong `viread-karaoke` với **tất cả version**, kể cả nháp và
SUPERSEDED. Chỉ xóa một object cụ thể sau khi xác minh không được tham chiếu,
đã nhận diện lần upload lỗi và có phép của chủ project. Không xóa theo prefix,
không reset bucket, không thêm cron dọn dữ liệu vào task này. Muốn gỡ demo hãy
ẩn bài qua UI, không DROP bảng hay xóa dữ liệu đọc.

## 7. Kiểm thử lại

Frontend tại `frontend`:

```powershell
npm.cmd test -- --maxWorkers=2
npm.cmd run lint
npm.cmd exec -- tsc --noEmit --incremental false
npm.cmd run build
npm.cmd exec -- playwright test --config=playwright.real-data.config.ts karaoke.pw.ts karaoke-admin.pw.ts
```

Playwright trên dùng Auth/API/media fixtures cô lập, không phải nghiệm thu
Supabase. Script opt-in `scripts/verify_karaoke_live.mjs` dành cho người vận
hành đã được chủ project cho phép, dùng phiên admin/parent tạm hợp lệ đặt trong
`.cache/karaoke-live-sessions.json` bị Git ignore; không nhận service key, không
tự tạo tài khoản hoặc đổi role. Nó dùng cookie SSR chuẩn, API/Storage thật và
upload/xuất bản qua UI. Chỉ chạy với `--apply-demo --project-ref <ref-đã-xác-nhận>`;
`--resume` bắt buộc nếu đã có song ID để không tạo demo trùng sau một lỗi test.
Kết thúc phải logout **scope local** của phiên thử, đóng browser và xóa artifact
chứa token; không logout toàn bộ phiên đang dùng của người khác.

Backend: dùng Python virtualenv, `unittest discover` với cấu hình test giả như
`KARAOKE_VERIFICATION.md`. Integration chỉ nhận PostgreSQL disposable chính xác
`127.0.0.1:55447`, user `karaoke_test`, DB `karaoke_phase2_test` qua biến
`KARAOKE_TEST_DATABASE_URL`. Không dùng DATABASE_URL sản phẩm cho integration.

Sáu integration karaoke chạy migration/RLS/khóa/CAS/rollback thật trong
PostgreSQL; Storage/Auth ở suite đó là doubles. `test_karaoke_demo.py` kiểm tra
MP3/hash/lời/ghi công offline. Nghiệm thu live và giới hạn thực tế được ghi
riêng trong `KARAOKE_VERIFICATION.md`, không suy ra từ test fixtures.
