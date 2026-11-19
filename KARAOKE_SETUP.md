# Hát vui — triển khai và quản trị karaoke

> Nâng cấp nhập tự động đang được phát triển riêng, mặc định tắt. Trạng thái tại
> [karaoke-auto-import/STATUS](docs/karaoke-auto-import/STATUS.md), hướng dẫn worker
> local tại [README engine](ai/karaoke_processing/README.md).
> Nâng cấp này có migration additive hai bảng jobs/operations; không áp dụng
> câu “không thêm bảng/migration” của bản nâng cấp từng tiếng cũ bên dưới cho nó.
> Wizard admin và review đã có code/kiểm thử. Ngày 2026-11-19 chủ dự án cho
> phép bỏ qua benchmark/nghe duyệt để bàn giao source qua PR nháp; chất lượng
> vẫn NOT_VERIFIED, chưa cho phép rollout. Xem [bàn giao](docs/karaoke-auto-import/RELEASE.md).
> **Phải áp dụng migration auto-import trước backend mới**, kể cả khi flags tắt.

Module độc lập với đọc sách: admin tải nhạc và lời lên, căn thời gian, nghe thử,
xuất bản; parent chọn bé rồi mở **Tổng quan → Hát vui**. Thêm bài không cần sửa
code, thêm SQL cho từng bài hoặc build lại ứng dụng. Không thu âm, xin quyền
microphone, gọi STT/TTS, chấm điểm hoặc ghi lịch sử/tiến bộ đọc.

## Nâng cấp từng tiếng: sử dụng và thứ tự triển khai

Không thêm bảng/bucket/migration. MP3 và ảnh lưu tại Storage private
`viread-karaoke`; metadata và lời có mốc nằm trong `karaoke_song_versions`
(cột `lyrics` JSONB), catalog/trạng thái nằm trong `karaoke_songs`.
`docs/karaoke-demo` chỉ là bộ file để admin tải lên, không được app tự đọc/seed.

1. Triển khai backend hiểu v1/v2, sau đó frontend tương ứng. Giữ bài v1 hoạt động.
2. Admin mở bản nháp, tải bản nghe thử rồi nhập `ngoi-sao-nho-v2.json` cùng
   metadata `song-v2.json` trong bộ demo. Không cần tải lại MP3 nếu vẫn đúng file.
3. Nghe đủ ba lượt ở 1×, đối chiếu từng tiếng, nốt ngân/đoạn nghỉ; editor cho phép
   chỉnh ±50/100 ms, đánh dấu đầu/cuối, undo, lặp câu và nghe chậm. Phân tích
   tín hiệu trong manifest chỉ là bằng chứng kỹ thuật, không thay duyệt bằng tai.
4. Lưu, tải lại bản nghe thử đúng revision, kiểm tra điều kiện, bấm phát và xuất bản.
   Thay MP3 xóa mốc cũ; cần căn lại. Không xuất bản v2 trước bước 1.
5. Parent chọn hồ sơ bé → Hát vui → chọn bài → Bắt đầu hát. Bé có 3 giây chuẩn
   bị, chữ tô theo tiếng, hát lại/lặp/chọn câu, tốc độ 0.75×/1× và mở rộng màn hát.
   Âm lượng, ghi công/giấy phép nằm trong “Âm lượng và thông tin bài hát”.

### Công cụ nghiệm thu nâng cấp (không tự chạy trong app/CI)

- `scripts/check_karaoke_upgrade_readiness.py --project-ref <ref> --admin-email <email-đã-cho-phép>`: đọc trạng thái
  dự án bằng transaction read-only, xác minh TLS; không in credential/email.
- `scripts/analyze_karaoke_demo.mjs`: giải mã MP3 cục bộ ra PCM trong `.cache`,
  không gọi API. Các mốc và phương pháp đo ở file `ngoi-sao-nho-v2-timing.json`.
- `scripts/karaoke_upgrade_sessions.py`: chỉ chạy khi đã được chủ dự án cho
  phép phiên tạm và xác nhận đúng project/tài khoản. `--create-approved-sessions`
  cùng `--admin-email <email-đã-cho-phép>` tạo phiên cho admin đã chỉ định và parent hiện có hồ sơ; không tạo user,
  không gửi email, đổi role/password. `--cleanup` logout scope local và xóa file
  credential cache. Dùng Python trong `backend/.venv`; cần CA ở cache theo script.
  Cơ chế tham khảo [generate link](https://supabase.com/docs/reference/python/auth-admin-generatelink),
  [verify OTP](https://supabase.com/docs/reference/python/auth-verifyotp),
  [local sign-out](https://supabase.com/docs/reference/python/auth-signout).
- `node scripts/verify_karaoke_upgrade_live.mjs --check-live --allow-v1-draft
--project-ref <ref>`: cần backend/frontend localhost và phiên tạm đã cho phép.
  Kiểm tra Auth/API/MP3 Range thật, admin preview v2 trong bộ nhớ, màn bé dùng
  publication v1. Có thể tạo đúng một nháp v1 từ bài mẫu, **không lưu/publish v2**.
  Báo cáo/screenshot ở `.cache`, không commit token/signed URL/ảnh có dữ liệu thật.

Để chạy local nghiệm thu bằng dữ liệu thật mà không kích hoạt các worker OCR/
training ngoài phạm vi, đặt `APP_ENVIRONMENT=test`, `VIREAD_OCR_WARMUP_ENABLED=false`
chỉ cho tiến trình backend; frontend đặt `PLAYWRIGHT_AUTH_FIXTURES=0`. Không sửa
`.env` và không mang thiết lập kiểm thử này vào cấu hình production.

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

### Nâng cấp lời chạy theo từng tiếng (Phase 1–3, 2026-11-15)

Đã bổ sung format lời v2 vào JSONB hiện có; nâng cấp này không có migration,
bảng hoặc bucket mới. Bài v1 tiếp tục chạy theo câu. Chỉ bài được căn tiếng và
xuất bản thành v2 mới chạy theo tiếng. Không tự nâng cấp dữ liệu Supabase.

Luồng admin:

1. Với bài đang xuất bản, chọn **Tạo bản nháp từ bản xuất bản**; bản bé đang
   nghe được giữ đến khi admin xuất bản bản sửa.
2. Nhập lời và căn đầu/cuối câu bằng công cụ cũ. Chọn **Căn từng tiếng dòng N**.
   Lần đầu sẽ chuyển toàn bộ lời nháp sang v2; các tiếng mới chưa có mốc.
3. Lưu nháp rồi tải bản nghe thử. Mở lại câu cần căn. **Nghe câu từ đầu**,
   chọn tốc độ 0.75× hoặc 1×; **Lặp câu** giúp nghe lại cùng đoạn.
4. Chọn vùng căn tiếng (viền focus), bấm Space hoặc **Đánh dấu tiếng tiếp theo**
   khi nghe tới mỗi tiếng. Chọn **Đánh dấu cuối tiếng**/E cho tiếng cuối hoặc
   chỗ có khoảng nghỉ. Mốc cuối tiếng trước từ đầu tiếng sau chỉ là gợi ý.
   Chọn chip tiếng để sửa riêng đầu/cuối, tinh chỉnh ±50/100 ms, hoặc hoàn tác/Z.
   Phím tắt không áp dụng khi đang nhập ô văn bản/số hoặc thao tác nút/select.
5. **Tách cụm thành tiếng**, **Gộp với tiếng sau** và **Tách lại và căn lại câu**
   hỗ trợ sửa cách chia lời. Sửa nội dung tiếng xóa mốc của tiếng đó; sửa lời
   câu tách lại và xóa các mốc tiếng của câu. Thay MP3 xóa mọi mốc câu/tiếng.
6. Có thể sao chép mốc từ câu giống lời: chọn câu nguồn, bấm **Sao chép và dịch
   mốc**. Hai câu cần có đầu câu; kiểm tra cuối câu/nhịp và nghe lại sau sao chép.
7. **Lưu nháp khi căn** lưu qua API hiện có và dừng bản nghe thử. Tải/nghe lại
   bản đã lưu, kiểm tra điều kiện xuất bản. Bấm lỗi để đi đến đúng câu/tiếng,
   kể cả câu ở trang khác. Chỉ xuất bản khi dữ liệu hợp lệ và đã nghe duyệt.
8. **Xuất lời và mốc JSON** tải bản sao lời đang chỉnh (gồm mốc chưa hoàn tất).
   File này nhập lại được qua **File lời bài hát**; cần lưu sau khi nhập.

TXT/LRC UTF-8 vẫn tối đa 256 KiB; JSON v1/v2 tối đa 2 MiB. LRC thường chỉ có
mốc câu và mốc cuối gợi ý, chưa có mốc tiếng. Enhanced LRC chưa được hỗ trợ;
dùng JSON v2 hoặc căn trực tiếp trên admin. Ví dụ phần lời v2:

```json
{
  "format_version": 2,
  "lines": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "text": "Bé vui",
      "start_ms": 1000,
      "end_ms": 3000,
      "syllables": [
        {
          "id": "22222222-2222-4222-8222-222222222222",
          "text": "Bé",
          "start_ms": 1000,
          "end_ms": 1500
        },
        {
          "id": "33333333-3333-4333-8333-333333333333",
          "text": "vui",
          "start_ms": 1800,
          "end_ms": 3000
        }
      ]
    }
  ]
}
```

Đây là ví dụ contract, không phải mốc của bài thật. Mốc null và danh sách
tiếng trống chỉ được lưu nháp; xuất bản yêu cầu đủ thời gian, đúng thứ tự,
không chồng lấn, nằm trong câu/nhạc, nội dung ráp tiếng khớp câu. Có thể có
khoảng nghỉ. Tối đa 150 tiếng/câu và 10.000 tiếng/bài; ID không trùng.

Khi triển khai, backend đọc v1/v2 trước, frontend đọc v1/v2 tiếp theo, sau đó
mới xuất bản v2. Code cũ chỉ nhận v1 không đọc được bản đã xuất bản v2; cần
đối chiếu các bài v2 trước khi rollback. Không thay file migration cũ.

Phase 4 mới thay bố cục màn hát của bé/báo vào câu; Phase 5 mới căn/nghe duyệt
bài thật và xuất bản v2. Phase 1–3 chỉ đưa renderer dùng chung vào player hiện có.

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
timing của file khác mà chưa kiểm tra. Chỉ nghe thử không tự xuất bản. Editor
thủ công/advanced không có autosave; phải lưu nháp trước khi đóng tab. Wizard
auto-import có hàng đợi autosave; chờ trạng thái đã lưu, xử lý lỗi/conflict trước
khi rời trang. Hai luồng đều phải nghe duyệt và qua điều kiện xuất bản.

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

Upload và transaction DB không nguyên tử. Backend chỉ cố dọn đúng object mới
nếu ghi DB thất bại và xác minh chắc chắn không còn tham chiếu. Khi commit/DB
mơ hồ, giữ object. Sau migration auto-import, kiểm kê chỉ đọc gồm:

```sql
SELECT song_id, id AS version_id, state, audio_path, cover_path,
       reference_audio_path
FROM public.karaoke_song_versions
ORDER BY song_id, version_no;

SELECT id AS job_id, song_id, status, input_audio_path,
       input_reference_path, result_audio_path
FROM public.karaoke_processing_jobs;

SELECT id AS operation_id, job_id, state, artifact_paths
FROM public.karaoke_processing_operations;
```

Phải giữ mọi path được tham chiếu bởi **tất cả version, job và operation**,
kể cả nháp/SUPERSEDED, job đã kết thúc và operation UNKNOWN. `artifact_paths`
là mảng JSON, không được bỏ qua. Kiểm kê này không chứng minh một object an
toàn để xóa: còn phải xác minh upload/commit đang diễn ra và tình trạng DB.
Không dùng query version cũ làm căn cứ dọn auto-import. Chỉ xóa một object cụ
thể sau khi kiểm tra đầy đủ, nhận diện lần upload lỗi và có phép chủ project.
Lượt bàn giao này không thực hiện xóa dữ liệu. Không xóa theo prefix,
không reset bucket, không thêm cron dọn dữ liệu vào task này. Muốn gỡ demo hãy
ẩn bài qua UI, không DROP bảng hay xóa dữ liệu đọc.

## 7. Kiểm thử lại

### Nhánh karaoke-auto-import (chưa bật production)

Wizard đơn giản dùng cùng routes admin hiện có. Nó chỉ hiện luồng tự động khi
API capabilities cho phép; máy chủ chưa bật/cấu hình hoặc backend cũ sẽ giữ
editor thủ công. Không bật flags chỉ để thấy UI: quality gate cho engine local
vẫn chưa đạt và weights tiếng Việt hiện có giới hạn NC. Xem bằng chứng và các
điều kiện còn thiếu ở [trạng thái auto-import](docs/karaoke-auto-import/STATUS.md).
`?mode=advanced` giữ chế độ căn thủ công, không bỏ qua review gate của backend.

Trong wizard, ký hiệu `×2`, `x2`, `(×2)` hoặc `[x2]` ở cuối một câu có nút
**Mở rộng câu lặp**. Số lần hỗ trợ từ 2–9, tính cả lần đầu. Chỉ sau xác nhận,
hệ thống mới nhân chính câu đó; không đoán việc lặp cả đoạn hoặc thay lời bằng
nhận dạng AI. Có **Hoàn tác mở rộng lời** khi nội dung chưa bị sửa tiếp; thao tác
này khôi phục chữ, không hứa khôi phục mốc cũ đã bị vô hiệu. Ký hiệu trên dòng
riêng cần admin viết đầy đủ đoạn lặp. Mở rộng không tự tạo bài, gửi job hay publish.

Nếu kết quả chỉ xác định được mốc bắt đầu có hỗ trợ âm học, bản nháp giữ mốc đó
và để trống mốc kết thúc kèm cảnh báo. Đây là dữ liệu cần chỉnh/duyệt, không phải
một tiếng đã căn hoàn chỉnh và chưa đủ điều kiện xuất bản.

Bộ `test/browser/karaoke-wizard.pw.ts` kiểm tra wizard bằng HTTP/media giả, không
phải lệnh chạy worker hoặc nghiệm thu bài hát thật. Không tự áp dụng migration
hay tạo phiên đăng nhập thật để chạy bộ test này.

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
