# Kế hoạch triển khai Hát vui — Karaoke cho trẻ

Ngày chốt Phase 1: 2026-11-14. Nhánh: `feature/linh-karaoke`.

## 1. Mục tiêu và trạng thái

Admin quản lý bài hát hoàn toàn trên giao diện: tạo bài, tải nhạc nền, nhập lời,
căn thời gian, xem trước, lưu nháp và xuất bản. Phụ huynh chọn hồ sơ bé rồi mở
Hát vui để bé hát cùng nhạc và lời nổi bật theo từng dòng. Thêm bài mới không
cần sửa source code, chạy SQL cho từng bài hoặc triển khai lại ứng dụng.

Phase 1 tạo nhánh và chốt thiết kế trong tài liệu này. Tại thời điểm bàn giao
Phase 1, các bảng, bucket, API, component và thư viện dưới đây còn ở mức thiết
kế. Cập nhật triển khai Phase 2 nằm ở mục 12. Phase 1 không chạy migration,
tải nội dung lên Supabase, thay đổi dữ liệu ứng dụng hoặc commit/push nhánh.

| Phase | Kết quả                                                            | Trạng thái                                          |
| ----- | ------------------------------------------------------------------ | --------------------------------------------------- |
| 1     | Nhánh, khảo sát, thiết kế dữ liệu/API/UI, phạm vi file và baseline | Hoàn tất                                            |
| 2     | Backend, migration, Storage và kiểm thử quyền/lưu trữ              | Hoàn tất; đã áp dụng đúng Supabase được xác nhận    |
| 3     | Giao diện admin và bộ phát dùng chung                              | Đã triển khai; unit/browser/build đạt               |
| 4     | Thư viện và màn hát dành cho bé                                    | Đã triển khai; unit/browser/build đạt               |
| 5     | Kiểm thử tích hợp, trình duyệt và nghiệm thu upload thật           | Hoàn tất; live và hồi quy source cuối đạt           |
| 6     | Hướng dẫn, rà diff, commit/push/PR sau nghiệm thu                  | Kiểm tra đạt; bàn giao bằng PR nháp, không tự merge |

Phạm vi bản đầu: nhạc nền có sẵn, lời theo dòng, phát/dừng/tua/hát lại, quản trị
nội dung. Ghi âm, chấm điểm hát, nhận diện giọng hát, tạo nhạc, tách giọng,
video karaoke và lịch sử/báo cáo hát là task riêng. Module không ghi dữ liệu
karaoke vào các bảng phiên đọc hoặc báo cáo tiến bộ đọc.

## 2. Căn cứ đã kiểm tra trên source

- Repository: `D:\Project\capston1_new\capstone1`.
- Base `main`: `3f4651e89705dba27aa17cf6e87ac065f6d79cfa`.
- Đã `git fetch origin main`; `main...origin/main` là `0 0` trước khi tạo nhánh.
- Working tree sạch trước khi tạo `feature/linh-karaoke`.
- Chưa thấy module karaoke trong các route, component, service và migration đã
  khảo sát. Đây là kết luận về source; chưa khảo sát schema Supabase đang chạy.
- Backend theo `BACKEND_FLOW_STANDARD.md`; entrypoint giữ `app.sever:app`.
- `frontend/app/admin/(protected)/layout.tsx` kiểm tra role admin;
  `frontend/app/(app)/layout.tsx` kiểm tra role parent.
- `frontend/lib/auth/route-policy.ts` cần thêm prefix `/karaoke`; prefix `/admin`
  đã bao phủ các route quản trị mới.
- `frontend/components/admin/admin-layout.tsx` là điểm thêm menu Bài hát.
- `frontend/components/dashboard/dashboard-screen.tsx` là điểm thêm Hát vui,
  cùng luồng kiểm tra hồ sơ trước khi điều hướng đang có.
- `useValidatedSelectedChild` đã xác minh hồ sơ qua API và xử lý hồ sơ không
  hợp lệ. Store hiện giữ lựa chọn trong React state, không lưu qua tải lại trang.
- `frontend/lib/api/api-client.ts` đã hỗ trợ Bearer token, Zod, AbortSignal và
  FormData. Dùng lại client này, không tạo HTTP client mới.
- `AppServices` là interface chung có nhiều caller/test. Module dùng provider
  riêng trong các layout karaoke, tránh thêm service bắt buộc vào interface đó.
- `backend/app/api/deps.py:get_current_parent_id` xác thực user ID, không tự bảo
  đảm role admin, parent hoặc quyền sở hữu hồ sơ. Service mới phải kiểm tra thêm.
- `Profile.Active` và `Profile.Role` dùng để kiểm tra tài khoản còn hoạt động;
  `ChildProfile.ParentId` và `Grade` dùng kiểm tra sở hữu/lớp của bé.
- Storage hiện có helper upload/delete nhận bucket riêng; một số helper đọc/ký
  URL và thông báo lỗi dành cho ảnh. Karaoke có wrapper Storage riêng để không
  phụ thuộc cách xử lý ảnh/URL cũ.
- `ConcurrencyLimitedAsyncSession` giữ hạn mức theo transaction: tránh giữ
  transaction/khóa DB trong suốt thời gian upload hoặc phân tích media.
- Chưa có parser MP3 trong `backend/requirements.txt`; `mutagen` chưa được cài
  trong virtualenv lúc khảo sát. Python local 3.13.3; CI backend dùng 3.12.
- Node local 22.19.0, npm 10.9.3. PowerShell chặn `npm.ps1`; dùng `npm.cmd`,
  không thay đổi execution policy của máy.

## 3. Quy tắc nội dung và giới hạn bản đầu

| Nội dung       | Quy tắc                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| Nhạc           | MP3, phần audio MPEG Layer III, 1–300.000 ms, tối đa 20 MiB/file                   |
| Đọc thời lượng | Backend phân tích file; không tin duration hoặc MIME do client khai báo            |
| Ảnh bìa        | Tùy chọn; JPEG/PNG/WebP đầu vào, tối đa 2 MiB, mỗi chiều tối đa 4096 px            |
| Lưu ảnh        | Kiểm tra/giải mã bằng Pillow đang có, chuẩn hóa WebP, bỏ metadata không cần thiết  |
| File lời       | UTF-8 (chấp nhận BOM), TXT/LRC/JSON, tối đa 256 KiB khi nhập                       |
| Lời            | Tối đa 300 dòng; 300 ký tự/dòng; tổng text tối đa 50.000 ký tự                     |
| Thông tin      | Tên bài bắt buộc khi xuất bản, tối đa 200 ký tự; tác giả tối đa 200                |
| Nguồn          | `source_note` và `usage_note`, mỗi trường tối đa 1000 ký tự; bắt buộc khi xuất bản |
| Lớp            | `1 <= min_grade <= max_grade <= 5`                                                 |
| Danh sách      | `limit=12`, tối đa 50; `offset>=0`; search tối đa 120 ký tự                        |

Đây là giới hạn sản phẩm đã chọn, không phải giới hạn mặc định của Supabase.
Phase 2/5 kiểm tra thêm giới hạn request của môi trường triển khai để file tối đa
thực sự tải được. Khi cần điều chỉnh giới hạn phải đồng bộ UI, backend và bucket.

Chọn `mutagen==1.48.1` cho Phase 2 để đọc metadata MP3, bao gồm VBR, mà không cần
cài FFmpeg hay thay các thư viện OCR/AI. Đây là bổ sung có kế hoạch vào
`backend/requirements.txt`; chưa cài hoặc sửa requirements ở Phase 1. Parser đọc
metadata không thay thế thử phát/seek file thật trong trình duyệt.

Lời là text thuần, chuẩn hóa Unicode NFC và xuống dòng; không render HTML.
Dòng trống trong TXT được bỏ qua khi tách dòng; khoảng nhạc dạo thể hiện bằng
thời gian trống giữa các dòng đã căn.

### 3.1. Định dạng lời chuẩn

TXT/LRC được chuyển thành cùng một cấu trúc; JSON nhập theo đúng cấu trúc này:

```json
{
  "format_version": 1,
  "lines": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "text": "Dòng lời do admin nhập",
      "start_ms": null,
      "end_ms": null
    }
  ]
}
```

- `id` duy nhất trong bản lời; import TXT/LRC sinh ID mới. Mốc là số nguyên ms.
- Bản nháp cho phép danh sách trống và mốc `null` để lưu công việc đang làm dở.
  Text đã nhập phải không trắng và nằm trong giới hạn.
- Bản xuất bản có ít nhất một dòng, mọi mốc khác `null` và đáp ứng
  `0 <= start_ms < end_ms <= duration_ms`.
- Dòng theo thứ tự tăng thời gian; `end_ms` của dòng trước <= `start_ms` dòng sau.
  Không tự sắp lại JSON sai thứ tự hoặc âm thầm sửa mốc lỗi.
- Khoảng `[start_ms, end_ms)` là thời gian nổi bật của dòng. Ngoài các khoảng này
  không ép nổi bật dòng trước; có thể hiện Nhạc dạo hoặc Nhạc kết.
- Khi lưu timing đầy đủ và hợp lệ, backend tự đặt `timed_audio_sha256` bằng hash
  của audio hiện tại; client không được tự đặt trường này. Hash xác định file
  đã căn, không tự chứng minh lời hát khớp về ngữ nghĩa; admin phải nghe preview.
- Nhập TXT chỉ tạo dòng text với mốc trống, không tự chia đều thời lượng bài.
- LRC bản đầu nhận `[mm:ss.xx]` và `[mm:ss.xxx]`, có thể nhiều timestamp trước
  cùng một dòng. Tách thành các lần xuất hiện riêng, sắp theo thời gian.
- Có thể bỏ qua metadata tên/tác giả LRC; hỗ trợ offset nguyên ms nếu có, áp dụng
  trước validation. Báo lỗi dòng có timestamp sai hoặc giá trị âm sau offset.
- Với LRC chỉ có mốc bắt đầu, gợi ý kết thúc bằng mốc bắt đầu tiếp theo; dòng cuối
  bằng thời lượng nhạc. Đây là gợi ý để admin nghe và chỉnh trước xuất bản.
- LRC không có timestamp hợp lệ không được báo nhập/căn thành công; hướng admin
  về cách nhập lời văn bản. Enhanced LRC theo từng từ chưa được hỗ trợ.
- Dữ liệu text/timing trong ví dụ tài liệu và fixture chỉ minh họa cấu trúc;
  không được đưa vào danh sách bài thật của bé.

## 4. Dữ liệu và vòng đời phiên bản

### 4.1. `public.karaoke_songs`

| Cột                        | Thiết kế                                                |
| -------------------------- | ------------------------------------------------------- |
| `id`                       | UUID PK                                                 |
| `status`                   | `DRAFT`, `PUBLISHED`, `HIDDEN`                          |
| `published_version_id`     | UUID nullable; trỏ đúng version của chính bài này       |
| `revision`                 | Integer >= 1, tăng sau mỗi thay đổi để phát hiện ghi đè |
| `created_by`               | UUID nullable FK `profiles.id`, lưu người tạo           |
| `created_at`, `updated_at` | timestamptz                                             |

### 4.2. `public.karaoke_song_versions`

| Cột                                                      | Thiết kế                                          |
| -------------------------------------------------------- | ------------------------------------------------- |
| `id`, `song_id`                                          | UUID PK và FK đến bài hát                         |
| `version_no`                                             | Integer >= 1, duy nhất trong mỗi bài              |
| `state`                                                  | `DRAFT`, `PUBLISHED`, `SUPERSEDED`                |
| `title`, `author`                                        | Text có giới hạn; title nháp có thể để trống      |
| `min_grade`, `max_grade`                                 | Smallint; nháp mặc định 1–5                       |
| `source_note`, `usage_note`                              | Nguồn nội dung và ghi chú quyền sử dụng           |
| `audio_path`, `cover_path`                               | Text nullable, chỉ đường dẫn trong bucket karaoke |
| `audio_sha256`, `audio_size_bytes`                       | Dấu vết file và dung lượng do backend tính        |
| `duration_ms`                                            | Integer nullable, backend đọc từ nhạc             |
| `lyrics`                                                 | JSONB theo format 1; nháp cho phép mốc trống      |
| `timed_audio_sha256`                                     | Hash nhạc mà bộ mốc lời đã được kiểm tra với nó   |
| `created_by`, `created_at`, `updated_at`, `published_at` | Dấu vết tạo/xuất bản                              |

Ràng buộc/index: unique `(song_id, version_no)`; unique có điều kiện một version
`DRAFT`/bài; index status/pagination; FK kết hợp bảo đảm published version thuộc
đúng song; CHECK cho trạng thái, giới hạn số và khoảng lớp. Kiểm tra cấu trúc
lời và điều kiện xuất bản ở schema/service, không coi JSONB tự bảo đảm hợp lệ.

`created_by` có thể SET NULL khi xóa profile, tránh xóa kho nhạc theo tài khoản
người tạo. Bản đầu ẩn bài thay vì hard delete nội dung đã xuất bản.

### 4.3. Luồng trạng thái

1. Tạo song `DRAFT`, revision 1 và version 1 `DRAFT` trong cùng transaction.
2. Lưu thông tin/lời/tải file chỉ thay bản nháp. Một bài có tối đa một nháp.
3. Xuất bản: khóa ngắn và kiểm tra `expected_revision`, kiểm tra toàn bộ nội
   dung, chuyển nháp sang `PUBLISHED`, bản cũ sang `SUPERSEDED`, cập nhật con trỏ
   và trạng thái bài trong một transaction.
4. Sửa bài đã xuất bản: tạo nháp mới bằng bản sao dữ liệu đang xuất bản. Có thể
   dùng lại đường dẫn audio/cover không đổi; chưa ghi đè file cũ.
5. Khi tải nhạc thay thế vào nháp: giữ text, xóa mốc căn cũ và
   `timed_audio_sha256`. Admin căn lại hoặc nhập timing phù hợp rồi lưu.
6. Ẩn bài chuyển song sang `HIDDEN`; giữ published pointer và dữ liệu. Hiện lại
   bản đã xuất bản chỉ khi vẫn đáp ứng điều kiện nội dung và Storage.

Mọi mutation sau tạo mới nhận `expected_revision`; SQL cập nhật có điều kiện
revision, tăng revision và trả giá trị mới. Hai admin lưu đồng thời: một thao
tác thành công, thao tác dùng revision cũ trả 409 và yêu cầu tải bản mới.
Mutation lên draft nhận cả `draft_version_id`, tránh response cũ sửa nhầm nháp.
Publish/ẩn/hiện/tạo nháp cũng phải tuân thủ cùng cơ chế này.

## 5. Storage, phân quyền và giao dịch

- Bucket riêng `viread-karaoke`, private, giới hạn object 20 MiB.
- Object lưu: `songs/{song_id}/versions/{version_id}/audio/{asset_id}.mp3` và
  `songs/{song_id}/versions/{version_id}/covers/{asset_id}.webp`.
- Backend tự sinh ID/path, không nhận path tùy ý hoặc URL bên ngoài từ request.
- MIME lưu trong bucket chỉ `audio/mpeg`, `image/webp`; kiểm tra kích thước và
  nội dung thật ở backend trước khi upload, không dựa riêng đuôi file.
- URL media có thời hạn 60 phút; DTO có `audio_url_expires_at`. Database giữ path,
  không giữ URL có chữ ký. Client không nhận service-role key.
- Enable RLS trên hai bảng mới; không cấp truy cập trực tiếp từ browser cho
  anon/authenticated. Backend truy cập theo role DB hiện tại, kiểm tra bằng test.
- Storage policy cho bucket mới theo mô hình server/service-role đang có; không
  sửa policy của bucket ảnh/sách hoặc mở bucket public.
- Admin: token hợp lệ + profile `Role=admin`, `Active=1` cho tất cả API quản trị.
- Parent: token hợp lệ + `Role=parent`, `Active=1`; child tồn tại, thuộc parent;
  lớp đọc từ DB. Catalog/playback lọc `PUBLISHED` và lớp của version hiện tại.
- Admin preview là API riêng, không cần giả lập hồ sơ bé để xem nháp.
- Ẩn bài chặn catalog/cấp URL mới. URL đã cấp có thể còn dùng đến khi hết hạn;
  bản đầu không cam kết thu hồi tức thời luồng đang phát.

Upload file và transaction PostgreSQL không nguyên tử với nhau. Quy trình:
kiểm tra quyền/revision ngắn → đọc/kiểm tra file có giới hạn → upload đường dẫn
mới → kiểm tra lại quyền/revision trong transaction cập nhật pointer → trả DTO.
Không giữ khóa DB trong quá trình truyền file. Nếu cập nhật DB thất bại, dọn
object mới sau khi xác nhận nó không được tham chiếu; lỗi dọn được log an toàn
và có hướng dẫn xử lý object mồ côi. Không báo upload thành công nếu DB chưa lưu.

Không xóa file cũ khi thay nhạc nếu bất kỳ version nào còn tham chiếu. Bản đầu
giữ các version đã xuất bản, không thêm lịch dọn file nền hoặc cron vào hệ thống.
Hủy request trong UI không đồng nghĩa server đã hủy giao dịch; khi quay lại tải
lại draft/revision từ API để biết trạng thái thực tế.

## 6. Hợp đồng API dự kiến

Prefix `/karaoke` đăng ký trong `backend/app/api/router.py`; không thêm `/api`
vì entrypoint hiện include `api_router` trực tiếp. Tất cả endpoint dùng token.

| HTTP  | Path dưới `/karaoke`                      | Kết quả                                                  |
| ----- | ----------------------------------------- | -------------------------------------------------------- |
| GET   | `/admin/songs`                            | Danh sách admin: search, status, limit, offset; có total |
| POST  | `/admin/songs`                            | Tạo song/nháp; 201, trả detail/revision                  |
| GET   | `/admin/songs/{song_id}`                  | Thông tin song, published summary và nháp hiện tại       |
| POST  | `/admin/songs/{song_id}/draft`            | Tạo nháp từ bản xuất bản hoặc trả nháp đang có           |
| PUT   | `/admin/songs/{song_id}/draft`            | Lưu metadata/lời đang làm dở                             |
| POST  | `/admin/songs/{song_id}/draft/audio`      | Multipart MP3; trả metadata audio/revision mới           |
| POST  | `/admin/songs/{song_id}/draft/cover`      | Multipart ảnh; trả cover/revision mới                    |
| GET   | `/admin/songs/{song_id}/draft/validation` | Kết quả kiểm tra trước xuất bản, không sửa dữ liệu       |
| GET   | `/admin/songs/{song_id}/draft/preview`    | Snapshot nháp hợp lệ và URL nghe/xem trước               |
| POST  | `/admin/songs/{song_id}/publish`          | Xuất bản draft đã kiểm tra, trả detail mới               |
| PATCH | `/admin/songs/{song_id}/visibility`       | Body `visible: true/false`; kiểm tra có bản xuất bản     |
| GET   | `/songs`                                  | Catalog cho child_id; search, limit, offset; có total    |
| GET   | `/songs/{song_id}/playback`               | Snapshot bản xuất bản cho child_id, media URL và lời     |

Đăng ký các path admin tĩnh rõ ràng; không để path UUID tổng quát bắt nhầm route.
GET không tạo nháp, cập nhật last-played hay phát sinh dữ liệu hát.

### 6.1. DTO chính

- `KaraokeSongCreate`: title tối đa 200, có thể trống để tạo nháp; mặc định lớp 1–5.
- `KaraokeDraftWrite`: `expected_revision`, `draft_version_id`, metadata và
  `lyrics` format 1. Không cho client tự đặt audio path/hash/duration/state.
- Multipart: `file`, `expected_revision`, `draft_version_id`. Trả revision và
  thông tin server đã kiểm tra; lưu draft được thực hiện ở backend.
- `KaraokePublishRequest`: `expected_revision`, `draft_version_id`.
- `KaraokeVisibilityRequest`: `expected_revision`, `visible`.
- `KaraokeAdminDetail`: song/revision, published summary, draft DTO, cờ trạng thái.
  Không trả URL riêng tư khi chỉ cần liệt kê; preview cấp URL qua API tương ứng.
- Danh sách admin dùng `AdminSongSummary` gọn: thông tin hiển thị, status/revision,
  ID draft/published, cờ có nhạc/ảnh và ngày cập nhật; không tải toàn bộ lời của
  mọi bài trong một trang danh sách. Detail trả đầy đủ draft/published.
- `KaraokeValidation`: `{ valid, revision, draft_version_id, issues: [...] }`.
  Issue chỉ chứa `code`, `field`, `line_id?`; frontend ánh xạ sang tiếng Việt.
  Code gồm thiếu nhạc/thông tin, thiếu nguồn, timing trống/sai/chồng/vượt nhạc,
  timing không khớp audio và media không sẵn sàng. Không trả exception thô.
- `KaraokeSongCard`: song_id, version_id, title, author, lớp, duration_ms,
  cover_url nullable; không trả Storage path hoặc ghi chú quản trị.
- `KaraokePlayback`: song_id, version_id, title, author, duration_ms,
  audio_url, audio_url_expires_at, cover_url nullable và lyrics với mốc đầy đủ.

Playback nhận tùy chọn `expected_version_id` khi cần cấp lại URL cho snapshot
đang hát. Nếu bài vẫn xuất bản đúng version thì cấp lại, giữ vị trí phát; nếu
version đã đổi trả 409 và UI yêu cầu tải bản bài mới. Không tự đổi sang nhạc mới
với bộ lời cũ. Bài ẩn/ngoài lớp/không tồn tại trả 404 cho parent; hồ sơ không
thuộc parent cũng trả 404 để không lộ dữ liệu gia đình khác.

Status: 401 thiếu/sai đăng nhập, 403 sai role/inactive, 404 tài nguyên không được
phép thấy, 409 revision/version/state đã đổi, 413 file quá lớn, 415 media không
hỗ trợ, 422 dữ liệu không hợp lệ, 503 Storage/DB tạm không sẵn sàng. Thành công
luôn trả JSON theo schema để dùng được `requestApi`; không dùng success 204.

Client hiện chỉ cho phép một tập thông báo backend an toàn. Service karaoke
ánh xạ lỗi theo thao tác + HTTP status; lỗi chi tiết trước xuất bản lấy qua
`KaraokeValidation` kiểu hóa ở response 200. Không mở phản chiếu mọi `detail`
backend hoặc sửa interface lỗi chung để hiển thị lỗi nhà cung cấp.

## 7. Luồng frontend đã chốt

| Route                          | Vai trò/giao diện                                            |
| ------------------------------ | ------------------------------------------------------------ |
| `/admin/karaoke`               | Admin: tìm/lọc, phân trang, trạng thái, tạo/sửa/ẩn/hiện      |
| `/admin/karaoke/new`           | Admin: tạo bài rồi chuyển tới editor của nháp đã lưu         |
| `/admin/karaoke/[songId]/edit` | Admin: thông tin → nhạc/ảnh → lời/căn giờ → preview/xuất bản |
| `/karaoke`                     | Parent đã chọn bé: catalog phù hợp hồ sơ                     |
| `/karaoke/[songId]`            | Parent đã chọn bé: player của phiên bản được xuất bản        |

### 7.1. Admin

Form dùng các bước trên cùng một editor, nút Lưu nháp luôn rõ ràng. Khi mở editor
đọc detail trước; nút Sửa bản xuất bản mới gọi POST tạo nháp. Không tạo dữ liệu
trong GET/render. Cảnh báo rời trang khi còn thay đổi chưa lưu; chưa có autosave.

Upload hiện trạng thái đang tải/thành công/lỗi và chặn bấm lặp; bản đầu không
hiển thị phần trăm tiến độ giả. Khi thay nhạc, báo rõ sẽ cần căn lại lời trước
khi xác nhận gửi file. Upload xong dùng revision server trả về.

Trình căn lời có danh sách dòng, start/end định dạng phút:giây.mili-giây, nút
đánh dấu bắt đầu/kết thúc theo thời điểm nhạc, nghe lại dòng và chỉnh thủ công.
Nhập file chỉ phân tích text, không chạy script/HTML từ file. Dữ liệu nhập và
mốc đang chỉnh lưu vào draft, mở lại trang tiếp tục được.

Trước xuất bản lưu draft → tải validation cho đúng revision → preview → bấm
Xuất bản. Backend vẫn kiểm tra lại toàn bộ ở POST publish. Preview draft hoàn
chỉnh dùng cùng player và quy tắc timeline như màn bé.

API preview cũng cấp audio và lời nháp có mốc chưa hoàn chỉnh để editor nghe
nhạc trong lúc căn lời. Điều kiện đầy đủ của một bài vẫn được kiểm tra riêng
bằng validation và POST publish; không cần căn xong mới được nghe nhạc.

### 7.2. Bé và phụ huynh

Dashboard thêm Hát vui vào cùng cơ chế yêu cầu chọn bé đang có. Các trang karaoke
dùng `useValidatedSelectedChild`; không có lựa chọn thì về
`/dashboard?focus=child-selection&reason=missing`. Hồ sơ sai quyền/hết tồn tại
được xóa lựa chọn theo hook và yêu cầu chọn lại.

Refresh tab có thể mất selectedChildId vì store hiện là in-memory: bản đầu đưa
về chọn bé, không tự chọn bé đầu tiên hoặc mở quyền theo child_id trên URL.
Đây là hành vi chủ ý, không sửa persistence của store toàn ứng dụng trong task.

Catalog có loading/empty/error/retry riêng; ảnh bìa không bắt buộc, dùng icon và
nền màu khi thiếu ảnh. Không chèn bài mẫu để che danh sách trống hoặc API lỗi.
Màn hát hiển thị tên bài/bé, thời lượng, lời chữ lớn, dòng hiện tại/tiếp theo,
phát/dừng/tiếp tục/tua/âm lượng/hát lại/quay lại danh sách. Có trạng thái nhạc
dạo, buffering, lỗi media và kết thúc. Bắt đầu phát sau thao tác người dùng.

### 7.3. Bộ phát dùng chung

Một HTMLAudioElement là nguồn thời gian; đọc `currentTime`, không lấy đồng hồ
setInterval làm tiến độ nhạc. Dùng media events và requestAnimationFrame khi
đang phát; seeking/pause/buffering cập nhật timeline đúng vị trí thực tế.
`duration_ms` được đối chiếu với metadata trình duyệt; chênh lệch đáng kể phải
báo lỗi nội dung để admin kiểm tra, không âm thầm co/giãn mốc lời.

Đổi bài, đổi hồ sơ, mất phiên đăng nhập hoặc unmount: pause, bỏ source, abort
request, gỡ listener/hủy animation và bỏ kết quả request cũ. Volume ở mức vừa
phải, không tự phát lại khi chỉ tải lại dữ liệu. Có nhãn nút, thao tác bàn phím,
focus rõ, tương phản chữ và hỗ trợ reduced motion; không chỉ dùng màu để chỉ
dòng hiện tại. Thiết kế theo token/component đang có, dùng header/footer của
layout parent/admin hiện tại.

## 8. Danh sách file theo phase

### Phase 1 — thay đổi thực tế

- Tạo nhánh `feature/linh-karaoke`.
- Thêm `KARAOKE_PLAN.md` (tài liệu này); không thêm runtime code hoặc migration.

### Phase 2 — backend và migration

```text
backend/app/models/karaoke.py
backend/app/schemas/karaoke.py
backend/app/repositories/karaoke_repository.py
backend/app/services/karaoke_service.py
backend/app/services/karaoke_storage_service.py
backend/app/services/karaoke_media_service.py
backend/app/api/routes/karaoke.py
backend/test_karaoke.py
backend/test_karaoke_postgres_integration.py
supabase/migrations/<timestamp>_add_karaoke.sql
```

Sửa hẹp `backend/app/api/router.py`, `backend/app/models/__init__.py` và thêm
đúng dependency `mutagen==1.48.1` vào `backend/requirements.txt`. Media parsing
ở service riêng để unit test và không chặn event loop khi phân tích file/ảnh.

### Phase 3 — admin và phần phát dùng chung

```text
frontend/app/admin/(protected)/karaoke/layout.tsx
frontend/app/admin/(protected)/karaoke/page.tsx
frontend/app/admin/(protected)/karaoke/new/page.tsx
frontend/app/admin/(protected)/karaoke/[songId]/edit/page.tsx
frontend/components/admin/karaoke/karaoke-library-screen.tsx
frontend/components/admin/karaoke/karaoke-editor-screen.tsx
frontend/components/admin/karaoke/song-metadata-form.tsx
frontend/components/admin/karaoke/song-media-upload.tsx
frontend/components/admin/karaoke/lyric-timing-editor.tsx
frontend/components/karaoke/karaoke-services-provider.tsx
frontend/components/karaoke/karaoke-player.tsx
frontend/components/karaoke/lyrics-display.tsx
frontend/components/karaoke/karaoke-controls.tsx
frontend/hooks/use-karaoke-player.ts
frontend/lib/api/karaoke-service.ts
frontend/lib/api/admin-karaoke-service.ts
frontend/lib/karaoke/lyrics-import.ts
frontend/lib/karaoke/lyrics-timeline.ts
frontend/types/karaoke.ts
```

Sửa hẹp `frontend/components/admin/admin-layout.tsx` để thêm link Bài hát.
Provider của admin và parent chỉ gắn dưới layout karaoke tương ứng. Giữ type/API
của module trong file riêng; player dùng chung cho preview và bé để tránh viết
hai cơ chế đồng bộ lời khác nhau.

### Phase 4 — thư viện và màn hát của bé

```text
frontend/app/(app)/karaoke/layout.tsx
frontend/app/(app)/karaoke/page.tsx
frontend/app/(app)/karaoke/[songId]/page.tsx
frontend/components/karaoke/karaoke-library-screen.tsx
frontend/components/karaoke/song-card.tsx
frontend/components/karaoke/karaoke-player-screen.tsx
```

Sửa hẹp `frontend/components/dashboard/dashboard-screen.tsx` để thêm hành động
Hát vui và `frontend/lib/auth/route-policy.ts` để bảo vệ prefix `/karaoke`.

### Phase 5 — kiểm thử và nghiệm thu

Kiểm thử backend được viết cùng Phase 2; test frontend quan trọng viết cùng
Phase 3/4. Phase 5 chạy tích hợp và nghiệm thu toàn luồng, không chờ đến lúc đó
mới kiểm tra các thay đổi trước.

```text
frontend/test/karaoke-services.test.ts
frontend/test/karaoke-lyrics.test.ts
frontend/test/karaoke-admin.test.tsx
frontend/test/karaoke-player.test.tsx
frontend/test/browser/karaoke.pw.ts
KARAOKE_VERIFICATION.md
```

Test mới đặt dưới `frontend/test/` và `backend/test_*.py` để không rơi vào rule
ignore `tests/` hiện có. Test chỉ sửa thêm khi kỳ vọng của đúng điểm tích hợp
thay đổi: route policy, dashboard, menu admin. Không sửa workflow để bỏ check.

### Phase 6 — bàn giao

Thêm `KARAOKE_SETUP.md` hướng dẫn migration/bucket, giới hạn file, quy trình thêm
bài/căn lời/xuất bản, xử lý lỗi và kiểm tra object mồ côi. Hoàn tất verification,
rà source/secret/diff, commit/push/PR theo yêu cầu sau nghiệm thu. Không tự merge.

## 9. Tiêu chí kiểm thử và nghiệm thu

| Nhóm      | Bằng chứng cần có                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| Quyền     | Anonymous/parent không ghi admin; admin preview được; parent không dùng child gia đình khác; inactive bị chặn |
| Database  | Constraints, revision CAS, publish nguyên tử, một draft/bài, rollback trong PostgreSQL thử nghiệm             |
| Media     | MP3 thật CBR/VBR, file hỏng/giả đuôi/oversize/quá thời lượng, ảnh quá kích thước và lỗi Storage               |
| Lời       | TXT có dấu/BOM/CRLF, LRC offset/lặp dòng, JSON sai format, null draft, thứ tự/chồng/vượt thời lượng           |
| Phiên bản | Thay nhạc vô hiệu hóa timing; sửa nháp không đổi bản bé đang hát; stale publish/refresh URL bị chặn đúng      |
| Admin     | Tạo → upload → nhập/căn lời → lưu → reload → tiếp tục → validation → preview → publish → ẩn/hiện              |
| Player    | Nhạc dạo/kết, ranh giới start/end, pause/resume/seek/replay, buffering/media error, đổi bé/bài/unmount        |
| Giao diện | Desktop/mobile, bàn phím/focus, nhãn nút, reduced motion; trạng thái rỗng và lỗi không dùng mock thay thế     |
| Hồi quy   | Các điểm dashboard/admin navigation/auth; toàn bộ check dự án theo mức phù hợp, so với baseline               |

Integration PostgreSQL chạy trên DB disposable, không dùng database sản phẩm.
Migration mới kiểm thử trên DB thử nghiệm; trước áp dụng Supabase dùng chung
phải xác nhận target/migration và thực hiện trong bước triển khai được chỉ định.

Browser fixture kiểm tra UI/API contract, không được mô tả thành upload thật.
Tại Phase 1 người dùng chưa có bộ nội dung. Phase 5 đã bổ sung bộ thử có nguồn
và giấy phép trong `docs/karaoke-demo`, áp dụng migration vào project được
người dùng xác nhận và nghiệm thu MP3/Storage thật qua admin/parent UI. Kết quả
và giới hạn được ghi riêng ở `KARAOKE_VERIFICATION.md`.

Phase 1 không chạy production build/browser suite hoặc kiểm tra live Supabase;
không ghi chúng là đã đạt. Kết quả test lỗi có sẵn được ghi lại thay vì tự sửa
reading/OCR/auth hoặc các task khác.

## 10. Baseline Phase 1

Kiểm tra được khởi chạy trước khi thêm runtime code; tài liệu là thay đổi duy
nhất trên nhánh. Tất cả tiến trình kiểm tra dưới đây đã kết thúc.

| Kiểm tra                                  | Kết quả                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Git trước tạo nhánh                       | Sạch; main bằng origin/main sau fetch                                   |
| Frontend `npm.cmd run typecheck`          | PASS, exit 0                                                            |
| Frontend `npm.cmd run lint`               | PASS, exit 0; 0 error, 12 warning có sẵn                                |
| Frontend `npm.cmd run format:check`       | PASS, exit 0                                                            |
| Frontend `npm.cmd test -- --reporter=dot` | Exit 1: 104 file, 1739 test; 1724 pass, 15 fail ở 12 file; 228,71 giây  |
| Chạy lại 12 file fail, `--maxWorkers=2`   | PASS: 12 file, 175 test, 0 fail; exit 0                                 |
| Backend unittest discovery                | PASS, exit 0 trong cấu hình test/loopback; không cấp URL DB integration |
| Định dạng `KARAOKE_PLAN.md`               | Prettier đã định dạng; kiểm tra riêng trước bàn giao                    |
| Production build / browser / live DB      | Chưa chạy trong Phase 1                                                 |

Backend baseline dùng `.venv\Scripts\python.exe -B`, unittest discovery toàn
backend, APP_ENVIRONMENT=test, DATABASE_POOLER_MODE=local, SSL=false, DATABASE_URL
loopback và Supabase key giả. Lần import database config ban đầu tắt dotenv bằng
patch có phạm vi rồi khôi phục trước discovery; xóa các biến URL DB integration
khỏi process test. Đây không phải kết quả integration PostgreSQL của CI.

Lần chạy frontend toàn bộ diễn ra đồng thời với lint, typecheck và một phần
backend; nhiều failure là timeout 5 giây hoặc truy vấn UI hết thời gian. Chạy lại
đúng 12 file fail bằng 2 worker khi các check khác đã kết thúc: cả 175 test đều
pass mà không sửa source. Kết quả phù hợp với khả năng tải máy/timeout tác động;
chưa kết luận có lỗi logic xác định. Không ghi lần full suite đầu là PASS và
không coi rerun 12 file là một lần full suite mới đã đạt.

Lệnh recheck: `vitest run <12-file-fail> --maxWorkers=2 --reporter=json
--outputFile=test-results/karaoke-phase1-recheck.json`. Báo cáo nằm tại
`frontend/test-results/karaoke-phase1-recheck.json`, được Git ignore. Các file:

```text
test/real-admin-ui.test.tsx
test/real-books-ui.test.tsx
test/real-parent-reports-ui.test.tsx
test/session-complete.test.tsx
tests/admin/admin-ocr-review-screen.test.tsx
tests/admin/admin-parent-detail-screen.test.tsx
tests/admin/admin-parents-screen.test.tsx
tests/dashboard/dashboard-screen.test.tsx
tests/providers/app-store-provider.test.tsx
tests/reading/comprehension-question-flow.test.tsx
tests/reading/reading-screen.test.tsx
tests/support/help-support-screen.test.tsx
```

12 warning lint thuộc `admin-ocr-review-screen.tsx`, `book-page-content.tsx`,
`word-highlight-overlay.tsx` và `reading-socket-adapter.ts`; đều là unused vars.
Đây là baseline trước karaoke, không mở rộng task để sửa các phần đó.

### Điều kiện hoàn tất Phase 1

- [x] Tạo nhánh đúng base, kiểm tra source và điểm tích hợp.
- [x] Chốt phạm vi, file input, giới hạn, thư viện đọc MP3 và format lời.
- [x] Chốt dữ liệu, phiên bản, quyền, Storage, API và UI admin/bé.
- [x] Liệt kê file mới/file sửa theo phase và tiêu chí nghiệm thu.
- [x] Ghi đủ kết quả baseline, nêu rõ lỗi/môi trường/chưa kiểm thử.
- [x] Kiểm tra định dạng tài liệu và xác nhận Git chỉ thay tài liệu Phase 1.

## 11. Nguồn kỹ thuật

- Source hiện tại và các file được dẫn ở mục 2; thiết kế mới được ghi là dự kiến,
  không suy ra API hoặc bảng đã tồn tại chỉ từ tên thư mục.
- [Mutagen MP3 API](https://mutagen.readthedocs.io/en/latest/api/mp3.html):
  metadata và thời lượng MP3; [bản 1.48.1 trên PyPI](https://pypi.org/project/mutagen/1.48.1/)
  dùng Python >=3.10, wheel thuần Python; cần xác minh bằng fixture ở Phase 2.
- [MDN currentTime](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime):
  thời gian phát thực tế và thao tác seek.
- [Supabase private downloads](https://supabase.com/docs/guides/storage/serving/downloads):
  cấp URL có thời hạn cho object private.
- Tài liệu Next.js cài trong `frontend/node_modules/next/dist/docs/`; trước viết
  frontend code tiếp tục đọc đúng hướng dẫn layout/route/component của bản cài.

## 12. Bàn giao Phase 2

Đã tạo model/schema/repository/service/media/Storage adapter, 13 API và migration
`supabase/migrations/20261114130000_add_karaoke.sql`. Đã đăng ký model/router và
thêm duy nhất dependency `mutagen==1.48.1` trong virtualenv/backend requirements.
Các file frontend chưa triển khai ở phase này.

Migration đã chạy và được kiểm thử trong PostgreSQL 16 disposable cục bộ, gồm
constraints, publish/rollback, hai kết nối cùng ghi, RLS, quyền truy cập và
bucket private. Storage HTTP/Supabase Auth trong test là doubles có nhãn rõ.
Chưa áp dụng migration vào Supabase dùng chung, chưa tải nhạc vào Storage thật.

Các test và giới hạn nghiệm thu thực tế được ghi tại `KARAOKE_VERIFICATION.md`.
Phase 3 có thể dùng hợp đồng API đã triển khai để làm admin; Supabase thật cần
được áp dụng migration đúng dự án trước khi chạy nghiệm thu upload thật.

## 13. Bàn giao Phase 3

Đã triển khai `/admin/karaoke`, `/admin/karaoke/new` và
`/admin/karaoke/[songId]/edit` dưới layout kiểm tra quyền admin sẵn có.
Menu admin thêm duy nhất liên kết **Bài hát**. Không thay đổi auth, sách/OCR,
đọc sách, tiến bộ hoặc interface AppServices/AdminServices dùng chung.

- Danh sách tìm kiếm/lọc/phân trang, trạng thái trống/lỗi/thử lại; ẩn/hiện bản
  xuất bản có xác nhận và expected_revision.
- Tạo bản nháp, sửa metadata/lớp/nguồn/quyền sử dụng; upload MP3/ảnh qua API.
  Chặn upload khi có nội dung chưa lưu; xác nhận trước khi thay nhạc làm mất
  mốc thời gian. Không hiển thị phần trăm upload giả.
- Nhập TXT/LRC/JSON UTF-8, dán lời, thêm/xóa/sửa dòng; căn mốc nguyên ms,
  đánh dấu đầu/cuối theo audio.currentTime, nghe từng dòng. Mốc kết thúc LRC
  là gợi ý có thông báo, TXT không tự sinh thời gian.
- Player dùng chung chỉ tạo một HTMLAudioElement; đồng bộ lời theo currentTime,
  hỗ trợ phát/dừng/tua/âm lượng/đoạn nhạc và dọn audio khi đổi nguồn/rời màn.
  Không autoplay, không xin microphone, không ghi âm.
- Phải lưu, kiểm tra hợp lệ và bấm phát bản nghe thử đúng revision trước khi
  xuất bản; backend vẫn xác minh lại. Bản đã xuất bản chỉ được sửa qua nút tạo
  nháp rõ ràng, không ghi trong GET hoặc lúc render.
- Lỗi giữ lại form, chặn ghi tiếp khi 409 và có vùng sao chép nội dung trước
  khi tải lại; cảnh báo khi nhấn liên kết/rời tab với nội dung chưa lưu.
- Zod DTO/API adapter và provider riêng cho karaoke. Adapter parent chỉ chuẩn
  bị GET catalog/playback cho Phase 4; chưa thêm trang hát hay nút ở dashboard.

Test mới nằm dưới `frontend/test/`, không dùng làm dữ liệu dự phòng cho runtime.
Chi tiết kiểm thử, ảnh kiểm tra UI và giới hạn Supabase thật ở mục Phase 3 của
`KARAOKE_VERIFICATION.md`. Chưa commit/push và chưa áp dụng migration lên dự án
Supabase dùng chung. Bước tiếp theo: Phase 4 — thư viện và màn hát của bé.

## 14. Bàn giao Phase 4 — 2026-11-15

Đã thêm `/karaoke` và `/karaoke/[songId]` dưới parent layout; điểm vào là nút
**Hát vui** ở Tổng quan, chỉ mở khi đã chọn bé. Dùng AuthRuntime và
useValidatedSelectedChild hiện có, không sửa auth service, AppStore persistence,
AppShell/header/footer hoặc interface AppServices/AdminServices.

Thư viện hiển thị dữ liệu API thật theo hồ sơ/lớp, có tìm kiếm/phân trang,
loading/empty/error/retry và ảnh dự phòng bằng icon. Màn hát dùng bộ phát Phase 3:
tên bài/bé, lời hiện tại/tiếp theo, phát/dừng/tua/âm lượng/hát lại, đoạn nhạc,
buffering và kết thúc. Không tự phát, không ghi âm/chấm điểm hoặc ghi dữ liệu
karaoke vào bảng phiên đọc.

Provider parent riêng được bổ sung trong file karaoke provider đã có. Thêm
`karaoke-child-boundary.tsx` để tái sử dụng chờ khôi phục phiên, xác minh hồ sơ
và dừng player khi đổi bé/tài khoản hoặc mất auth. Tải lại URL nhạc luôn gắn với
version đang nghe; gặp 409 yêu cầu bấm Tải phiên bản mới, không đổi nội dung ngầm.
Refresh toàn trang vẫn yêu cầu chọn lại bé vì store in-memory theo thiết kế.

Ngoài file karaoke, chỉ sửa hẹp dashboard/route policy và test tương ứng.
Backend/migration giữ nguyên Phase 2; không ghi Supabase, đổi .env hoặc commit/push.
Kết quả kiểm thử và các bước chưa nghiệm thu thật ở mục 7 của
`KARAOKE_VERIFICATION.md`. Tiếp theo là Phase 5 — kiểm thử tích hợp/nhạc thật.
