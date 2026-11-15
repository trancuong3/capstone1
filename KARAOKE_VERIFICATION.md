# Karaoke — Kiểm chứng Phase 2

Ngày: 2026-11-14. Nhánh: `feature/linh-karaoke`, base `3f4651e`.

## 1. Phạm vi và môi trường

Phase 2 triển khai backend, migration và kiểm thử; UI admin/bé thuộc Phase 3/4.
Database chạy thử là PostgreSQL 16 trong container disposable riêng, cổng
`127.0.0.1:55447`, database `karaoke_phase2_test`. Test kiểm tra chặt host, port,
tên DB và username trước khi ghi; từ chối DB có bảng sẵn mà thiếu marker test.
Không dùng DATABASE_URL ứng dụng để lựa chọn DB integration.

Ảnh PostgreSQL dùng digest
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`.
Các bảng profiles/childprofiles và schema storage tối thiểu trong test được dựng
riêng để thực thi file migration thực tế. Đây không phải toàn bộ Supabase đang
chạy. Network Storage/Auth dùng test doubles; MP3 CBR/Xing-VBR là các MPEG frame
fixture tổng hợp cho parser, không phải bài hát để nghiệm thu trình duyệt.

Python local 3.13.3; `mutagen==1.48.1` được cài bằng `pip install --no-deps` vào
`backend/.venv`. Không thay phiên bản NumPy, PaddleOCR hoặc các dependency khác.

## 2. Kết quả

| Kiểm tra                                   | Kết quả                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Karaoke unit/API và PostgreSQL integration | 34 test đạt trong full suite cuối: 28 unit/API + 6 PostgreSQL                           |
| Hồi quy backend cuối                       | 908 test, 0 failure, 0 error; 37 skipped do không bật các integration DB khác; exit 0   |
| Storage metadata và URL                    | Dạng info mới/cũ, thiếu/sai size/MIME, sai origin/object được kiểm tra trong suite trên |
| Live Supabase migration/upload/sign URL    | Chưa chạy                                                                               |
| Frontend/browser/phát bài hát thật         | Thuộc các phase tiếp theo                                                               |

Test coverage chính:

- 13 route yêu cầu đăng nhập; mọi API admin từ chối parent/inactive.
- Input bỏ trường server-only, UUID, giới hạn text/timing, Unicode và format.
- Phân tích bytes MP3 CBR/Xing-VBR thực qua Mutagen; file hỏng, sai định dạng,
  quá dung lượng và quá thời lượng bị chặn. Ảnh được decode/chuẩn hóa WebP.
- Upload theo revision/draft ID; preview nghe nhạc ngay cả khi lời còn căn dở.
- HTTP multipart → lưu lời → validation → publish → parent playback → ẩn bài.
- Lưu/xuất bản đồng thời: kiểm tra SQL row lock và update có điều kiện revision;
  test thật hai kết nối chỉ có một writer thành công.
- Publish lỗi sau flush/update được rollback cả pointer, state và revision.
- Ràng buộc unique một draft/bài và FK published version đúng song trong DB thật.
- Thay nhạc tạo object khác, bỏ timing nháp, giữ nhạc/lời phiên bản đang xuất bản.
- Child ownership/lớp/active, tìm kiếm literal, phiên bản refresh đã cũ bị chặn.
- Khi commit/upload lỗi chỉ dọn object mới sau xác minh không có tham chiếu;
  DB không xác định được trạng thái thì giữ file và log an toàn.
- Storage không chạy khi còn transaction DB; không nhận external URL/path khác
  song; URL có chữ ký phải đúng origin, bucket và object.
- Metadata Storage dạng top-level/legacy đều được kiểm tra dung lượng, không
  bỏ qua thiếu size hoặc sai MIME. Lỗi provider không lộ thông tin nội bộ.
- RLS/ACL hai bảng chặn anon/authenticated; bucket private; policy restrictive
  chặn object karaoke kể cả khi test cố thêm policy authenticated permissive cũ.
  Quyền đọc bucket khác trong fixture không bị thay đổi.

## 3. Luồng code thực tế

Router: `backend/app/api/routes/karaoke.py`. Request schema và public DTO:
`backend/app/schemas/karaoke.py`. Service: `KaraokeService` trong
`backend/app/services/karaoke_service.py`. Repository: `KaraokeRepository` trong
`backend/app/repositories/karaoke_repository.py`. Model `KaraokeSong` và
`KaraokeSongVersion` ánh xạ `karaoke_songs` và `karaoke_song_versions`.

Tất cả route dùng `get_current_parent_id` xác thực token và
`get_karaoke_service` tạo service/repository theo session. Service kiểm tra thêm
Profile.Role/Active và sở hữu ChildProfile, không tin role/lớp gửi từ client.

| API dưới `/karaoke`                           | Router function → service             | Repository/ngoại vi thực tế                                                                       |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET `/admin/songs`                            | `admin_songs` → `admin_list`          | `actor`, `list_states`; read/rollback                                                             |
| POST `/admin/songs`                           | `create_song` → `create`              | `actor`, `create`, `add_draft`; commit                                                            |
| GET `/admin/songs/{song_id}`                  | `admin_song` → `detail`               | `actor`, `state`; read/rollback                                                                   |
| POST `/admin/songs/{song_id}/draft`           | `create_draft` → `draft`              | `actor`, `state(lock=True)`, `next_version`, `add_draft`, `bump`                                  |
| PUT `/admin/songs/{song_id}/draft`            | `save_draft` → `save`                 | `actor`, `state(lock=True)`, `bump`                                                               |
| POST `/admin/songs/{song_id}/draft/audio`     | `upload_audio` → `upload`             | Preflight read; `read_upload`/`inspect_audio`; Storage upload; locked state/bump; cleanup nếu lỗi |
| POST `/admin/songs/{song_id}/draft/cover`     | `upload_cover` → `upload(cover=True)` | Preflight read; `read_upload`/`normalize_cover`; Storage upload; locked state/bump                |
| GET `/admin/songs/{song_id}/draft/validation` | `validate_draft` → `validation`       | Snapshot read; `content_issues`; Storage verify ngoài transaction                                 |
| GET `/admin/songs/{song_id}/draft/preview`    | `preview_draft` → `preview`           | Snapshot read; Storage verify/sign ngoài transaction                                              |
| POST `/admin/songs/{song_id}/publish`         | `publish_song` → `publish`            | Preflight snapshot/media; locked state; `bump`; commit nguyên tử                                  |
| PATCH `/admin/songs/{song_id}/visibility`     | `set_visibility` → `visibility`       | Preflight/media khi hiện lại; locked state/bump/commit                                            |
| GET `/songs`                                  | `songs` → `catalog`                   | `actor`, `child_grade`, `list_states`; Storage ký cover sau rollback                              |
| GET `/songs/{song_id}/playback`               | `playback` → `playback`               | `actor`, `child_grade`, `state`; public DTO và media sau rollback                                 |

Router không viết SQL. Repository thực hiện select/join/count, FOR UPDATE,
flush/commit/rollback và CAS UPDATE; service quyết định trạng thái, quyền và áp
dụng thay đổi lên model. GET không tạo bản nháp hoặc ghi lịch sử hát.

Response chỉ qua schema được whitelist: parent không nhận Storage path, hash,
created_by, source/usage note; admin list dùng summary, detail có draft/published.
HTTP errors: auth 401/403; tài nguyên không được thấy 404; revision/version/state
409; file 413/415; dữ liệu 422; DB/Storage 503. SQL/ValidationError phía server
được dependency chuyển thành thông báo an toàn, không phản chiếu exception.

## 4. Cách chạy lại

Chạy unit tests từ `backend` bằng Python virtualenv, với cấu hình test và token
giả. Dùng `python -B -m unittest test_karaoke -v`.

Để chạy integration, tạo PostgreSQL disposable riêng bằng `postgres:16-alpine`,
bind loopback port 55447, user `karaoke_test`, DB `karaoke_phase2_test`; đặt biến
`KARAOKE_TEST_DATABASE_URL` vào đúng DB đó rồi chạy:

```text
python -B -m unittest test_karaoke test_karaoke_postgres_integration -v
```

Test tự dựng schema stub và áp dụng migration trong DB mới trống. Marker ghi hash
migration để rerun an toàn; nếu migration đổi, tạo lại container test riêng.
Không trỏ biến integration vào Supabase hoặc database ứng dụng.

Full regression dùng unittest discovery toàn backend, APP_ENVIRONMENT=test,
DATABASE_POOLER_MODE=local, DATABASE_SSL_REQUIRED=false, DATABASE_URL loopback,
Supabase URL/key giả và bật riêng KARAOKE_TEST_DATABASE_URL của container test.
Import config ban đầu tắt dotenv bằng patch có phạm vi rồi khôi phục trước
discovery; bỏ các URL integration DB khác khỏi process. Các test DB chưa được
cấp URL được ghi là skipped, không coi là đã kiểm chứng.

Kết quả runner cuối:

```json
{ "total": 908, "failures": 0, "errors": 0, "skipped": 37 }
```

Lần hồi quy trước đó có 906 test và cũng đạt; sau khi thêm hai test adapter
Storage đã chạy lại toàn bộ để có kết quả 908 ở trên. Không có kết quả frontend
hay live Supabase được suy ra từ unittest backend.

## 5. Giới hạn bàn giao

- Chưa áp dụng `20261114130000_add_karaoke.sql` vào Supabase dùng chung. Trước
  nghiệm thu thật phải xác nhận đúng dự án và áp dụng migration tại đó.
- Chưa xác minh Storage HTTP, CORS, Range/seek, URL hết hạn và giới hạn request
  trên môi trường triển khai thật; cần nghiệm thu bằng nội dung upload thật.
- Khi bàn giao Phase 2, Phase 3/4 chưa có giao diện/parser/player. Tiến độ
  Phase 3 sau đó được ghi riêng tại mục 6 bên dưới.
- Chưa commit, push hoặc mở PR; nhánh vẫn giữ thay đổi để triển khai phase sau.
- Container PostgreSQL disposable đã dừng và tự xóa sau kiểm thử; các hàng
  fixture bên trong là dữ liệu tạm đã được dọn, không phải dữ liệu ứng dụng.
- Unittest discovery của CI hiện có tự lấy unit tests mới; sáu test PostgreSQL
  karaoke dùng URL opt-in riêng, chưa nối job DB riêng vào workflow CI ở Phase 2.
- Tài liệu [Supabase info](https://supabase.com/docs/reference/javascript/file-buckets-info)
  xác nhận metadata size ở cấp object; adapter cũng hỗ trợ metadata.size kiểu cũ.

## 6. Phase 3 — giao diện admin và player dùng chung

### Phạm vi triển khai

Các route admin karaoke mới được bảo vệ bằng layout admin hiện có. Provider
riêng tạo `createAdminKaraokeService`; không thêm field bắt buộc vào global
AppServices/AdminServices và không dùng mock fallback.

| Hành động giao diện                      | API/service thực tế                                              |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Danh sách/tìm kiếm/trạng thái/phân trang | `list` → GET `/karaoke/admin/songs`                              |
| Tạo, tải lại bài hát                     | `create` POST list; `get` GET chi tiết                           |
| Tạo bản sửa từ bản xuất bản              | `createDraft` → POST `/{song_id}/draft`                          |
| Lưu metadata/lời/thời gian               | `save` → PUT `/{song_id}/draft`                                  |
| Tải nhạc/ảnh vào draft                   | `upload` → POST multipart `/{song_id}/draft/audio` hoặc `/cover` |
| Kiểm tra bản đã lưu                      | `validate` → GET `/{song_id}/draft/validation`                   |
| Cấp URL nghe thử                         | `preview` → GET `/{song_id}/draft/preview`                       |
| Xuất bản                                 | `publish` → POST `/{song_id}/publish`                            |
| Ẩn/hiện                                  | `visibility` → PATCH `/{song_id}/visibility`                     |

Tất cả mutation gửi đúng revision, draft mutation gửi thêm draft_version_id.
Validation/preview được kiểm tra lại song/version/revision ở adapter. Request
có AbortSignal, action dùng lock để tránh double submit; callback muộn sau
unmount không thay form. Khi 409, giữ nội dung và yêu cầu tải lại có xác nhận,
cho sao chép JSON nháp trước khi bỏ thay đổi. Có beforeunload và capture click
liên kết khi form dirty; không thay thế history/router nội bộ của Next.

Đã đọc hướng dẫn layouts/pages và phần điều hướng của Link từ Next 16.3.4
cài trong node_modules trước khi viết route/component. Dynamic params là Promise.

### Kiểm thử đã chạy

Lệnh unit/hồi quy liên quan từ frontend:

```text
npm.cmd exec -- vitest run test/karaoke-lyrics.test.ts test/karaoke-services.test.ts test/karaoke-player.test.tsx test/karaoke-admin.test.tsx test/header-footer.test.tsx test/api-client.test.ts --maxWorkers=2
```

Kết quả cuối: **6 file, 110 test, tất cả đạt**. Đây là suite có phạm vi,
không phải một lần chạy toàn bộ frontend. Test API dùng requestApi thật với
SDK session/HTTP doubles trong test; runtime không import fixtures.

- Parser: NFC/BOM/CRLF, TXT không timing, LRC nhiều mốc/offset/gợi ý end,
  JSON giữ ID/thứ tự; giới hạn dung lượng/số dòng/độ dài, ID trùng, float,
  giá trị không hữu hạn, LRC lỗi và text HTML không được thực thi.
- API: Bearer/no-store, filters/pagination, multipart không JSON Content-Type,
  song/draft/revision binding, URL media an toàn, whitelist DTO, HTTP lỗi
  giữ status và không phản chiếu SQL/token; parent GET adapter cho Phase 4.
- Player: không autoplay, native clock, gap và biên [start,end), seek/volume,
  pause/buffering/replay, nghe đoạn, reject play promise, late play sau dispose,
  đổi nguồn dọn audio, URL hết hạn và duration không khớp, lời đang nhập/text-only.
  Mốc được hiển thị thêm ở định dạng phút:giây.mili-giây; nút đánh dấu đọc thẳng
  audio.currentTime thay vì lấy state của lần render trước. Sau bảo vệ bấm Phát
  lặp, đã chạy lại riêng toàn bộ 11 test player và đều đạt.
- Admin: GET không tạo draft, tạo/sửa có chủ ý, bảo toàn form khi lỗi/409,
  upload reset timing có xác nhận, lưu trước upload, kiểm tra/nghe trước publish,
  invalidation khi sửa lời, chặn double save, abort, cảnh báo dirty,
  late file read, lọc/phân trang/ẩn và empty/retry.

Trình duyệt:

```text
npm.cmd exec -- playwright test --config=playwright.real-data.config.ts karaoke-admin.pw.ts
```

Kết quả cuối: **8/8 đạt** — 4 kịch bản trên desktop Chromium 1440×1000 và
mobile Chromium 390×844. Gồm nhập file LRC UTF-8 rồi lưu; danh sách/chi tiết/
active menu/không ghi trong GET; lưu → validation → native audio play/highlight
→ publish; 409 giữ form và hủy tải lại. Test cũng xác nhận không tràn ngang.

Đã xem ảnh toàn trang `karaoke-editor.png` của cả desktop/mobile trong
`frontend/test-results/real-data/`; các báo cáo/ảnh được ignore, không đưa vào Git.
Lần browser đầu có 4/6 đạt, 2 fail do selector role alert toàn trang khớp thêm
Next route announcer. Đã sửa selector trong test mới thành main → alert, thêm
kịch bản nhập LRC và chạy lại cả 8 test; không sửa logic auth/route announcer.

Playwright dùng cấu hình auth fixture development có sẵn, API loopback bị
intercept và WAV im lặng tổng hợp chỉ nằm trong test. Test có phát/giải mã audio
native thật trong Chromium, **không** chứng minh upload/decode MP3 qua Supabase
Storage thật. Không chạy backend thật, seed DB hay lưu key trong test.

Typecheck cuối: `tsc --noEmit --incremental false` **đạt**. Lần đầu lệnh có
incremental bị EPERM ở tsconfig.tsbuildinfo do sandbox ngoài workspace; chạy
không ghi cache đã đạt. Lint giới hạn các file karaoke/menu/test **đạt, 0 error,
0 warning mới**; không sửa 12 warning baseline ở OCR/reading.

Production build `npm.cmd run build` **đạt, exit 0** (Next 16.3.4/Turbopack).
Ba route admin karaoke xuất hiện dưới dạng dynamic server-rendered; build dùng
Supabase URL/key giả, API loopback và tắt auth fixtures trong process kiểm tra,
không sửa file .env. TypeScript trong build cũng đạt.

Format check giới hạn file thay đổi **đạt** sau khi định dạng lại hai file test
karaoke; không chạy formatter trên code OCR/reading/auth sẵn có. `git diff
--check` đạt cho các file tracked; các file mới được Prettier kiểm tra trực tiếp.

### Giới hạn còn lại

- Tại bàn giao Phase 3 chưa có thư viện/màn hát của trẻ và điểm vào dashboard;
  phần này được triển khai tiếp ở Phase 4, xem mục 7.
- Chưa áp dụng migration lên Supabase chung; cần xác nhận đúng dự án trước
  khi thực hiện. Chưa upload MP3/ảnh thật, kiểm tra Range/seek/CORS/expiry trên
  môi trường triển khai thật. Cần nhạc và lời có quyền sử dụng để nghiệm thu.
- Chưa chạy lại toàn bộ frontend hoặc backend ở Phase 3; chỉ menu admin là
  file runtime cũ được sửa (2 dòng). Backend giữ nguyên kết quả Phase 2.
- Back/Forward của trình duyệt, nghe thử 300 dòng trên thiết bị yếu, lỗi mất
  kết nối khi upload và expired Storage URL thật cần nghiệm thu Phase 5;
  không suy ra các kết quả đó từ unit/HTTP fixtures.
- Chưa commit, push, mở PR hoặc chạy dịch vụ để dùng thường trực.

## 7. Phase 4 — thư viện và màn hát dành cho bé

Ngày triển khai: 2026-11-15 (Asia/Saigon), cùng nhánh `feature/linh-karaoke`.
Không đổi backend/migration hoặc dữ liệu Supabase trong phase này.

### Luồng và điểm tích hợp

1. Dashboard thêm nút **Hát vui**, đi qua cùng kiểm tra selectedChildId của
   Quét sách/Chọn sách. Không có lựa chọn thì hướng về vùng chọn hồ sơ, không
   tự chọn bé đầu tiên hoặc dùng child_id từ URL.
2. `/karaoke` và `/karaoke/[songId]` nằm dưới parent layout hiện có; thêm
   prefix `/karaoke` vào route policy. Guest về login, admin về admin home;
   `/karaoke-preview` không bị nhận nhầm là route karaoke.
3. Provider cục bộ `ParentKaraokeServicesProvider` chỉ tạo GET service. Không
   thêm field bắt buộc vào AppServices/AdminServices hoặc sửa auth/store chung.
4. `KaraokeChildBoundary` chờ AuthRuntime sẵn sàng, rồi dùng
   `useValidatedSelectedChild` kiểm tra ownership. Mất phiên, đổi tài khoản,
   đổi/bỏ lựa chọn bé thì unmount cây player trước khi đọc nội dung mới.
5. Thư viện gọi GET `/karaoke/songs?child_id=...` qua adapter Phase 3, có tìm
   kiếm/phân trang/loading/empty/error/retry. API quyết định bài xuất bản và
   lớp phù hợp; không có bài mẫu dự phòng. Card thiếu/lỗi ảnh dùng icon.
6. Link bài hát mang version UUID, không mang child_id. Trang hát gọi GET
   `/karaoke/songs/{id}/playback?child_id=...&expected_version_id=...`; backend
   vẫn kiểm tra quyền/grade/visibility. Params song/version không hợp lệ được
   từ chối trước khi gọi API.
7. Tải lại nhạc gắn với **version vừa tải**, kể cả lần mở URL không có version.
   Nếu 409 thì bỏ player, thông báo phiên bản đã đổi và chờ nút **Tải phiên bản
   mới**. Không âm thầm đổi audio/lời. Reload luôn dừng audio và không autoplay.
8. Dùng cùng KaraokePlayer/HTMLAudioElement/timeline Phase 3, thêm nhãn cho bé,
   dấu chữ **Câu đang hát**, đoạn nhạc, kết thúc và nút Hát lại. Không ghi âm,
   không gọi microphone/STT/TTS, không ghi phiên đọc/báo cáo tiến bộ.

Mỗi request có AbortSignal và kiểm tra aborted trước callback. Các vùng dữ liệu
được key theo child/grade/song/version/query để không hiện kết quả của bé/bài cũ
trong lúc đổi lựa chọn. Header/footer vẫn dùng parent layout, không sửa AppShell.
Refresh tab mất selectedChildId sẽ về dashboard chọn lại, đúng thiết kế in-memory.

### Kiểm thử Phase 4

Lệnh hồi quy liên quan:

```text
npm.cmd exec -- vitest run test/karaoke-parent.test.tsx test/karaoke-player.test.tsx test/karaoke-lyrics.test.ts test/karaoke-services.test.ts test/karaoke-admin.test.tsx test/header-footer.test.tsx test/api-client.test.ts tests/auth/route-policy.test.ts tests/dashboard/dashboard-screen.test.tsx --maxWorkers=2
```

**9 file, 147 test, tất cả đạt.** 16 test parent mới dùng hook kiểm tra bé,
AppStoreProvider và HTTP adapters thật; chỉ Supabase session/fetch/audio được
thay bằng doubles trong test. Có kiểm tra no-selection, auth initializing/logout,
foreign child, loading/empty/error/retry, tìm kiếm/phân trang, abort/kết quả muộn,
ảnh bìa lỗi, native clock/end/replay, cleanup khi đổi bé/mất auth, 401/403/404/503,
409 cần hành động rõ ràng và refresh bound version. Không mock hook chọn bé.

Lần đầu riêng suite mới có 1 failure do test đọc status trước microtask seed
AppStore của harness; đã đổi test chờ status, không sửa runtime để né kiểm tra.
Hồi quy route policy/dashboard chỉ mở rộng kỳ vọng của đúng điểm tích hợp mới.

Lint giới hạn các file Phase 4 **đạt, 0 error/0 warning**. Typecheck runtime ban
đầu đạt; sau thêm test có hai lỗi TypeScript ở option `exact` của Testing Library
getByRole (option này thuộc Playwright, không thuộc Testing Library). Đã bỏ option
không hợp lệ trong đúng hai selector của test mới; không sửa runtime để né lỗi.
Không coi suite có phạm vi này là một lần chạy toàn bộ frontend/backend.

Đã bổ sung kiểm tra khe thời gian giữa SDK initialize và INITIAL_SESSION:
boundary karaoke chờ sự kiện đầu tiên, không coi session null tạm thời là logout.
Căn cứ là implementation onAuthStateChange/_emitInitialSession ở SDK cài cục bộ
và AuthServiceProvider hiện tại. Thay đổi chỉ ở boundary karaoke, không sửa auth
service/provider chung. Hồi quy 147 test đã chạy lại và đạt sau thay đổi này.

Browser đầu chạy:

```text
npm.cmd exec -- playwright test --config=playwright.real-data.config.ts karaoke.pw.ts karaoke-admin.pw.ts
```

**16/16 đạt**: 8 parent + 8 hồi quy admin, trên Chromium desktop 1440×1000 và
mobile 390×844. Sau bổ sung boundary chờ INITIAL_SESSION, chạy lại riêng:

```text
npm.cmd exec -- playwright test --config=playwright.real-data.config.ts test/browser/karaoke.pw.ts
```

**8/8 parent đạt lại** trên source cuối. Bao gồm dashboard chặn khi chưa chọn bé,
thư viện và playback theo bé/version, native audio play/highlight, rời trang dọn
audio, refresh/malicious child_id URL vẫn phải chọn lại bé, admin bị chặn khỏi
parent area, 503 khác empty và 409 cần nút cập nhật rõ ràng. Không pageerror hoặc
tràn ngang trong kịch bản UI chính. Đã xem ảnh library desktop và player mobile;
ảnh `karaoke-library.png`/`karaoke-player.png` và báo cáo ở test-results được ignore.
Lượt chạy cuối ghi đè báo cáo browser trước đó; báo cáo cuối chứa 8 parent case,
không cộng thành 24 test khác nhau hoặc coi là kiểm thử Supabase thật.

Các browser test dùng auth fixture development sẵn có, API intercept loopback
và WAV im lặng tổng hợp trong test. Không gọi Supabase thật hay lưu MP3 thật.
Production build cuối `npm.cmd run build` **đạt, exit 0** sau lượt browser cuối;
TypeScript cũng đạt. Hai route `/karaoke` và `/karaoke/[songId]` được build dynamic
server-rendered. Build dùng Supabase URL/key giả, API loopback, tắt auth fixtures
trong process; không sửa .env hoặc truy cập database thật.

Prettier check các file Phase 4/tài liệu **đạt** (đã định dạng lại file test
browser còn lệch); `git diff --check` đạt. Không còn tiến trình lắng nghe cổng
3000/8000/3106 khi bàn giao; test server đã tự dừng, không dừng ứng dụng khác.

### Phạm vi chưa nghiệm thu thật

Supabase chung vẫn chưa áp dụng migration karaoke từ Phase 2. Cần xác nhận đúng
project rồi áp dụng migration và upload nội dung có quyền sử dụng để nghiệm thu
MP3/Storage/Range/CORS/URL hết hạn thật ở Phase 5. Browser fixtures không thay
thế bước này. Không commit/push, mở PR, thay branch hoặc thay cấu hình .env.

## 8. Phase 5 — tích hợp và nghiệm thu môi trường thật

Ngày 2026-11-15 (Asia/Saigon), cùng nhánh `feature/linh-karaoke`. Các mục
"chưa nghiệm thu" ở Phase 2–4 là trạng thái lịch sử tại thời điểm đó; kết quả
dưới đây cập nhật chúng, không biến test fixture cũ thành test môi trường thật.

### Quyền triển khai và database

Người dùng xác nhận project `hgkklatgepyzbkkmwfvp.supabase.co`, cho phép thêm
hai bảng karaoke, bucket private và một bài thử; không sửa dữ liệu đọc hoặc
quyền tài khoản. Migration đúng file `20261114130000_add_karaoke.sql` được chạy
trong transaction sau khi kiểm thử PostgreSQL disposable đạt. Ghi nhận version
`20261114130000` trong lịch sử migration hiện có; không chạy reset/push toàn bộ.
SHA-256 migration:
`fb8122b746ec299af854c6763d9e0651a3bf4eb4da779e67c3a36131dd0c75ff`.

TLS được xác minh CA/hostname bằng CA Supabase, không dùng chế độ bỏ kiểm tra
chứng chỉ. Hai bảng cuối có RLS, anon/authenticated không có SELECT trực tiếp;
bucket `viread-karaoke` private. Số dòng của profiles/childprofiles/readingsessions/
readingevents/progressreports trước/sau transaction migration không đổi. Không
suy rộng kiểm tra trong transaction thành khóa toàn bộ dữ liệu của team.

### Bộ nhạc/lời và kết quả UI thật

Thêm `docs/karaoke-demo` gồm **Ngôi sao nhỏ**, MP3 piano của Alexander Blu từ
[trang nguồn](https://orangefreesounds.com/twinkle-twinkle-little-star-song/)
công bố CC BY 4.0, lời Việt mới và TXT/LRC/JSON/metadata. Không lấy lời bài hát
có bản quyền từ trang khác. File MP3 gốc không chỉnh sửa, 2.480.796 bytes,
192 kbps/44.100 Hz, backend đo 103.366 ms. SHA-256:
`47ebba49be8b7bc776db49c7918b88f0dedfd52f8ccb21e35f6a16e7cb9cbfd6`.
Ghi công/nguồn/giấy phép được giữ trong thông tin công khai cho người nghe và
README, không chỉ trong ghi chú admin. Cue dựa vào các đoạn giai điệu của bản
nhạc; chưa coi là nghiệm thu thẩm âm hoặc duyệt nội dung của con người.

Dùng phiên thật tạm được người dùng cho phép: một admin được chỉ định và một
parent đang có hồ sơ bé phù hợp. Không tạo tài khoản, đổi mật khẩu/role hoặc
gửi email. Không dùng auth/API fixture ở lượt live. Script opt-in riêng
`scripts/verify_karaoke_live.mjs` không được app/CI tự gọi, không nhận service key.

Đã đạt:

- Anonymous 401, parent bị chặn admin 403, admin được truy cập 200.
- Admin tạo bài, upload MP3, nhập 18 dòng, lưu/reload còn nguyên, validation,
  nghe thử bằng native audio và xuất bản qua UI.
- Parent chọn bé ở dashboard, vào thư viện, mở bài từ DB và phát MP3 từ Storage;
  pause, seek bằng bàn phím, kết thúc/hát lại, bố cục 390×844 không tràn ngang.
- Back/Forward/rời trang dừng và dọn audio; trở lại không tự phát.
- File MP3 giả thực sự bị 415, save revision cũ bị 409. Tạo draft từ published,
  thay MP3 xóa timing draft nhưng parent vẫn nhận đúng audio/lời bản cũ.
- Xuất bản version tiếp theo khiến request expected version cũ trả 409; UI
  chỉ tải bản mới khi người dùng bấm, không autoplay. Ẩn trả 404 cho parent,
  hiện lại trả 200. Không pageerror trong lượt live hoàn tất.

Trạng thái demo cuối: song `0374bb5e-426e-4375-8c1f-2f11c529e786`, PUBLISHED,
revision 10, published version `6a5f30ca-3c87-4792-aee3-37ea3ffe8c99`. Có một
published version, một superseded version và hai object nhạc đều còn tham chiếu.
Không tạo các bài thử khác hoặc ghi phiên đọc để giả dữ liệu karaoke.

### Storage thật

Range `bytes=0-1023` trả **206 / 1.024 bytes / audio/mpeg**. Tải toàn bộ bằng
signed URL trả 200 và hash trùng MP3 gốc; URL public không chữ ký trả 400.
CORS phản hồi `access-control-allow-origin: *`; player Chromium đọc/phát/seek
được. URL thử TTL một giây, chờ qua hạn, tải lại bị 400. Không ghi token hoặc
signed URL vào tài liệu hay source. Thử URL một giây chỉ phục vụ nghiệm thu;
TTL nghiệp vụ vẫn 3.600 giây. Ẩn không hứa thu hồi tức thời URL đã cấp.

### Lỗi tìm được và sửa trong module karaoke

- Slider bước 10 ms không tới đúng cuối MP3 có duration 103.366 ms khi nhấn
  End. Đổi bước thành 1 ms; thêm unit case duration không chia hết cho 10,
  rồi nghiệm thu lại keyboard End/hát lại bằng MP3 thật đạt.
- Tác giả có URL dài và tên bài tối đa 200 ký tự có thể tràn hoặc bị nút cao
  cố định cắt chữ. Chỉ đổi wrap/chiều cao trong component karaoke mới.
- Form 300 dòng quá nặng trên CPU chậm: chia nhóm 25 dòng và tách form khỏi
  clock animation audio. Lưu/validation/playback vẫn dùng toàn bộ 300 dòng,
  không bỏ dữ liệu ngoài trang; unit case giữ dữ liệu khi đổi trang/sửa/xóa/thêm.
- Test parent mới có race giữa render heading và effect tạo Audio. Đổi đúng
  test mới để đợi effect; không thay runtime hoặc nới timeout toàn bộ dự án.

### Phiên thử và ghi nhận tài khoản

Đã logout **scope local** hai phiên kiểm thử: admin 204, parent 204; xóa file
token tạm bị ignore, không logout các phiên khác. Khóa cấu hình vẫn ở backend,
không sửa .env hoặc đưa secret vào bundle/test/repository.

Quan sát readonly trên Supabase dùng chung thấy tổng admin đang hoạt động tăng
từ 3 lên 5, parent từ 13 xuống 11 trong lúc kiểm thử. Không có bước đổi role
trong các lệnh/script của task. Không xác định tác nhân hoặc quy kết thành viên.
Người dùng trả lời **“Không rõ, cứ giữ nguyên và ghi nhận”**; đã giữ nguyên.
Admin được chỉ định và parent được chọn vẫn có đúng role lúc kiểm tra cuối.

### Giới hạn và cách đọc bằng chứng

Backend cuối trước các chỉnh UI: **912 test tổng, 37 skipped, không failure/error**,
bao gồm sáu integration PostgreSQL thật và bốn test bundle MP3/lời offline.
Container disposable đã dừng và tự xóa fixture; Supabase thật không bị xóa.
Backend integration dùng Auth/Storage doubles; không gọi nó là full live.

Lượt full frontend trước tối ưu form cuối: **1.837 test đạt**. Browser và hồi quy
source cuối được chốt ở mục Phase 6 dưới đây. Các test browser API cô lập dùng
WAV tổng hợp/auth fixture, gồm CPU throttle/upload abort; phân biệt với lượt
Supabase thật dùng MP3 phía trên.

Chưa kiểm thử máy iOS/Android vật lý, nghe loa thực tế hoặc duyệt chất lượng
lời/căn nhạc bằng người. Bộ nhạc là nội dung thử có nguồn; nhóm cần nghe/duyệt
trước khi dùng cho trẻ thật. Live kiểm thử MP3 2,48 MB, không tuyên bố đã kiểm
tra reverse proxy sản phẩm với file 20 MiB hoặc bản VBR thật khác. Guard về
bytes/duration/size/ảnh lỗi được kiểm tra trong backend suite. Không thêm ghi
âm, chấm điểm, báo cáo hát hoặc thay tính năng đọc sách vào task.

## 9. Phase 6 — hướng dẫn và bàn giao

Đã thêm `KARAOKE_SETUP.md` hướng dẫn môi trường/migration, chạy app, nguồn nội
dung, thêm bài/căn lời/xuất bản, quyền truy cập, xử lý lỗi và object mồ côi.
Không tự dọn object theo prefix hoặc xóa version cũ còn tham chiếu.

Chốt kiểm tra source cuối và bàn giao Git. Base ban đầu `3f4651e`; khi fetch
lại, `origin/main` đến `4c8e768` (hai commit OCR mới). Các file của hai commit
đó không trùng các file karaoke. Không tự merge PR hoặc sửa OCR ngoài phạm vi.

Kiểm tra source cuối đã xác nhận:

- Browser karaoke **22/22 đạt**, Chromium desktop 1440×1000 và mobile 390×844,
  không retry/flaky. Gồm giới hạn 300 dòng khi CPU chậm 4 lần, upload bị ngắt,
  tên bài 200 ký tự không bị cắt, cùng các luồng admin/parent đã liệt kê. Đây
  là API/media fixture cô lập, không phải thêm 22 lần thao tác Supabase thật.
- Các lượt stress ban đầu fail; đã sửa form phân trang, tách clock và nhãn
  selector có mô tả phụ, rồi chạy lại toàn bộ 22 case trên source cuối đạt.
- Prettier check tất cả frontend staged, `node --check` script live và
  `git diff --cached --check` đạt.
- Rà 63 file staged bằng giá trị secret thực từ .env trong bộ nhớ: không có
  khớp; không có .env, token, private key, node_modules, cache hoặc kết quả test
  trong staged diff. Chỉ có bộ MP3/lời đã ghi rõ nguồn là media được commit.
- Hồi quy toàn frontend trên source cuối: **1.838/1.838 đạt, không skipped**,
  `npm.cmd test -- --maxWorkers=2 --reporter=json
--outputFile=test-results/karaoke-phase6-final.json`. Chạy tuần tự với các
  check khác để hạn chế quá tải; mất khoảng 466 giây trên máy local.
- Lint toàn frontend: **0 error, 12 warning có sẵn** thuộc bốn file OCR/reading
  đã ghi ở baseline. Không thêm warning karaoke, không sửa phần ngoài phạm vi.
- Typecheck toàn frontend `tsc --noEmit --incremental false` **đạt**.
- Production build Next.js 16.3.4 **đạt, exit 0** sau browser và full unit suite;
  năm route karaoke/admin karaoke được build dynamic. Build cuối dùng URL/key
  Supabase giả, API loopback và tắt auth fixture chỉ trong process. Không sửa
  .env hoặc xem việc build là một lượt nghiệm thu Supabase mới.

Nhánh bàn giao `feature/linh-karaoke`, PR nháp vào `main` để nhóm review.
Không tự merge hoặc đổi branch của người dùng. Hướng dẫn/setup và báo cáo này
được commit cùng source; trạng thái CI/mergeability xem trực tiếp trên PR.
Các server local 3000/8000 và server kiểm thử 3106 đã dừng. Bài demo và các
version được giữ trên Supabase; chỉ phiên đăng nhập/container test tạm đã dọn.
