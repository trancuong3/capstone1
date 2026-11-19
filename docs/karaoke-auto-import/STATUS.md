# Trạng thái triển khai karaoke-auto-import

## Quyết định mới nhất — bàn giao source, không rollout (2026-11-19)

Chủ dự án yêu cầu bỏ qua bước benchmark/reference/nghe duyệt đang chờ và làm
phần tiếp theo; sau đó cho phép commit, push nhánh hiện tại và tạo PR nháp.
Quyết định này thay thế yêu cầu chờ đủ benchmark trước bàn giao source ở các
mốc lịch sử bên dưới. Không đổi kết quả chất lượng thành đạt: vẫn NOT_VERIFIED.
Không tự merge, bật flags, áp dụng migration Supabase hoặc xuất bản bài hát.
Các chốt nghe duyệt/cảnh báo/revision trước khi xuất bản từng bài vẫn giữ nguyên.

Hướng dẫn bàn giao và điều kiện triển khai/rollback:
[RELEASE.md](RELEASE.md). Các kết quả kiểm thử bên dưới là bằng chứng local,
không phải kết quả CI hoặc nghiệm thu môi trường thật.

## Tóm tắt hiện tại — chưa đủ điều kiện hoàn tất toàn bộ đặc tả

Code đã được triển khai trong repo ứng dụng trên nhánh
`feature/linh-karaoke-auto-import`, không chỉ nằm trong handoff. Phần DB/API,
worker và wizard đã có kiểm thử; mục tiêu tự động căn lời cho bài thật vẫn chưa
được chứng minh. Mới tìm được 8 bài ELLA có MP3/PDF lời và cơ sở quyền dùng
phi thương mại; đã chốt split trước inference. Ba bài calibration: 1 candidate
(29/30 cặp mốc), 2 bị từ chối. Chưa có reference độc lập hoặc nghe duyệt; không
coi số mốc là độ chính xác. Chi tiết và công cụ nghe độc lập đã thêm trong repo:
[ELLA-CALIBRATION-20261119.md](ELLA-CALIBRATION-20261119.md).

Probe tiếp theo PhoWhisper ONNX INT8: nhận dạng độc lập rồi ghép offline với mốc
CTC giữ nguyên, policy vocal tạo candidate3/3 nhưng chỉ đủ64/84 cặp mốc. Đây
không phải accuracy hoặc runtime mới; ASR sinh chữ cả trên silence/instrumental.
Chưa tích hợp adapter, sửa ngưỡng, dùng held-out hoặc thay điều kiện nghiệm thu.
Chi tiết model/hash, số liệu và giới hạn nằm trong báo cáo ELLA ở trên.

| Phase | Trạng thái và phần còn thiếu                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Có 8 ứng viên ELLA có nguồn/quyền phi thương mại; chưa xác minh lời theo audio và reference độc lập.                            |
| 2     | DB/API nền đã có code và kiểm thử PostgreSQL tạm; migration chưa áp dụng Supabase đích.                                         |
| 3     | Pipeline thật tạo được candidate nghiên cứu; chất lượng alignment và cấu hình vận hành bài thật chưa đạt.                       |
| 4     | Wizard/review đã nối vào ứng dụng, qua unit/browser fixtures; không thay cho live acceptance.                                   |
| 5     | Hồi quy kỹ thuật đã chạy; benchmark/nghe duyệt được chủ dự án cho bỏ qua để bàn giao, không đánh dấu đạt; chưa live acceptance. |
| 6     | Bàn giao source/PR nháp được cho phép; không tự merge, triển khai hay bật tính năng. Xem RELEASE.md.                            |

Bản sửa vận hành cuối: worker chỉ claim/recover job cùng pipeline version;
nút kiểm tra tiếng có cảnh báo chuyển từ reference về backing và focus ô sửa.
Đã tái hiện lỗi trước sửa. Nhóm SQL/worker/shutdown19/19, frontend liên quan36/36
và hai ca browser desktop/mobile mới đều đạt; full backend1.068 tests, OK,
38 skipped. Các lượt này có overlap và không cộng thành tổng độc lập.
Full frontend cuối:120 file,1.981/1.981 tests đạt; format/typecheck/build đạt,
lint0 errors/13 warnings ngoài phạm vi đã ghi nhận, static generation38/38.
Log/hash và thời gian chính xác ở
[VERIFICATION-20261119.md](VERIFICATION-20261119.md).

Readiness chỉ đọc trên Supabase đích cho thấy thiếu hai bảng processing và các
cột creation/reference/review; feature và worker vẫn tắt, cấu hình engine chưa
sẵn sàng. Không sửa env thật, ghi DB dùng chung hoặc xuất bản bài nghiên cứu.
Không suy ra quyền triển khai từ quyền kiểm tra hoặc yêu cầu hoàn tất đặc tả.

Sau fetch, `origin/main` là `90f7725f37d0a48a63607fd834043a8add299ebf`.
Nhánh task vẫn dựa trên `d4402915126ffcb5f26eca710d4d381e2841de31`; chưa merge/
rebase và chưa kiểm CI. Đã kiểm bản sao ghép với main ở commit trên: backend115
tests không lỗi (7 skipped), frontend192/192 tests liên quan và typecheck đạt.
Một xung đột warm-routes được giải quyết chỉ trong snapshot, không đổi repo
nguồn. Đây chưa phải full integration/build/E2E: xem
[MAIN-COMPATIBILITY-20261119.md](MAIN-COMPATIBILITY-20261119.md). Kết quả bên dưới
là các mốc local theo đúng baseline lúc chạy, không phải cùng một lượt kiểm thử.

Chi tiết hai bản sửa và giới hạn triển khai nằm đầu
[ORDERED-ALIGNMENT-20261119.md](ORDERED-ALIGNMENT-20261119.md).
Chủ dự án đã xác nhận19/11: **giữ yêu cầu đầy đủ trong đặc tả**, không đồng ý
đổi sang bản thử nghiệm có chỉnh tay. Vì vậy benchmark/nghe duyệt/quality target
vẫn là điều kiện bắt buộc; không coi prototype hoặc test kỹ thuật đạt là hoàn tất.

## Mốc hiện tại — boundary v3, 19/11

Đã sửa cửa sổ tìm energy valley bị cắt sớm80ms: điểm kết thúc vẫn trước onset
tiếp theo, nhưng được nhìn đủ ngữ cảnh bên phải. Chỉ bổ sung unknown ends,
không thay mốc đã đo. Boundary/provider/cache pin thành `ctc-delimiter-envelope-v3`.

Chạy model mới từ vocal MP3 nguyên bài:86/160 cặp đầu/cuối,128 onset,0 mốc kết
thúc cũ bị đổi, giữ IDs/text và NEEDS_REVIEW. Đây là dữ liệu chưa có reference
người nghe, không phải độ chính xác86/160 hoặc đã đạt target90%. Silence3,5s và
piano15s qua aligner+mapper đều bị từ chối LYRICS_NOT_MATCHED, không tạo candidate.
Không chạy lại Demucs trong lượt đo boundary này.

AI pure32/32, backend mapper/metric/client/review36/36 và worker/SQL/cache/shutdown
17/17 đạt. SQL kiểm cache boundaryv2 không được tái dùng, stems vẫn reusable.
DB tạm đã dừng. Frontend runtime không đổi, preview private v3 đã kiểm browser:
1 audio,160 tiếng,42 tiếng thiếu end,32 thiếu onset, mobile không tràn,0 lỗi.

Bản nghe mới trong workspace nghiên cứu:
`.cache/karaoke-benchmark/listen-candidate-v3-20261119.html`.
Chi tiết ở mục boundary v3 của [ORDERED-ALIGNMENT-20261119.md](ORDERED-ALIGNMENT-20261119.md).
Chưa commit/push, thay env thật, ghi Supabase hoặc publish; quality/annotation/
held-out/live acceptance còn thiếu. Các mốc bên dưới giữ nguyên theo lịch sử.

## Kết quả mới nhất — đối chiếu câu lặp và worker nguyên bài

Đã sửa lỗi đối chiếu transcript lặp: greedy matching có thể chọn nhầm một điệp
khúc rồi bỏ qua nhiều từ đúng ở các lượt trước. Metric hiện dùng khoảng cách
chỉnh sửa từ có thứ tự; mapping/cache version là `ordered-word-edits-v3`.
Các ngưỡng vẫn thử nghiệm, mọi kết quả vẫn NEEDS_REVIEW.

Bài Cháu đi mẫu giáo với lời đã sửa lỗi gõ và giả thuyết4 lượt đã chạy mới hoàn
toàn qua worker/Demucs/CTC thật và PostgreSQL tạm:107 onset,45 cặp đầu/cuối trên
160 tiếng, agreement0,4625. Job tạo staging NEEDS_REVIEW, apply vào nháp nguyên
tử, giữ yêu cầu review và chặn publish422 vì thiếu timing. Hai operation đều
COMPLETED. Thời gian pipeline473,877s; toàn test479,724s. Storage trong RAM,
không Supabase; lời chưa được người nghe xác minh, không phải benchmark đạt.

Full backend sau thay đổi runtime:1.064 tests, OK,38 skipped,308,355s. Sau đó
thêm2 ca hồi quy mapper câu lặp/thiếu lượt; nhóm mapper+metric22/22 đạt. Không
gọi1.066 là một lượt discovery đã chạy. Frontend không đổi sau lượt41unit và
10Playwright desktop/mobile đạt ở mốc trước.

Đã thử hạ cao độ clip28s: agreement0,3958 gốc,0,2222 ở-4 bán âm và0,2273 ở-7;
không đưa biến đổi này vào runtime. Thử stable-ts2.19.1/Whisper small20250625
riêng trả40 span nhưng decode độc lập agreement0,1136, kém hơn CTC trong phép
thử này; không dùng số span đủ làm bằng chứng timing đúng và chưa thêm adapter.
Qwen3 ForcedAligner không liệt kê tiếng Việt trong11 ngôn ngữ hỗ trợ chính thức,
nên không suy hỗ trợ alignment từ hỗ trợ ASR tiếng Việt của họ.

Bằng chứng/nguồn/giới hạn ở [ORDERED-ALIGNMENT-20261119.md](ORDERED-ALIGNMENT-20261119.md).
DB tạm đã dừng sau phép thử; không sửa env thật, publish hoặc ghi DB dùng chung.
Các cổng chất lượng5–10 bài, nghe/annotation độc lập, live acceptance và rollout
vẫn chưa đạt. Các mục bên dưới là lịch sử của những mốc trước.

## Mốc mới nhất — 19/11, giữ onset và hỗ trợ nhập câu lặp

Code thực tế nằm ở repo ứng dụng, không chỉ trong handoff:

- Mapper giữ onset có hỗ trợ >=0,55 khi end chưa rõ, kiểm biên/thứ tự; vẫn để
  end null và cảnh báo. Không nới transcript gate hoặc biến onset đơn lẻ thành
  coverage hoàn chỉnh. Cache alignment có `partial-onsets-v2` trong fingerprint.
- Wizard gợi ý mở rộng ký hiệu lặp cuối câu sau xác nhận, có hoàn tác chữ và
  giới hạn kích thước. Không tự nhân cả đoạn, đổi lời từ ASR hoặc gửi job.
- Kiểm thử liên quan: backend52/52, frontend41/41; frontend typecheck, lint scoped,
  format scoped và git diff --check đạt. Không cộng các lượt này vào full-suite cũ.
  Playwright wizard cuối:10/10 đạt trong3,6 phút trên desktop/mobile Chromium,
  gồm xác nhận/hoàn tác câu lặp không write, upload→apply→review→publish bằng
  fixtures, resume GET-only, retry upload và giữ metadata. Không phải live AI/DB.
- Đối chiếu cùng MP3 Cháu đi mẫu giáo: transcript agreement trên nhạc gốc0,1726,
  vocal tách0,2051. Chuyển sang nhạc gốc không cải thiện trong phép thử này.
  Giả thuyết sửa lỗi gõ nguồn và lặp4 lượt có160 tiếng,45 cặp mốc thô,
  agreement0,2911; mapper vẫn từ chối LYRICS_NOT_MATCHED. Những lời đã chỉnh chỉ
  là giả thuyết nghiên cứu riêng, không phải lời đã duyệt hoặc reference chuẩn.
- Các phép thử trên không xác nhận quyền xuất bản, độ chính xác timing hay chất
  lượng nghe. Không upload Supabase, không đổi env thật hoặc xuất bản bài.

Kết luận kỹ thuật: Phase2 và phần wizard Phase4 đã có code/test; engine Phase3
vẫn chưa đạt điều kiện bài thật, nên nghiệm thu chất lượng Phase5 và rollout
Phase6 chưa hoàn tất. Không chỉ còn thiếu thao tác nghe duyệt: cần cải thiện hoặc
thay aligner rồi chứng minh trên bài thật, không tiếp tục gọi prototype là đã đạt.

Các mục dưới đây là lịch sử kiểm thử, không phải tất cả cùng một lần chạy.

Cập nhật 2026-11-17 trên nhánh `feature/linh-karaoke-auto-import`,
baseline `d4402915126ffcb5f26eca710d4d381e2841de31`.

Phạm vi hiện tại là yêu cầu tiếp tục hoàn thành các phase, tự tìm nguồn nhạc.
PHASE1.md là báo cáo mốc ban đầu, **không phản ánh các thay đổi DB/API sau đó**.
Nguồn/giấy phép và kết quả engine mới nhất ở [SOURCES-AND-PREFLIGHT.md](SOURCES-AND-PREFLIGHT.md).

## Đã triển khai local

- Migration additive 2 bảng jobs/operations; reference/review/creation intent;
  RLS server-only, constraints snapshot/output/lineage; chưa chạy trên Supabase.
- DTO/config mặc định tắt, caps ngày bắt buộc khi bật.
- API capabilities, start/list/get/cancel/retry/preview/apply/review/reference-preview.
- Create replay 201/200; admission 202/200, khóa quota chung giữa các bài; snapshot
  đầy đủ; metadata chưa đủ vẫn có thể xử lý nhưng không publish.
- Apply đổi audio+lyrics+binding+origin+review-required+revision+APPLIED trong một
  transaction; replay không bump; stale được commit rồi trả409.
- Review bind fingerprint, explicit listened/ack, chặn timing thiếu; sửa tay xóa
  stamp nhưng giữ sticky review-required. No-op save giữ stamp/revision.
- Clone giữ origin/reference; public playback/visibility không bị review gate mới.
- Cleanup giữ mọi asset còn được version/job/operation tham chiếu.
- Download stream giới hạn bytes, signed origin được kiểm, chặn redirects/encoding.
- Repository claim/lease/fence/operation transitions/recovery, kiểm lại actor active.
- Worker riêng đã có --once, heartbeat, shutdown/cancel, fencing và checkpoint
  operation + job nguyên tử. Reuse chỉ sau kiểm hash/artifact/input/model/pipeline.
  UNKNOWN không tự hoàn quota; chỉ adapter offline có bằng chứng không gọi dịch vụ
  ngoài mới được safe-retry, nonlocal vẫn giữ cost acknowledgment.
- Pipeline local Demucs → vocal/instrumental → đối chiếu clock → CTC → lyrics v2
  → staging NEEDS_REVIEW. Không tự apply/publish.
- Model/weights/tokenizer được kiểm hash; môi trường riêng, không sửa backend venv.
  Hướng dẫn tại [README engine](../../ai/karaoke_processing/README.md).

## Bằng chứng đã kiểm

- 73 kiểm thử unit/API/schema/benchmark/migration liên quan đạt.
- Bộ tổng hợp 47 ca (gồm 29 PostgreSQL thực) đạt ở thời điểm chạy.
- 5/5 kiểm thử lease hai kết nối đạt riêng: SKIP LOCKED, token cũ, cancel, actor
  revoke, recovery ambiguous. Cũng có trong nhóm tổng hợp, không cộng hai lần.
- 3/3 kiểm thử pure envelope đạt, không cần checkpoint.
- 5 utterances vocal thật đã chạy model pin; thiếu 5/10 end, chưa đạt gate.
- Full backend suite: 1.018 ca chạy, OK, 37 skipped do điều kiện môi trường.
  Hai ca PostgreSQL bổ sung sau lần discovery đó đều đạt: phát hiện timing stale
  và rollback đồng bộ audio/lyrics/revision/job khi transaction commit lỗi.
  Không cộng chúng vào số 1.018 như thể cùng một lần chạy.
- Ở mốc backend này chưa có frontend hoặc live acceptance/rollout. Phần frontend
  bổ sung sau đó được ghi riêng bên dưới.

### Bổ sung pipeline/worker

- 17/17 ca mapping/config, 6/6 ca subprocess thật (fixture timeout/cancel/giới hạn),
  10/10 ca PostgreSQL worker/lease (5 ca pipeline mới + 5 ca lease cũ) đạt.
- 7/7 ca AI clock/envelope thuần đạt.
- Hai composite ngắn đã chạy Demucs/CTC thật. Clip “ba ba” lệch transcript; clip
  “la la” khớp transcript nhưng còn thiếu một end. Không tính là 2 bài benchmark.
- Một ca opt-in model thật + worker thật + PostgreSQL tạm + Storage trong bộ nhớ
  đạt (80,616s toàn test): staging → apply bản nháp v2; publish và review vẫn bị
  chặn vì timing thiếu. Không có Supabase live hoặc nghe duyệt của người dùng.
- Full backend regression sau bổ sung đã kết thúc trước khi pause: 1.042 tests,
  OK, 38 skipped, 243,023s. Đây là một lần discovery riêng, không cộng với mốc
  1.018 cũ. Không coi skipped là test đã chạy engine hoặc dịch vụ thật.

### Tiếp tục sau pause — mốc nền frontend Phase 4

- Có schemas Zod admin-only cho capabilities/job/quality/staging/reference;
  enums chưa biết bị reject. Schema summary/review tách module để tránh cycle
  runtime với lyrics. Fields admin mới optional khi đọc backend cũ, không suy
  feature support từ việc thiếu summary.
- Adapter dùng requestApi/auth có sẵn; thêm reference/start/list/get/cancel/
  retry/preview/apply/review. Response được bind với song/draft/job/revision/
  input fingerprint hoặc content fingerprint tùy endpoint. Không có transport
  riêng hoặc thay child playback DTO.
- Queue lưu nối tiếp, debounce 800ms, coalesce snapshot, revision từ ACK gần nhất;
  không để ACK cũ ghi đè input mới. 409/401/403/mạng không tự retry; 422 đợi sửa.
  Lost-response save chỉ reconcile khi nội dung đọc lại khớp hoặc admin chủ động
  bỏ bản local sau đối chiếu. Abort client không được mô tả thành rollback server.
- Controller/hook polling một GET in-flight, visible 2,5s/hidden 15s, cleanup;
  mở lại READY chỉ đọc. Auto-apply chỉ continuation của start/retry tại view còn
  nguyên generation/snapshot; NEEDS_REVIEW luôn cần thao tác áp dụng. Có guard
  double-start/apply, explicit cost ack và explicit review; không tự publish.
- Có component trạng thái job không fake %, và metadata variant compact với
  disclosure/focus field lỗi. Default full của manual editor giữ nguyên.
- Kiểm thử đã quan sát: nhóm 4 file HTTP/autosave/manual 84 ca đạt; nhóm
  lifecycle/autosave 29 ca đạt; nhóm status/form/manual 25 ca đạt. Các nhóm có
  overlap, không cộng chúng thành số test độc lập. Lượt full frontend trước hai
  ca bổ sung publish ACK: 117 file, 1.936 tests đạt, 504,63s. Typecheck, lint scoped
  các file karaoke mới và format scoped đều đạt ở lượt đó.
- Sau bổ sung kiểm tra publish ACK: nhóm 6 file karaoke chạy cùng một lệnh,
  108/108 tests đạt (27,89s). Typecheck và lint queue/test mới đạt lại. Production
  build với cấu hình Supabase/API giả cô lập đã đạt; không triển khai hoặc gọi
  worker/model trong lượt kiểm tra frontend này. Không ghi số 1.938 như full-suite
  cuối vì không chạy lại toàn bộ discovery sau hai ca bổ sung.
- Ở mốc nền này chưa đổi routes hoặc có workspace/wizard/review panel hoàn chỉnh.
  Các bổ sung runtime tiếp theo được ghi riêng bên dưới; feature vẫn mặc định tắt.

### Wizard admin đã nối vào ứng dụng

- Routes new/edit đã dùng workspace simple; `?mode=advanced` giữ editor cũ.
  Capabilities404/disabled/unconfigured giữ manual; 401/403 không bị nuốt thành
  fallback. Mở bài published không tự clone. Không đổi auth/AppServices/layout,
  player của bé, dependencies hoặc `.env` thật.
- Wizard giữ cùng view qua create/upload/save/enqueue/apply và giữ File trong
  bộ nhớ; hiện link mở lại bản đã lưu. Creation replay giữ intent/body gốc.
  Upload mất ACK chỉ phục hồi nếu GET chứng minh hash, draft, metadata và đúng
  bước revision; không rõ thì giữ file/input và dừng, không upload lặp.
  Hash đã có từ trước không được coi là bằng chứng cho một response bị mất.
  Chọn file mới sau HTTP413/415/422 chỉ tiếp tục khi GET chứng minh bản máy chủ
  chưa đổi; giữ lời/metadata local. Không áp dụng cách này cho timeout/5xx/409.
  Thay audio giữ mốc cũ tới ACK rồi xóa mốc câu/tiếng, không đổi IDs/text hoặc
  lưu lại timing của bản thu cũ vào audio mới.
- Dán lời thành v2 với IDs ổn định theo thứ tự câu, giữ dòng lặp/NFC; tiếng mới
  có timing null. Metadata-only không convert legacy. Autosave không gỡ editor
  timing đang dùng hoặc nhận ACK cũ đè input; preview cũ không cho publish.
- Ba bước có trạng thái hiện tại; phần nhập liệu thu lại sau enqueue/apply và
  mở lại ở lỗi metadata. Field nguồn/quyền tự mở/focus và giữ tên accessible
  nhất quán khi hiện lỗi. Có unsaved guard và chuyển advanced qua flush.
- Review phân biệt staging/draft, dùng một player native; đổi/renew reference
  dừng nguồn cũ, giữ đúng loại nguồn, không autoplay. Reference422 giữ draft và
  backing preview. Flags mất target vẫn hiển thị; checkbox không bỏ structural
  errors. Review và publish là hai hành động, không xác nhận từ sự kiện play.
- Library thêm badge/CTA từ summary, poll list khi có job outstanding và tab
  visible; không GET từng job trên mỗi card, không ẩn bản published đang sửa.
- Lượt kiểm thử tập trung cuối sau nối UI: 8 file, 132/132 tests đạt, gồm editor cũ,
  service, queue/session, wizard và library polling. Typecheck, lint scoped và
  format các file frontend đã thay đổi đạt ở lượt kiểm tra tương ứng. Những
  số liệu này không được dùng thay cho benchmark âm nhạc hoặc Supabase live.
- Full frontend: 119 file, 1.958 tests đạt (646,53s), chạy trước bốn ca upload
  hardening cuối. Không gọi 1.962 là một lượt full-suite đã chạy. Nhóm 132 ở
  trên kiểm tra các thay đổi cuối; các lượt có overlap, không cộng số tests.
- Playwright admin cũ + wizard + child: 36/36 đạt, desktop1440px và mobile390px.
  Sau bổ sung retry MP3, chạy riêng wizard: 8/8 đạt (3,7 phút), có một player,
  GET-only resume, review/publish tách biệt, field focus và không tràn ngang.
  Guard hash-đã-có bổ sung sau đó được kiểm ở nhóm unit cuối, không phải một
  lượt browser khác. Đã xem ảnh input/review desktop và review mobile.
- Các lượt đầu đã phát hiện label lỗi đổi accessible name (đã sửa và test lại)
  và một hydration mismatch ở dashboard trong Next dev. Không sửa AppShell/
  child runtime hoặc bỏ assertion; hai lượt browser tổng tiếp theo qua các ca
  child. Một lượt unit đồng thời build quá timeout5s ở happy flow; chạy riêng
  lại nhóm 132 đạt, không tăng timeout hoặc bỏ test.
- Production build với env Supabase/API giả đạt; Next compile, TypeScript và
  static generation38/38 thành công. Full lint: 0 errors, 13 warnings trong các
  file OCR/reading ngoài phạm vi và không sửa các file đó. Scoped lint karaoke
  không có cảnh báo mới; format31 file frontend thay đổi và diff --check đạt.
- Toàn bộ browser dùng Auth/API/media fixtures, không upload/publish vào dữ liệu
  thật, không chạy model hoặc kiểm chứng nhạc thật. Chromium mobile emulation
  không chứng minh Safari/iOS. Đây là mốc code/UI local, chưa phải nghiệm thu
  toàn bộ Phase 3/5/6 hay cho phép bật production.

SQL tests dùng duy nhất DB loopback disposable được harness kiểm marker/URL.
Audio/Storage trong API tests là fixture; các ca này không chứng minh chất lượng
âm nhạc. Không có provider tính phí được gọi trong phép thử engine local.

## Còn phải làm trước khi nghiệm thu

### Hiệu chuẩn và SQL tiếp tục — boundary v2

Đã thêm delimiter CTC có kiểm tra decode độc lập, pin boundary version trong
adapter/cache/provenance. Nhóm mapper/subprocess/pipeline SQL24/24 đạt, pure AI
16/16 đạt. Worker/model/SQL thật đạt riêng nhưng composite sau tách vẫn thiếu
1/2 end; không tự publish. Năm utterances sạch có8/10 cặp thô, sau mapper chỉ
6/10 được chấp nhận; không phải5 bài hát hoặc benchmark đã đạt.
Full backend sau thay đổi cuối đạt:1.045 tests, OK,38 skipped,283,019s;
model thật là lượt opt-in riêng, không tính là chạy trong discovery đó.

Chi tiết phiên bản, hash phép đo, tài nguyên, lỗi môi trường và các cổng còn thiếu
ở [QUALITY-20261117.md](QUALITY-20261117.md). Chủ dự án đã xác nhận chỉ đồ án/demo
phi thương mại. Không có quyền rollout Supabase mới được suy ra từ xác nhận đó.

### Các cổng còn lại

Bổ sung mới: negative silence và piano nguyên file đã bị model thật từ chối đúng
`NO_USABLE_VOCALS`, không sinh candidate. Đã sửa race cancel heartbeat khi SQL
đang đóng, thêm5 unit tests; nhóm worker/lease/shutdown16/16 đạt trên DB tạm.
Full backend sau fix shutdown: 1.050 tests, OK, 38 skipped, 234,328 giây;
log không còn `Exception closing connection`. Lượt 1.045 ở trên là mốc trước đó.
Nguồn, hash, latency và gate chưa đủ được ghi tại
[NEGATIVES-AND-SHUTDOWN-20261117.md](NEGATIVES-AND-SHUTDOWN-20261117.md).
Chủ dự án xác nhận hiện không có bộ bài để cung cấp; yêu cầu benchmark bài Việt
thật vẫn giữ nguyên, không thay bằng các negative hoặc clip hiệu chuẩn.

1. Hoàn tất lựa chọn engine/quyền + benchmark bài Việt thật đại diện/held-out;
   cải thiện end/mismatch/chunk clock, kiểm stems và timeline MP3.
2. Mở rộng hardening/ma trận pipeline, đo thời gian/tài nguyên/caps trên bài thật,
   cleanup dry-run và readiness vận hành; không coi prototype đã đạt cổng Phase 3.
3. Bổ sung ma trận lỗi còn thiếu và nghiệm thu với backend/worker thật sau khi
   quality gate đạt; mốc UI/build/browser cô lập đã có ở phần trên.
4. Test ma trận đầy đủ theo đặc tả05, build/browser regression, live acceptance.
5. Tài liệu vận hành, bàn giao/commit/PR theo quyền và kết quả nghiệm thu; không
   auto-publish hoặc tuyên bố mọi phase đã xong.

Chưa commit/push, chưa ghi DB dùng chung, chưa bật tính năng cho người dùng.

### Sourcing sau yêu cầu chọn Con cò bé bé / Cháu lên ba

Đã tải hai MP3 thật từ URL phát công khai vào cache private, không phải clip
âm vị hoặc link chưa kiểm. Chưa xác nhận quyền dùng/annotation nên không nhập
chúng vào bộ positive benchmark hoặc xuất bản. Con cò tách được stems nhưng
mapper từ chối `LYRICS_NOT_MATCHED`; Cháu đi mẫu giáo lỗi tách
`INVALID_PROVIDER_RESULT`, chưa có candidate. Các bước nguyên bài đã vượt
timeout mặc định180s trên CPU hiện tại; đợt nghiên cứu dùng420s/bước, không đổi
config thật. Đã có trang nghe private kiểm tra browser, không dùng Supabase.
Chi tiết và artifact hashes:
[PUBLIC-SONG-DIAGNOSTIC-20261117.md](PUBLIC-SONG-DIAGNOSTIC-20261117.md).
Các gate ở trên vẫn mở, chưa tự coi mọi phase hoàn tất.

### Tiếp tục19/11 — sửa clock của bài có đoạn lặng

Đã tái hiện lỗi tách Cháu đi mẫu giáo: cả3 cửa sổ fixed gần như không có vocal,
nên clock verifier hết anchor. Sửa chọn informative source anchors, giữ ngưỡng
timing/correlation, version stem recipe/cache thành active-anchors-v2. Bài thật
chạy lại đã tách được vocal+nền, nhưng mapper vẫn từ chối `LYRICS_NOT_MATCHED`;
không tự nhân lời hoặc dùng ASR làm ground truth.

AI26/26, adapter/mapping21/21 đạt. Full backend1.053 ca, OK,38 skipped; sau đó
nhóm pipeline SQL7/7 gồm test cache mới đạt (không cộng lượt overlap thành tổng).
Đã có trang nghe private19/11 kiểm browser, không phải frontend/live acceptance.
DB tạm đã dừng, model/test không còn chạy nền. Không ghi Supabase, sửa env thật
hoặc tự xuất bản/commit. Chi tiết/root cause/hash:
[CLOCK-FIX-20261119.md](CLOCK-FIX-20261119.md). Gate chất lượng vẫn mở.

### Kiểm thử frontend cuối và phản hồi nghe duyệt19/11

Full frontend mới sau bốn ca upload hardening:119 file,1.962 tests đạt; format,
lint0 errors/13 warnings đã ghi nhận, typecheck và production build38/38 đạt.
Không cộng lượt này với các mốc trước, không coi fixtures là live acceptance.
Chủ dự án chưa nghe và sẽ kiểm tra sau, nên chất lượng stems vẫn PENDING.
Nguồn mới chưa đủ điều kiện benchmark; chưa có full-song candidate hợp lệ hoặc
nghe duyệt/rollout. Chi tiết log/hash và sourcing:
[VERIFICATION-20261119.md](VERIFICATION-20261119.md).

Rà soát bổ sung cả tracked/untracked snapshot95 file: không có media/weights,
env thật hoặc migration version trùng trong tập kiểm;3 match credential/URL
được phân loại fixture. Giới hạn phép quét và wiring chung đã đọc nằm ở
[SOURCE-AUDIT-20261119.md](SOURCE-AUDIT-20261119.md). Đây chỉ là chuẩn bị bàn giao,
không phải cho phép rollout hoặc thay thế benchmark/nghe duyệt còn thiếu.
