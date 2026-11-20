# Bộ bài ELLA và phép thử calibration ngày 19/11/2026

## Kết luận hiện tại

Giữ nguyên yêu cầu đầy đủ theo xác nhận của chủ dự án. Đã tìm và tải được tám
bài tiếng Việt từ nguồn giáo dục ELLA, có MP3 và PDF lời chính thức. Đây là tám
**ứng viên dữ liệu**, chưa phải tám case benchmark được nghiệm thu: chưa có
người nghe xác minh lời khớp audio, reference độc lập hoặc kiểm lại mốc khó.
Không thay yêu cầu đó bằng số timestamp model trả ra.

Chạy thật trên ba bài calibration: CTC tạo candidate ở một bài, từ chối hai
bài; model Whisper fine-tune lời hát không cải thiện ổn định. Probe PhoWhisper
INT8 mới giúp tạo ba candidate trong phép ghép chẩn đoán, nhưng còn thiếu20/84
cặp mốc và chưa có reference. Đây không phải provider đã tích hợp/được nghiệm thu.
Chưa thay engine,
hạ ngưỡng, chạy held-out, bật feature, áp dụng migration hay xuất bản bài.

## Nguồn, quyền dùng và split đóng băng

Nguồn: [ELLA Vietnamese toolkit](https://www.ella.edu.au/app-toolkit/vietnamese/),
các trang `app-1/` đến `app-8/` cung cấp MP3 và PDF lời. Theo
[điều khoản ELLA](https://www.ella.edu.au/terms-of-use/), nội dung được áp dụng
giấy phép CC BY-NC 4.0 có thể dùng/chỉnh sửa phi thương mại với ghi nguồn và
thay đổi; loại trừ logo, nhân vật, nhãn hiệu và nội dung có ghi ngoại lệ.
Đã kiểm trực quan footer của cả tám PDF: © 2026 Commonwealth of Australia,
CC BY-NC 4.0 với ngoại lệ logo/nhân vật. Không tìm thấy ngoại lệ riêng cho bài
trong các nguồn đã kiểm. Không sử dụng artwork/logo hoặc ngụ ý ELLA bảo trợ.
Chủ dự án đã xác nhận đồ án/demo phi thương mại, không suy rộng sang thương mại.

MP3 gốc giữ nguyên; việc trích cột tiếng Việt, chuẩn hóa NFC/khoảng trắng, thêm
ID và tạo stems nghiên cứu là các thay đổi được ghi lại. App 1 bỏ chỉ dẫn
không hát `Space for child to respond` khỏi text, không cắt khoảng nghỉ audio.
App 6 có nhãn link website ghi nhầm App 5; nội dung PDF ghi App 6 / Actions.

| App | Bài                       | MP3 gốc (ms) | Split trước inference |
| --- | ------------------------- | -----------: | --------------------- |
| 1   | Hello                     |        40941 | held-out              |
| 2   | Colours                   |        25351 | calibration           |
| 3   | Numbers                   |        22222 | held-out              |
| 4   | Fruits                    |        33477 | held-out              |
| 5   | Head, arms, legs and feet |        27000 | calibration           |
| 6   | Actions                   |        25455 | calibration           |
| 7   | Goodbye                   |        45000 | held-out              |
| 8   | Let's go to school        |        40000 | held-out              |

Tổng 284 tiếng, calibration 84 và held-out 200; tổng audio 259446ms. Chọn đủ
tám bài đầu của bộ toolkit trước inference, không loại bài vì score thấp.
Nhóm thuận lợi/khó mới là phân loại theo text, chưa được người nghe xác minh.
Bộ bài ngắn cùng một bộ sưu tập chưa chứng minh bao phủ đầy đủ bè/nhạc lớn/ngân
dài hoặc mọi bài hát thực tế. App 1 và 7 có tên riêng nước ngoài.

Artifact local trong workspace nghiên cứu:
`.cache/karaoke-benchmark/ella-vietnamese-20261119/`.
Manifest `benchmark-manifest-frozen.json` chứa từng URL, hash MP3/PDF/HTML,
hash input lyrics, attribution và policy. SHA256:
`eff102b5a23091fba5c784909b93317e7378528f998ec70560c9259a076126fa`.
Lời được đối chiếu với cột tiếng Việt của PDF, **chưa xác nhận bằng nghe**.
Không đưa nhạc, checkpoint, env hay dữ liệu nghiên cứu riêng vào source Git.

## CTC + Demucs hiện tại: kết quả thật, không phải accuracy

Pin engine/model/mapper không đổi: `ctc-delimiter-envelope-v3`,
`ordered-word-edits-v3`, `demucs-4.0.1:955717e8:active-anchors-v2`.
Chạy CPU, hai Torch threads, isolated Python; dùng actual LocalKaraokeClient,
tách stems, kiểm timeline MP3 và mapper. Không chạy worker/DB/Supabase trong
phép đo này. Mỗi subprocess nạp model riêng; thời gian bao gồm phần đó.

| App | Kết quả mapper         | Onset / cặp mốc / tổng        | Tách stems (s) | Align + mapper (s) | Toàn pipeline local (s) |
| --- | ---------------------- | ----------------------------- | -------------: | -----------------: | ----------------------: |
| 2   | Candidate NEEDS_REVIEW | 30 / 29 / 30                  |         96.898 |             81.503 |                 178.435 |
| 5   | LYRICS_NOT_MATCHED     | không có candidate / 41 tiếng |         70.596 |             85.842 |                 156.458 |
| 6   | LYRICS_NOT_MATCHED     | không có candidate / 13 tiếng |         73.430 |             80.159 |                 153.605 |

App 2 transcript agreement 0.8333; giữ IDs/text, ba dòng có quality flags.
29/30 là mức đầy đủ của cặp mốc, **không phải 96.7% chính xác**. Hai case bị
từ chối vẫn thuộc corpus và mẫu số khi đánh giá, không bị loại khỏi báo cáo.

Negative chạy riêng ở aligner + mapper, chưa phải kiểm toàn bộ mode VOCAL_TRACK:
instrumental của App 2 với lời App 2 (70.316s), vocal App 2 với lời App 6
(89.296s), đều trả LYRICS_NOT_MATCHED, không có candidate. Điều này không chứng
minh đúng error NO_USABLE_VOCALS ở mọi đường đi end-to-end.

Report `calibration-ctc-v3/report.json`, SHA256:
`8bc5c5862e67088ded6979786a73034e05430d421a7b5e18a18772f0663d7de5`.
Peak RAM/CPU chưa đo cho lượt CTC này; chi phí máy/hosting unknown. Không gọi
API inference trả phí. Không ghi chi phí bằng 0 hoặc dùng thời gian này làm SLA.

## So sánh Whisper fine-tune lời hát tiếng Việt

Nguồn model:
[kelvinbksoh/whisper-small-vietnamese-lyrics-transcription](https://huggingface.co/kelvinbksoh/whisper-small-vietnamese-lyrics-transcription).
Revision `a8dd6a34bc2fe69b1f3658919c4750297cf2b0f5`, license Apache-2.0 theo model
card đã kiểm, safetensors SHA256
`2c6a4fcad50ff747263ce32bc94212ec3483b467ec49d1a6c213f47e06c7f93e`.
Dùng stable-ts 2.19.1 local, strict conversion, kiểm output head bằng embeddings;
không remote code, không download trong job, không cài vào backend/OCR venv.

Chạy trên bản phối gốc của ba bài calibration; không suy đây là so sánh công
bằng chỉ kiến trúc với CTC dùng vocal. Không bật chia đều timing hay silence
adjustment. Decode độc lập chỉ kiểm text agreement, không làm ground truth.

| App | Span có thời lượng / số tiếng | Text agreement | Align (s) | Decode (s) |
| --- | ----------------------------- | -------------: | --------: | ---------: |
| 2   | 30 / 30                       |         0.7667 |    19.348 |     14.210 |
| 5   | 41 / 41                       |         0.2439 |     8.528 |     11.948 |
| 6   | 12 / 13                       |         0.0000 |     7.998 |     26.164 |

Giữ text/IDs của yêu cầu không có nghĩa là timestamp đúng. App 6 có kết quả
ASR gợi ý vocalization ngoài text nguồn; đây là **giả thuyết cần nghe kiểm tra**,
không tự thêm/sửa lyrics dựa trên ASR. App 5 nhận dạng kém ở cả hai engine.

Nạp model một lần 15.915s; peak working set Python 1454882816 bytes (khoảng
1.355GiB), CPU process tích lũy 194.719s. Đo Win32 process peak, không bao gồm
FFmpeg child; không phải peak toàn hệ thống. Chi phí tiền unknown.
Report `calibration-vietlyrics-original/report.json`, SHA256:
`491dfe44b20cda9760346dd6edd9e90383da62a4ffbf5063e1e00eacd85b857f`.
Không tích hợp adapter này vào runtime vì chưa có bằng chứng cải thiện chất
lượng hoặc reference độc lập. Năm bài held-out vẫn chưa đưa vào model.

## Probe nhận dạng PhoWhisper INT8 — không thay runtime

Sau khi chủ dự án tiếp tục yêu cầu giữ toàn bộ đặc tả, thử nhận dạng độc lập
để phân biệt lỗi transcript với thiếu mốc CTC. Nguồn gốc:
[VinAI PhoWhisper](https://github.com/VinAIResearch/PhoWhisper), bản chuyển ONNX
[pdnhan/PhoWhisper-small-mobile](https://huggingface.co/pdnhan/PhoWhisper-small-mobile)
revision `9b0cc3c44a701d6107b5ad0052e5546626e41bad`. Đây là conversion bên thứ ba,
không phải bản được VinAI xác nhận. Publisher ghi BSD-3-Clause; đã kiểm hash
artifacts, chưa tự chứng minh tương đương trọng số gốc hoặc WER mà publisher nêu.
Chỉ tải ONNX/JSON/tokenizer/README, không chạy script từ model.

Encoder INT8 SHA256:
`59994c14fb3e9523e1b518ffd2d9eb2152c8c6c8743bf22d8bd8adcb5870ae2f`.
Decoder INT8 SHA256:
`c524f278845ec1fdc157f5c0fc6b05a541f90ca11d9f6362c2e63dc78168e09c`.
13 file,298505681 bytes, lưu ngoài source trong cache nghiên cứu. ONNX Runtime
1.31.1 cài target riêng; không đổi venv backend/OCR/AI. Inference CPU hai threads,
không nạp Torch, không GPU, tối đa224 tokens và120s/case. Feature extractor
transformers4.57.6 chỉ dùng NumPy, giữ nguyên audio16k mono với padding; ba bài
đều dưới30s nên không cắt nhạc. Decoder greedy độc lập, prompt chỉ có ngôn ngữ
và task, không chứa lời bài hát. Không VAD, beam search hoặc cơ chế chống hallucination.

Thử hai policy đầu vào cho đủ cả ba bài calibration, không chọn policy theo
bài. Text agreement dùng metric có thứ tự hiện tại; không phải độ chính xác
thời gian hoặc reference của người nghe.

| App | Agreement nhạc gốc | Agreement vocal | Decode gốc (s) | Decode vocal (s) |
| --- | -----------------: | --------------: | -------------: | ---------------: |
| 2   |             1.0000 |          0.7000 |          7.038 |            7.184 |
| 5   |             0.2927 |          0.4634 |          7.077 |            7.077 |
| 6   |             0.3846 |          0.6154 |          5.192 |            5.602 |

Tất cả kết thúc EOS. Instrumental App2 sinh46 tiếng (8.283s), silence5s sinh12
tiếng (4.811s); cả hai agreement0 với lời App2. **Đây là hallucination ASR**, không
phải bằng chứng có vocal. Chưa chạy hai negative qua một provider kết hợp hoặc
toàn worker; không ghi chúng là test NO_USABLE_VOCALS end-to-end đã đạt.

Peak working set Python614277120 bytes (~586MiB), CPU process tích lũy113.875s;
không bao gồm FFmpeg child. Chi phí máy/hosting unknown, không gọi API inference
trả phí. ASR không sinh timestamp trong phép thử này.

Phép ghép offline giữ nguyên toàn bộ mốc/support từ CTC, thay riêng transcript
bằng kết quả PhoWhisper đã đo rồi chạy mapper thật, không hạ ngưỡng0.35 hoặc0.55.
Lưu provenance cả hai evidence riêng; đây là chẩn đoán, không giả model CTC đã
tự nhận đúng lời. Policy dùng vocal cho cả ba bài:

| App | Candidate chưa duyệt | Onset / cặp mốc / tổng | Dòng cảnh báo |
| --- | -------------------- | ---------------------- | ------------: |
| 2   | Có                   | 30 / 29 / 30           |            10 |
| 5   | Có                   | 36 / 26 / 41           |             8 |
| 6   | Có                   | 9 / 9 / 13             |             9 |

Tổng75/84 onset,64/84 cặp mốc;9 thiếu onset,20 thiếu cặp mốc. Giữ nguyên text/IDs,
không thêm thời gian giả. Policy nhạc gốc chỉ tạo candidate App2/App6; App5 vẫn
LYRICS_NOT_MATCHED. Candidate nhiều hơn chưa chứng minh timing đúng; transcript
App5/App6 vẫn khớp thấp, không thay lời theo ASR. Không coi target90% đã đạt.

Artifacts trong corpus: `calibration-phowhisper-onnx/`.
`report.json` SHA256:
`83c5a46ff885a19f3c2a37ff86b34240a9df4605881211c0fc522e1323bbab4b`.
`mapper-diagnostic/report.json` SHA256:
`e88a35565569b32f6970c3c2727f501df8cd44148981336ee6dd1efa6a434247`.
Các script nghiên cứu local: `prepare_phowhisper_probe.py`,
`run_ella_phowhisper_calibration.py`, `evaluate_ella_phowhisper_mapping.py` trong
`.cache/karaoke-benchmark/`; không phải dependency hoặc command runtime.

Quyết định: giữ kết quả như hướng nghiên cứu có tín hiệu cải thiện transcript,
**chưa thêm adapter hoặc đổi feature config**. Muốn chọn engine kết hợp phải
có reference độc lập, kiểm âm thanh không vocal/wrong lyrics đủ đường pipeline,
đo mốc đầu/cuối/missing và nghe stems. Năm bài held-out vẫn chưa chạy inference.

## Công cụ nghe độc lập và kiểm chứng mới

Thêm source thật vào repo, không chỉ ghi handoff:

- `scripts/prepare_karaoke_reference_review.py`: kiểm hash/audio/input null
  timing, từ chối path ngoài corpus, sinh HTML local mới, không gọi mạng/DB.
- `scripts/karaoke_reference_review.html`: một audio gốc, tốc độ chậm, chọn
  tiếng/đặt đầu-cuối, hai lượt lưu riêng không tự chép, ghi khó nghe/notes.
  Export/restore giữ toàn bộ tiếng, IDs/hash và sai khác giữa hai lượt. Bản xuất
  luôn chưa duyệt, reference_lyrics null; không tự biến bản gán mốc thành chuẩn.
- `backend/test_karaoke_reference_review.py`: bảy test bảo vệ identity, input
  không chứa prediction, hash drift, path escape, dung lượng và HTML escaping.

18/18 tests của reference tool + evaluator đạt (7 mới + 11 hiện có, không cộng
với các lượt full suite lịch sử). Browser Chromium headless: 8 bài, một audio,
lượt 2 trống độc lập, export/restore đúng hash, reject bản lưu khác corpus, mobile
390px không tràn, 0 page errors và 0 request mạng. Tương tác browser dùng fixture
ghi rõ AUTOMATED UI FIXTURE, **không tạo reference của người nghe**. Đã xem ảnh
mobile; source HTML qua Prettier. Không đổi runtime FE/BE sau full-suite trước.

Trang local đã sinh: `reference-review-ready.html` trong corpus. Chỉ là công
cụ chuẩn bị benchmark một lần, không đổi sản phẩm thành luồng admin phải căn
tay mọi bài. Xem cách chạy tại [BENCHMARK.md](BENCHMARK.md).

## Điều kiện còn lại

Xác minh lời theo audio và độ đại diện của corpus; gán reference độc lập, kiểm
hai lượt mốc khó/sai khác; đo onset/end error/missing/correction time và
nghe stems. Sau calibration đạt mới khóa engine, chạy held-out với reference
đã chốt, rồi thực hiện live acceptance/rollout được phép. Mục tiêu onset vẫn
≥90% trong 250ms; hiện chưa có số accuracy hợp lệ.
Không công bố Phase 5/6 xong.
