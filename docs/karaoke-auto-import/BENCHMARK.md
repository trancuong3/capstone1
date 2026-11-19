# Phép đo Phase 1 cho karaoke tự động

Công cụ `scripts/benchmark_karaoke_alignment.py` chỉ so hai JSON lyrics v2 với
MP3 local. Dùng parser/validator hiện có, không đọc `.env`, gọi API/DB, chạy model
hoặc viết dữ liệu. Output JSON ra stdout; cần backend environment có dependencies
hiện có. Đây là phần chuẩn bị đánh giá engine trong [PHASE1.md](PHASE1.md).

## Thiết kế dataset và annotation

Chọn 5–10 bản có vocal tiếng Việt và quyền sử dụng rõ. Người cung cấp phải xác
định cả quyền nhạc nền, bản thu và lời; quyền một thành phần không đủ kết luận
cho toàn bài. Không lấy ngẫu nhiên nhạc thương mại hoặc giọng trẻ làm dữ liệu.

Manifest mỗi case lưu: case_id, split calibration/held_out, nhóm thuận lợi/khó/
negative, local audio path, audio SHA256, thời lượng, lời v2 input và hash,
nguồn/license, người kiểm quyền, người annotation, người kiểm lại, hash reference,
ghi chú ngân/lặp/bè/intro. Không lưu secret hoặc signed URLs. Các bài cùng bản
thu/bản phối không chia qua hai split. Đóng băng manifest và hash trước chạy held-out.

Annotation dùng đúng ID/thứ tự/text input v2; nghe đánh dấu start/end mỗi tiếng
trên timeline MP3 phát cuối. Kiểm lại những mốc khó ít nhất hai lượt, ghi sai khác
và cách thống nhất. Tiếng không thể xác định vẫn giữ trong manifest là unavailable
reference; lập case đo hoàn chỉnh riêng, công bố số unavailable trước khi tính
metric. Bản đầu evaluator yêu cầu reference v2 đầy đủ; không âm thầm xóa tiếng
khó khỏi denominator để tạo reference hợp lệ.

Prediction giữ nguyên ID/thứ tự/text. Không align được thì để null, không drop
câu/tiếng. Script từ chối identity/text lệch; đây là lỗi pipeline cần báo cùng
số case failed, không loại file khỏi báo cáo. Normalization Unicode dùng schema
hiện có; không tự thay lời bằng transcript.

## Chuỗi thử nghiệm

1. Một bài thuận lợi: kiểm tra decoder/timeline, tách vocal/instrumental, đo lại
   MP3 encode. Không strip silence hoặc time-warp không lưu mapping.
2. Căn lời cho sẵn theo vocal bằng ứng viên đã khóa code/model tạm. STT là bằng
   chứng đối chiếu lời; không thay annotation bằng timestamps STT.
3. Đổi về IDs/timeline v2, giữ unknown mốc null, xuất prediction local. Chạy phép
   đo dưới đây; người nghe kiểm cả nhạc nền và highlighting.
4. Chỉnh tham số trên calibration, khóa pipeline rồi chạy held-out một lần.
   Báo mọi case bao gồm failed và các mẫu chưa trả mốc. Nếu chỉnh tiếp phải
   khai báo benchmark lặp hoặc chuẩn bị held-out mới.
5. Thử negative: silence/instrumental-only/lời không khớp/reference khác intro,
   tempo hoặc cắt đoạn; ghi expected safe error, actual result và false acceptance.
   Công cụ metric không nhận biết vocal, cần pipeline thật cho bước này.

Ghi môi trường OS/Python/library/model revision/weights hash, processing wall
time, peak RAM/VRAM, CPU/GPU, provider usage/cost nếu biết, artifacts/hash và
manual correction time. Unknown ghi null/unknown, không suy ra 0. Ghi raw
provider output ở artifact riêng đã lọc dữ liệu; report không chứa credentials.

## Định nghĩa metric

- `reference_syllables`: tất cả tiếng trong reference hợp lệ; missing và invalid
  prediction vẫn thuộc mẫu số.
- `coverage`: tiếng có cặp mốc prediction hợp lệ / toàn bộ tiếng reference.
- `onset_hit_rate_all_reference`: số tiếng hợp lệ sai đầu ≤250ms / toàn bộ reference.
  End hit-rate cùng định nghĩa cho điểm cuối; không gộp đầu/cuối thành một độ đúng.
- `*_median_ms_matched_only`, `*_p95_ms_matched_only`: lỗi tuyệt đối của phần có
  mốc hợp lệ; p95 nearest-rank. Không coverage thì null. Luôn đọc cùng coverage.
- `lines_needing_correction`: câu có tiếng thiếu/lỗi hoặc đầu/cuối lệch >250ms.
- `structural_issue_count`: dùng `timing_issues()` hiện có. Line có structural
  issue không đóng góp successful hits; không làm đẹp score bằng span sai.
- `onset_target_met_this_case` chỉ là kiểm tra số học ≥90%; `quality_gate_status`
  luôn NOT_EVALUATED. Nhiều bài, license, nguồn annotation, stems quality và nghe
  duyệt vẫn cần con người đánh giá trước khi chốt engine.

Báo cả kết quả từng bài và tổng theo nhóm. Tổng hit-rate là sum(hits)/sum(reference),
không trung bình phần trăm không trọng số. Không average median/p95 của từng bài
rồi gọi là percentile tổng: cần lỗi từng tiếng để tính tổng, nếu chưa có thì chỉ
công bố từng bài. Đừng trộn số liệu manual/synthetic với engine held-out.

## Cách chạy offline

Từ repo root, dùng đúng environment đã có:

```powershell
.\backend\.venv\Scripts\python.exe -B scripts/benchmark_karaoke_alignment.py --audio docs/karaoke-demo/ngoi-sao-nho.mp3 --reference docs/karaoke-demo/ngoi-sao-nho-v2.json --prediction docs/karaoke-demo/ngoi-sao-nho-v2.json --evidence-kind manual
```

Ví dụ này có cùng reference/prediction nên coverage/onset hit-rate bằng1,
median/p95 bằng0, 126 tiếng. Nó chỉ smoke test evaluator và media fingerprint;
không gọi AI và không chứng minh model căn piano hoặc hát chính xác.

Khi có kết quả engine thật, thay reference/prediction/audio bằng case tương ứng,
dùng `--evidence-kind engine --engine-id <pinned-pipeline-label>`. Label do người
chạy cung cấp; `provenance_verified=false` nhắc rằng script không xác minh model
thực sự đã chạy. Kiểm tra run manifest/artifacts để xác nhận evidence. Exit0 là
đo thành công, không có nghĩa chất lượng đạt; invalid input trả JSON an toàn và exit2.

```powershell
# workdir backend; tests chỉ dùng fixtures/files local
.\.venv\Scripts\python.exe -B -m unittest test_karaoke_alignment_benchmark test_karaoke_syllables.SyllableContractTests test_karaoke_demo -v
```

```powershell
# workdir frontend; tests importer/lyrics v2 hiện có
.\node_modules\.bin\vitest.cmd run test/karaoke-lyrics.test.ts test/karaoke-syllables.test.tsx --maxWorkers=2
```

## Công cụ thu reference độc lập (bổ sung 19/11)

`scripts/prepare_karaoke_reference_review.py` nhận frozen manifest gồm corpus_id,
tracks (id/title/duration_ms/assets MP3 có file+sha256/lyrics_file+lyrics_sha256/
attribution/source.url/license/license_url). File audio/lyrics phải nằm trong
corpus; input phải v2 với toàn bộ timing null để không hiển thị prediction.
Không đọc env, gọi API/DB hoặc tự xác nhận người dùng đã nghe.

```powershell
.\backend\.venv\Scripts\python.exe -B scripts/prepare_karaoke_reference_review.py --manifest <corpus>/benchmark-manifest-frozen.json --output <corpus>/reference-review.html
```

Output mới phải ngay trong corpus, không ghi đè file có sẵn. Mở HTML bằng trình
duyệt; nghe bản gốc, đặt đầu/cuối hoặc nhập ms. Chuyển lượt 2 không sao chép mốc
lượt 1. Ghi người đánh dấu, tiếng khó nghe và notes; tải JSON trước khi đóng vì
chưa tự lưu. Khôi phục chỉ nhận đúng manifest/audio/lyrics/IDs và không loại
tiếng thiếu mốc. Export giữ hai lượt và độ chênh, luôn chưa duyệt và chưa tạo
reference cuối: cần con người kiểm đủ mốc, thống nhất sai khác và lập v2 chuẩn
trước khi chạy evaluator. Checkbox là lời tự xác nhận, không phải bằng chứng
độc lập đã được công cụ xác minh. Đây là bước benchmark, không phải yêu cầu
admin căn tay mọi bài khi tính năng tự động hoàn tất.

Corpus/probe ELLA mới và những giới hạn chưa giải quyết được ghi ở
[ELLA-CALIBRATION-20261119.md](ELLA-CALIBRATION-20261119.md).

## Điều kiện khóa engine (giữ nguyên)

Có đủ held-out/mẫu khó/negative và annotation kiểm lại; nhóm thuận lợi đạt mục
tiêu onset, missing được tính đúng; tỷ lệ sửa tay và chất lượng stems chấp nhận
được; nguồn/model có quyền phù hợp; latency/tài nguyên/chi phí biết đủ để vận
hành. Chốt threshold READY/NEEDS_REVIEW bằng dữ liệu đã hiệu chuẩn, giữ bước admin
nghe duyệt. Nếu chưa đạt thì tiếp tục Phase 1 hoặc quyết định giới hạn phạm vi
tường minh, không tuyên bố hoàn tất auto-align.
