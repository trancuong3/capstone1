# Kiểm thử frontend và nguồn benchmark — 2026-11-19

Nhánh `feature/linh-karaoke-auto-import`, baseline
`d4402915126ffcb5f26eca710d4d381e2841de31`. Quyết định mới nhất: chủ dự án cho
bỏ qua benchmark/nghe duyệt để bàn giao source và cho phép commit/push/PR nháp;
không coi quality gate đã đạt. Xem [RELEASE](RELEASE.md). Các mục sau “Mốc trước”
là lịch sử, không phải cùng lượt chạy cuối. Không cộng các bộ kiểm thử overlap.

## Lượt cuối sau sửa review focus và pipeline-version isolation

Full backend:1.068 tests, OK,38 skipped,307,699s; chạy bằng harness DB loopback
disposable, không Supabase thật. DB tạm đã dừng sau kiểm thử. Log private:
`.cache/karaoke-benchmark/backend-review-pipeline-final-20261119.log`, SHA256
`ecd1b930dcce00cc98830048aabf5a0d8d091075decf2ac464806536a36d9f8c`.
Skipped không phải bằng chứng model/provider hoặc mọi môi trường đã chạy.

Full frontend chạy tuần tự với endpoints giả, không cùng lúc unit/build:

| Check                     | Kết quả                                              | Thời gian wall |
| ------------------------- | ---------------------------------------------------- | -------------- |
| Prettier --check .        | exit0                                                | 20,3301s       |
| ESLint .                  | exit0,0 errors/13 warnings ngoài phạm vi đã ghi nhận | 78,4128s       |
| TypeScript --noEmit       | exit0                                                | 12,3791s       |
| Vitest run --maxWorkers=2 | 120 file,1.981 tests đạt, exit0                      | 640,5594s      |
| Next production build     | exit0, static generation38/38                        | 59,5871s       |

Vitest duration638,40s; khác wall wrapper. Log và `verification.json` private ở
`.cache/karaoke-benchmark/frontend-review-final-20261119/`. SHA256 log unit:
`fac71c8e30ef868e67a46af31b7821bd6c292a54d5aafb168ea3b56071158cd5`;
build: `86d387ec3d3d9afb14b5678a195494a36dcf9975828ca393fd82a76797f32c57`.
Format/lint/typecheck có cùng hash với lượt lịch sử bên dưới. Không thay test
timeout, tắt assertion hoặc nâng package để đạt kết quả.

Hai ca browser desktop/mobile mới kiểm sửa tiếng sau khi nghe reference đều
đạt; dùng fixtures, không có nghe duyệt hoặc publish thật. Nhóm wizard/syllables
36/36 và SQL/worker/shutdown19/19 là các lượt riêng, không cộng vào discovery.
Chi tiết lỗi trước/sau ở [ORDERED-ALIGNMENT-20261119.md](ORDERED-ALIGNMENT-20261119.md).

Readiness DB đích được kiểm chỉ đọc, không start worker/model: hai bảng
processing và các cột creation/reference/review chưa có; feature/worker false,
configured false, quality gate NOT_VERIFIED. Chưa apply migration hoặc sửa env
thật. Nhánh chưa nhập origin/main mới `90f7725f37d0a48a63607fd834043a8add299ebf`;
các lượt local không chứng minh CI hay tương thích main mới.

Mốc nghiên cứu86/160 cặp đủ,128 onset là lượt trước corpus ELLA. Kết quả
ELLA/PhoWhisper mới hơn ở [ELLA-CALIBRATION](ELLA-CALIBRATION-20261119.md),
không phải runtime thay thế hoặc độ chính xác đã được kiểm chứng. Reference
độc lập/nghe duyệt vẫn thiếu. Quyền bàn giao Git mới nhất không bao gồm ghi
DB/Storage dùng chung, bật tính năng hoặc nghiệm thu/rollout.

## Mốc trước — frontend sau upload hardening

Các trạng thái cấm commit/push và số bài dưới đây là ghi nhận ở thời điểm đó;
quyết định mới nhất ở đầu tài liệu và RELEASE.md có ưu tiên.

Chạy tuần tự, không đồng thời unit/build. Dùng Node và dependencies đã cài,
không nâng cấp package; Supabase example và API loopback port1, auth fixtures0.
Không chạy backend, worker/model hoặc gọi Supabase thật.

| Check                     | Kết quả                                                | Thời gian wall |
| ------------------------- | ------------------------------------------------------ | -------------- |
| Prettier --check .        | exit0                                                  | 20,5595s       |
| ESLint .                  | exit0, 0 errors, 13 warnings ngoài phạm vi đã ghi nhận | 82,9442s       |
| TypeScript --noEmit       | exit0                                                  | 15,946s        |
| Vitest run --maxWorkers=2 | 119 file, 1.962 tests đạt, exit0                       | 540,7898s      |
| Next production build     | exit0, compile và static generation38/38 thành công    | 31,4969s       |

Vitest báo duration536,87s, khác thời gian wall do wrapper đo toàn tiến trình.
Đây là full run mới sau bốn ca upload hardening; lượt1.958 cũ trong STATUS là
mốc lịch sử, không cộng hai lần. Không tăng timeout hoặc bỏ assertion.
Không chạy lại Playwright trong lượt này vì không thay runtime frontend; các
lượt36/36 và wizard8/8 trước đây vẫn là bằng chứng fixtures lịch sử, không live.

Log SHA256, thư mục local workspace `.cache/karaoke-benchmark/frontend-final-20261119`:

- format: `17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20`.
- lint: `87e1c5a922259c34847544b10035feff882a17d049dc76deafd42d50d89c589f`.
- typecheck: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- unit: `fc5c332a224ecf31e7c45d6fe3b05974acca11bc49f1e912e4c577f8bf04226a`.
- build: `f1aea5f21d22e9a8b1edad67029431929edba39932c719f7470fa41313bd09cb`.

## Readiness local

Script `check_karaoke_processing_readiness.py --check-weights` với cấu hình
tiến trình kiểm thử và đúng `runner.py`: exit0, configured=true, weights_match=true,
enabled=false, worker_enabled=false. Không dùng --check-schema; worker health
NOT_CHECKED_USE_SUPERVISOR và production quality gate NOT_VERIFIED.
Lượt đầu người chạy nhập nhầm engine_cli.py nên configured=false; không phải
lỗi `.env` ứng dụng. Không sửa `.env` thật hoặc bật tính năng để sửa phép thử.
`git diff --check` đạt cho tracked diff, không thay thế audit untracked/secrets.

## Nguồn mới, không phải benchmark được chấp nhận

- [Những Hạt Giống Mới](https://commons.wikimedia.org/wiki/File:Nh%E1%BB%AFng_H%E1%BA%A1t_Gi%E1%BB%91ng_M%E1%BB%9Bi.ogg):
  Commons API trả metadata OGG1.014.133 byte, uploader khai Own work/CC BY-SA3.0,
  có ảnh bản nhạc cùng tên. Host media trả HTTP429 cho cả audio và score;
  không có file nhận được. Đã dừng tải, không đổi host/UA để né giới hạn.
- [Trang tác giả VietSing](https://bhattaraibinit.com.np/) có link paper hội nghị
  APSIPA2024; DOI10.1109/APSIPAASC63619.2025.10849014. PDF chưa đọc được do
  timeout/connection error, IEEE yêu cầu xác minh trình duyệt. Chưa xác minh
  release, license, audio hoặc annotation; không suy ra corpus public từ tên paper.
- [sunbv56/song_dataset README](https://huggingface.co/datasets/sunbv56/song_dataset/raw/main/README.md)
  đọc được: JSONL lời/word timestamps/streaming URLs, nhãn Apache2.0. README chưa
  chứng minh quyền từng bản thu/tác phẩm hoặc human reference. Không tải streams.
- [duclvQ/smad README](https://huggingface.co/datasets/duclvQ/smad/raw/main/README.md)
  trả401; không đăng nhập hoặc thử vượt quyền. Chưa xác minh nội dung.

Không có positive benchmark mới được chấp nhận. Hai bài private đã xử lý vẫn
LYRICS_NOT_MATCHED; không nhân lời, dùng ASR làm ground truth hoặc giả timestamps.
Không đưa nhạc chưa rõ quyền vào Git, Storage hoặc catalog.

## Nghe duyệt và các cổng chưa đạt

Chủ dự án trả lời “Tôi chưa nghe, sẽ kiểm tra sau” cho trang nghe private19/11.
Đây là PENDING, không phải chấp nhận stems hoặc cho phép xuất bản. Chưa có
5–10 bài Việt đủ quyền/lời đúng bản thu, annotation và held-out để chứng minh
quality target. Chưa có full-song candidate v2 đạt chuẩn, live acceptance hoặc
rollout. Unit/build xanh không thay thế các cổng đó.

Không commit/push/merge, không ghi DB dùng chung, không sửa env thật hoặc publish.
Các bước đích cần quyền triển khai riêng và quality gate đạt trước khi thực hiện.
