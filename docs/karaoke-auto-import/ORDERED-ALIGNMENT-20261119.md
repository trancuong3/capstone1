# Đối chiếu câu lặp và chạy worker nguyên bài — 19/11/2026

## Bổ sung kiểm thử review và cách ly pipeline version

Đã tái hiện và sửa hai lỗi vận hành, không thay model, ngưỡng hoặc dữ liệu nhạc:

- Khi đang nghe reference, nút kiểm tra câu có cảnh báo trước đây mở editor bị
  disabled. Nay thao tác dừng audio, chuyển về backing rồi focus đúng tiếng cần
  sửa; không tự review hoặc publish. Unit wizard/syllables36/36 và hai ca browser
  desktop/mobile mới đều đạt. Browser dùng fixtures, không phải nghe duyệt nhạc.
- Worker trước đây claim và recover cả job khác pipeline version rồi mới từ
  chối trong process. Hai ca PostgreSQL tái hiện lỗi trước sửa; claim/recovery
  nay lọc đúng version. Worker tương thích vẫn nhận/khôi phục được cùng job;
  worker khác version không thay status, attempts hoặc lease token.

Nhóm SQL/worker/shutdown19/19 đạt103,842s; full backend1.068 tests, OK,
38 skipped,307,699s. Không cộng các lượt kiểm thử chồng lặp thành tổng mới.
Artifacts private: `pipeline-version-before-20261119.log`,
`pipeline-version-after-20261119.log`, `backend-review-pipeline-final-20261119.log`
trong `.cache/karaoke-benchmark/`. DB loopback tạm đã dừng sau full backend.

Readiness chỉ đọc trên Supabase đích xác nhận hai bảng processing và các cột
creation/reference/review chưa có. Feature và worker vẫn tắt, cấu hình engine
chưa sẵn sàng. Không apply migration, sửa env thật hoặc ghi dữ liệu dùng chung.
Sau fetch, origin/main là `90f7725f37d0a48a63607fd834043a8add299ebf`; nhánh task
vẫn dựa trên `d4402915126ffcb5f26eca710d4d381e2841de31`, chưa merge/rebase main.
Các lượt kiểm thử ở đây không chứng minh tương thích với main mới hoặc CI.

Nguồn Commons đã được thử tải lại một lần sau khoảng chờ, vẫn HTTP429 và không
ghi media; dừng tại đó, không đổi host hoặc vượt giới hạn. Chưa bổ sung được bộ
5–10 bài có quyền rõ và reference độc lập. Kết quả86/160 cặp ở mục dưới vẫn là
candidate nghiên cứu chưa duyệt; không phải độ chính xác hoặc quality gate đạt.

## Bổ sung boundary v3 — cửa sổ điểm kết thúc

Đo mới nhất: model CTC giữ nguyên weights, boundaryv3 đã tạo86 cặp mốc đủ và128
onset trên160 tiếng của cùng giả thuyết bài Cháu đi mẫu giáo. Mốc45 cặp trước đó
không bị thay đổi;41 mốc cuối mới dựa trên valley đo được. Dữ liệu này chưa có
reference người nghe và còn74 tiếng thiếu ít nhất một mốc, nên chưa đạt nghiệm thu.

Lỗi cũ: bộ tìm valley đòi80ms ngữ cảnh bên phải nhưng chặn cả cửa sổ trước onset
tiếng kế tiếp. Vì vậy valley nằm sát trước onset bị bỏ qua dù có đủ âm thanh
hai phía. Bản sửa chỉ tìm bổ sung ở vùng cuối đó sau khi các bằng chứng cũ chưa
xác định được end. Valley phải nhỏ hơn onset tiếp theo, có cả hai cửa sổ80ms,
sâu theo hệ số0,67 và là minimum cục bộ; giữ giới hạn ngân15s và điều kiện âm lượng.
Không đổi quiet threshold hoặc delimiter/word support, không copy onset kế tiếp.

Bộ pure AI32/32 đạt, thêm6 ca về valley gần onset, giữ delimiter cũ, dip quá nhẹ,
valley đúng tại onset, thiếu ngữ cảnh và tiếng cuối. Nhóm backend mapper/word
metric/client/review36/36 đạt. Worker/SQL/cache/shutdown17/17 đạt trong145,027s,
bao gồm không dùng cache boundaryv2 trong modelv3 dù fingerprint giả lập trùng;
stem còn đúng identity vẫn reuse. DB loopback tạm đã dừng sau kiểm thử.

Phép thử model thật không chạy lại Demucs: đọc vocal MP3 đã kiểm hash,
chạy adapter subprocess→CTC→envelopev3→mapper, giữ cùng input lyrics/IDs. Output:
86 complete,128 onset,47 energy_valley,26 ctc_delimiter,13 silence_boundary,
74 unsupported, agreement0,4625;208,937s. Timeout riêng420s/bước của probe,
không đổi default180s trong ứng dụng. Không có peak RAM hoặc throughput chuẩn
vì chạy SQL suite đồng thời, không sử dụng thời gian này làm cam kết vận hành.

Hai negative chỉ thử alignment stage, không tách stems lại: silence3.527ms và
clip piano15.047ms đều không tạo candidate, trả LYRICS_NOT_MATCHED trong41,905s/
58,276s. Không gọi đây là full-pipeline negative NO_USABLE_VOCALS; các phép đo
full-pipeline cũ vẫn là bằng chứng riêng theo đúng phiên bản khi chạy.

Artifacts private: `.cache/karaoke-benchmark/valley-v3-alignment-20261119/report.json`,
các `evidence-private.json`/`candidate-private-unapproved.json` và
`.cache/karaoke-benchmark/backend-valley-v3-pipeline-20261119.log`.
Trang nghe mới `.cache/karaoke-benchmark/listen-candidate-v3-20261119.html` dùng
bản gốc cùng timeline để nghe kiểm vị trí lời. Browser đã kiểm1 audio/160 tiếng,
42 partial/32 unknown, seek11,3s, mobile390px không tràn,0 page errors/HTTP requests.
Nó không lưu attestation hoặc xuất bản; phiên bản45/160 ở các mục dưới là lịch sử.

## Kết quả và giới hạn

Worker thật đã tạo candidate từ một bài nguyên file, apply vào nháp trên DB tạm
và giữ cổng review/publish. Bản nháp còn115/160 tiếng thiếu ít nhất một mốc,
nên chưa thuận tiện như mục tiêu một lần bấm cho bài thuận lợi và chưa thể
nghiệm thu chất lượng. Đây là kết quả nghiên cứu với lời đã chỉnh chưa được
người nghe xác minh, không phải bài đã duyệt hoặc nội dung được phép xuất bản.

## Lỗi và bản sửa

`SequenceMatcher` ưu tiên matching block dài, không tính minimum edit distance.
Khi các câu lặp gần giống nhau nhưng decode sai vài từ, nó có thể ghép một
block ở điệp khúc sau rồi bỏ qua các từ đúng trước đó. Fixture16 từ,5 từ thay
thế được metric cũ cho0,25 thay vì ordered agreement0,6875. Trên giả thuyết lời
nguyên bài, metric cũ0,2911 còn ordered word edits0,4625.

`karaoke_transcript_agreement.py` dùng exact word Levenshtein với bit vectors,
tránh ma trận O(n*m) ở giới hạn10.000 tiếng. Nó tính đủ insertion/deletion/
substitution, giữ thứ tự, tính thiếu lượt lặp vào mẫu số. Test đối chiếu thuật
toán ma trận độc lập trên961 cặp chuỗi nhỏ, các biên63/64/65/127/256 và10.000
tiếng. Không thay lời admin bằng decode hoặc tự mở rộng lượt hát.

Mapping/cache/provenance đổi thành `ordered-word-edits-v3`; ngưỡng0,35/0,8 vẫn
thử nghiệm, chưa hiệu chuẩn theo metric mới. Giữ onset có support>=0,55 khi end
chưa rõ; unknown end giữ null, không tính complete coverage hoặc cho publish.

## Bằng chứng worker và hồi quy

Nguồn MP3 SHA256:
`6377fcea903cb270fa2f2321b704b68076970217df25bfe888ed80d62dfc74f5`.
Checkpoint CTC/Demucs và weights giữ nguyên; stem recipe `active-anchors-v2`,
boundary `ctc-delimiter-envelope-v2`. Lời giả thuyết160 tiếng là input tường minh
của phép thử, chưa xác nhận đúng bản thu. Không sinh từ transcript nhận dạng.

- Worker riêng + model thật + PostgreSQL disposable + Storage trong RAM:
  NEEDS_REVIEW,2 operation COMPLETED,107 onset,45 cặp đủ,20 flags; giữ IDs/text.
- Apply nháp đạt, review_required=true, reviewed=false; publish422, không có
  published version. Không gọi API/Storage Supabase hoặc tạo phiên đăng nhập thật.
- Pipeline473,877s; test479,724s. Timeout riêng600s/bước trong phép thử; mặc định
  cấu hình ứng dụng180s không đổi. Có chạy probe CPU khác đồng thời nên không
  dùng con số này làm benchmark throughput. Peak RAM/VRAM và chi phí: chưa đo.
- Full backend1.064 tests, OK,38 skipped,308,355s; gồm các integration SQL thật
  theo harness loopback55447. Sau đó thêm2 regression mapper; nhóm22/22 đạt.
  Những lượt có overlap không cộng thành tổng tests độc lập.
- DB tạm đã dừng. Không commit/push hoặc sửa các dependency backend/OCR.

Artifacts private trong workspace nghiên cứu, ngoài repo ứng dụng:

- `.cache/karaoke-benchmark/backend-ordered-edits-20261119.log`.
- `.cache/karaoke-benchmark/full-song-worker-ordered-20261119/acceptance-boundary.json`.
- `.cache/karaoke-benchmark/full-song-worker-ordered-20261119/candidate-private-unapproved.json`.
- `.cache/karaoke-benchmark/full-song-worker-ordered-20261119.log`.

## Các phương án đã thử

Cùng clip vocal28s và input40 tiếng, đổi cao độ bằng Rubber Band với duration
giữ448.000 samples: CTC agreement gốc0,3958, hạ4 bán âm0,2222, hạ7 bán âm0,2273.
Đây là so khớp lời, không phải độ chính xác timing. Không dùng pitch transform
trong ứng dụng hoặc kết luận cao độ là nguyên nhân duy nhất.

stable-ts2.19.1 + openai-whisper20250625 + model small hash
`9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794`
được cài/tải vào cache riêng, không đổi AI env đã pin. Nó trả40/40 span có
duration>0, text identity khớp; decode độc lập agreement0,1136. Alignment23,987s,
transcription40,783s; không có reference người nghe nên không suy span đủ là
timestamp đúng. Lượt đầu hỏng serialize numpy.int64 sau inference; lượt chạy
lại đã lưu JSON hợp lệ. Chưa tích hợp adapter hoặc thay model của ứng dụng.

Nguồn chính thức:

- [Mã suy luận lyric-alignment](https://github.com/nguyenvulebinh/lyric-alignment/blob/master/predict.py)
  và [kiến trúc head](https://github.com/nguyenvulebinh/lyric-alignment/blob/master/model_handling.py).
  Đã đối chiếu head hiện có; không áp dụng heuristic copy next onset hoặc shift
  toàn bộ mốc120ms từ bản upstream.
- [stable-ts alignment](https://github.com/jianfch/stable-ts#alignment): hỗ trợ
  căn text cho sẵn, nhưng repo đã archive; phải xét chất lượng và bảo trì trước chọn.
- [Qwen model card](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B): ASR có
  tiếng Việt, danh sách ForcedAligner11 ngôn ngữ không có tiếng Việt. Không tải
  thêm model này chỉ dựa trên mô tả ASR.

## Việc còn lại để hoàn thành đặc tả

Trang nghe private đã chuẩn bị tại workspace nghiên cứu:
`.cache/karaoke-benchmark/listen-candidate-20261119.html`. Nó dùng prediction thật
từ worker và bản gốc cùng timeline, không đóng vai bản published.107 onset gồm
45 cặp đủ và62 end chưa rõ;53 tiếng không có onset. Bấm tiếng có onset để seek,
gạch chân mốc cuối chưa rõ, không đoán end. Có tải ghi chú local, không tự attestation.
Browser đã kiểm:1 audio,160 tiếng, duration121,278s, seek11,82s hoạt động,
mobile390px không tràn ngang,0 page errors/0 HTTP requests. Đã xem ảnh mobile.

Rà soát snapshot cuối100 file pending: không media/weights/env thật hoặc migration
version trùng;3 pattern match là URL/token fixtures tại các test đã đọc lại.
Không đổi requirements backend, package frontend/lockfile hoặc AppShell/API client
chung. Artifact audit:
`.cache/karaoke-benchmark/source-audit-ordered-20261119.json`.
Quét regex chỉ là kiểm tra phạm vi/file hiện tại, không chứng minh lịch sử Git
hoặc mọi dạng secret đều sạch.100 là snapshot trước cập nhật đoạn ghi nhận này.

Cần chứng minh timing tốt hơn trên bài thuận lợi, bộ5–10 bài đủ quyền và lời
đúng bản thu, reference/annotation độc lập, nghe duyệt stems, rồi live acceptance
và rollout. Các phép thử ở đây giải quyết lỗi runtime và chứng minh đường đi
worker; chúng không thay thế các cổng đó hoặc xác nhận mọi phase hoàn thành.
