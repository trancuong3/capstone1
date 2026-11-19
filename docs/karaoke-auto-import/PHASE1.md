# Phase 1 — Khảo sát và quyết định nhập karaoke tự động

> Báo cáo mốc ban đầu. Chủ dự án sau đó đã yêu cầu tiếp tục các phase và tự tìm
> nhạc. Xem [STATUS.md](STATUS.md) và [SOURCES-AND-PREFLIGHT.md](SOURCES-AND-PREFLIGHT.md)
> để biết thay đổi DB/API, môi trường AI và kết quả thử mới nhất; gate chất lượng
> vẫn chưa đạt.

Ngày kiểm tra: 2026-11-17. Phạm vi được giao: chỉ Phase 1 theo bộ đặc tả
`karaoke-auto-import` 01–05. Trạng thái: hoàn thành rà soát, chốt UX và chuẩn bị
công cụ đo; **chưa đạt cổng benchmark bài hát thật, chưa khóa engine sản phẩm**.

## Baseline và thay đổi

Repo ứng dụng: `D:\Project\capston1_new\capstone1`. Đã fetch `origin/main` và
đối chiếu HEAD/origin/main cùng commit
`d4402915126ffcb5f26eca710d4d381e2841de31`. Working tree sạch trước khi tạo nhánh
`feature/linh-karaoke-auto-import`. Hướng dẫn `Agent.md` và `frontend/AGENTS.md`
đã đọc; quy định branch `tu` trong tài liệu cũ không thay thế nhánh task đã giao.

Phase này chỉ thêm hai tài liệu, script đo offline và tests cho phép đo. Runtime
karaoke, database, bucket, tài khoản và môi trường cài thư viện được giữ nguyên.
Chưa chạy migration, server, provider trả phí, cài model, commit, push hoặc PR.

## Hiện trạng và điểm tái sử dụng

| Bằng chứng từ source                                                                                              | Kết luận                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `frontend/components/admin/karaoke/karaoke-editor-screen.tsx`: create/upload/import/save/validate/preview/publish | Có luồng manual để giữ làm chế độ nâng cao                                               |
| `adopt()` trong editor thay cả metadata/lyrics/preview; create gọi `router.replace`                               | Wizard mới phải có state/queue riêng; không chuyển trang giữa chuỗi upload và xử lý      |
| `frontend/lib/karaoke/lyrics-import.ts`, `frontend/lib/karaoke/syllable-timing.ts`                                | TXT trả v1/null timing; có `upgradeLyrics()` để chuẩn bị v2, chưa sinh alignment         |
| `backend/app/schemas/karaoke.py`, `backend/app/services/karaoke_lyrics.py`                                        | Validator v2/IDs/timing hiện có tái sử dụng được; không phân tích nhạc                   |
| `backend/app/providers/elevenlabs_voice_provider.py`                                                              | Có STT `scribe_v2` và word timestamps; chưa có tách stems hoặc karaoke forced alignment  |
| `docs/karaoke-demo/README.md`, MP3 và báo cáo timing v2                                                           | Có bộ piano/mốc theo melody score; không có bộ vocal tiếng Việt để đo chất lượng căn hát |

Giới hạn source đã xác minh: MP3 20 MiB, tối đa 300.000 ms; ảnh 2 MiB;
300 dòng, 300 ký tự/dòng, 150 tiếng/dòng, 10.000 tiếng/bài, 50.000 ký tự tổng
lời và giới hạn tổng text tiếng hiện có. TXT/LRC 256 KiB, JSON 2 MiB. Bản đầu
giữ các giới hạn này; có thể lưu bản nháp chưa đủ thông tin xuất bản.

## UX đã chọn

1. **Thêm nội dung:** nhạc có giọng + tên bài + dán lời, CTA “Tạo karaoke”. Tên
   gợi ý từ filename khi ô còn trống. Tác giả/lớp/ảnh/nguồn/quyền nằm trong
   “Thông tin thêm”; nguồn và quyền phải đủ trước xuất bản. Không tự điền giấy
   phép. Nhạc nền thuần cần bản hát tham chiếu cùng timeline hoặc chế độ nâng cao.
2. **Xử lý:** create một lần → giữ songId tại view → upload → lưu lời v2 → enqueue.
   Hiện stage thật, cho rời trang sau enqueue và mở lại từ danh sách. Hủy không
   bảo đảm provider đã hoàn phí. Chờ quá ngưỡng chỉ cảnh báo cần kiểm tra worker.
3. **Nghe và duyệt:** staging → apply vào draft → nghe/sửa phần bị đánh dấu → xác
   nhận nội dung hiện tại → xuất bản chủ động. Chỉ một nguồn audio hoạt động.
   Nguồn/quyền thiếu dẫn tới đúng ô nhập, vẫn giữ nội dung đang làm.

Giữ `/new` và File/state xuyên suốt create/upload/save/enqueue/apply; không đổi
component key theo songId vừa nhận. Đưa link mở draft ngay khi biết ID. Sau apply
hoặc terminal an toàn mới chuyển edit; refresh đọc lại job bằng GET và không tự
apply. READY chỉ auto-apply trong continuation của lượt bấm hiện tại khi không
dirty và snapshot còn khớp; NEEDS_REVIEW yêu cầu bấm dùng kết quả.

Autosave dùng một mutation queue, ACK cũ không đè lần gõ mới. 409 giữ input và cho
đối chiếu. ID câu/tiếng ổn định qua save/retry; metadata edit không import TXT lại.
Duyệt/publish đợi queue flush. Cảnh báo còn tồn tại dù admin đã xóa câu liên quan;
structural blocker phải sửa, không thể vượt qua bằng checkbox. Legacy/manual vẫn
dùng luồng hiện có. Đây là quyết định UX, chưa phải UI đã triển khai.

## Engine và phương án thử

**Chưa chọn engine để triển khai production.** Ưu tiên khảo sát API tách stems
vì hợp cấu trúc hiện tại, sau đó so căn lời trên vocal bằng aligner riêng với
word-timestamps STT làm bằng chứng đối chiếu. Chưa cài hai stack hoặc chốt adapter.

| Ứng viên                                                       | Kết quả khảo sát                                                        | Quyết định Phase 1                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ElevenLabs Stem Separation `two_stems_v1`                      | API có chọn chế độ hai stems và trả ZIP; mặc định đang là sáu stems     | Ứng viên tách nhạc; cần thử chất lượng/timeline, quyền tài khoản và chi phí thực          |
| ElevenLabs STT `scribe_v2` đã có trong repo                    | Nhận dạng giọng nói/word timestamps, không ép toàn bộ lời được cung cấp | Đối chứng thử nghiệm; không coi timestamps nhận dạng là căn mọi tiếng đúng                |
| ElevenLabs Forced Alignment                                    | Danh sách ngôn ngữ chính thức chưa liệt kê tiếng Việt                   | Chưa chọn cho luồng tiếng Việt                                                            |
| WhisperX `v3.8.6` + `nguyenvulebinh/wav2vec2-base-vi-vlsp2020` | Có mapping `vi`, API align transcript cho sẵn; chưa đo hát/ngân/câu lặp | Ứng viên nghiên cứu riêng; model card ghi CC-BY-NC-4.0, không suy giấy phép model từ code |

Nguồn đã đọc ngày 2026-11-17:

- [Stem API](https://elevenlabs.io/docs/api-reference/music/separate-stems):
  `/v1/music/stem-separation`, chọn `two_stems_v1` tường minh; kiểm tra ZIP/media.
- [STT](https://elevenlabs.io/docs/overview/capabilities/speech-to-text): hỗ trợ
  word timestamps. Không tự đổi model STT luồng đọc sang model mới của nhà cung cấp.
- [Forced Alignment](https://elevenlabs.io/docs/overview/capabilities/forced-alignment):
  speech alignment; danh sách hiện tại không có tiếng Việt.
- [WhisperX v3.8.6 alignment](https://github.com/m-bain/whisperX/blob/v3.8.6/whisperx/alignment.py):
  mapping `vi`, align known transcript; interpolation không được dùng để che thiếu evidence.
- [WhisperX v3.8.6 dependencies](https://github.com/m-bain/whisperX/blob/v3.8.6/pyproject.toml):
  numpy >=2.1, torch/torchaudio ~2.8; cần môi trường riêng.
- [Model card tiếng Việt](https://huggingface.co/nguyenvulebinh/wav2vec2-base-vi-vlsp2020):
  CC-BY-NC-4.0. Trước dùng ngoài nghiên cứu phải xác định quyền phù hợp hoặc chọn
  checkpoint có quyền phù hợp rồi benchmark lại. Revision weights chưa khóa.

Version v3.8.6 chỉ là mốc khảo sát tái lập, chưa là dependency được cài hoặc
nghiệm thu. Cấu hình cuối phải khóa tag/commit, model revision, hash weights,
license, decoder/encoder và pipeline version sau thử nghiệm thật. Provider phía
server có thể cập nhật; ghi model ID/request ID/version được trả và ngày chạy.

## Môi trường và bằng chứng đã có

Backend `.venv` hiện là Python 3.13.3, mutagen 1.48.1, Pydantic 2.12.4,
httpx 0.28.1. Chưa thấy installed distributions cho torch/torchaudio/WhisperX/
faster-whisper/transformers/Demucs/librosa/soundfile trong venv này. Không thấy
ffmpeg/ffprobe/nvidia-smi qua PATH; điều đó không chứng minh máy không có GPU.
Thông tin GPU/RAM chưa xác minh được trong môi trường kiểm tra.

numpy đã cài 2.5.4 khác pin 1.26.4 trong quy định repo; đây là hiện trạng trước
task, chưa sửa. Không dùng venv OCR để cài aligner hoặc sửa môi trường này trong
Phase 1. Nếu thử local, dùng Python 3.11 trong venv/container riêng, khóa dependencies
sau smoke test; có CPU baseline trước khi hứa tốc độ GPU.

Có một MP3 tracked: `docs/karaoke-demo/ngoi-sao-nho.mp3`, 2.480.796 byte,
44.100 Hz, 192 kbps, khoảng 103.366 ms theo parser trên máy này (sai khác làm tròn
1 ms so tài liệu cũ). SHA256:
`47ebba49be8b7bc776db49c7918b88f0dedfd52f8ccb21e35f6a16e7cb9cbfd6`.
Nguồn ghi piano; lời v2 là lời Việt mới căn theo melody/attack. Dùng để hồi quy
và thiết kế negative case instrumental; chưa chạy engine để kiểm tra negative này.

Đã chạy **22/22 backend tests**: 11 schema/demo hiện có và 11 tests mới cho phép
đo; **41/41 frontend tests** ở hai file importer/syllables hiện có. Không có
skipped trong các nhóm này; chưa chạy full suite/build vì không đổi runtime.
Xem lệnh và cách hiểu số đo ở [BENCHMARK.md](BENCHMARK.md).

| Phép thử offline đã chạy                           | Kết quả                                              | Ý nghĩa                                              |
| -------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Cùng JSON manual v2 ở reference/prediction         | 126/126 tiếng, coverage1, lỗi đầu/cuối0, structural0 | Smoke test evaluator/fingerprint; không có inference |
| Giữ126 tiếng, xóa toàn bộ mốc prediction bằng null | coverage0, hits0/126, median/p95 null,18 câu cần sửa | Missing không bị bỏ khỏi mẫu số                      |
| Chạy pipeline vocal/negative bằng engine thật      | Chưa chạy                                            | Chưa có số liệu accuracy, latency hoặc cost engine   |

Cả hai phép thử offline trả quality_gate_status=NOT_EVALUATED; không chứng minh
độ chính xác AI. CLI là công cụ đo một case; license/held-out/provenance và chất
lượng stems phải được kiểm chứng riêng trước chốt engine.

## Cổng chất lượng và vận hành

Dataset yêu cầu 5–10 bản hát có quyền dùng, gồm tập chỉnh tham số và held-out,
annotation đầu/cuối từng tiếng có người nghe kiểm lại. Mục tiêu onset ≤250 ms
trên ≥90% toàn bộ tiếng của nhóm thuận lợi; missing vẫn trong mẫu số. Báo coverage,
median/p95 đầu/cuối, câu phải sửa và thời gian admin sửa. Thử riêng nhạc không lời,
lời sai, bè, ngân dài, điệp khúc, nhạc lớn và reference khác timeline.

Chưa có số đo engine/chi phí/tốc độ/chất lượng stems. Chưa hiệu chuẩn confidence
cho READY. Trong thử nghiệm đầu, output dùng được vẫn phải nghe duyệt; thiếu mốc
đánh dấu NEEDS_REVIEW. Không có vocal/timeline không khớp/lời sai nghiêm trọng
phải fail thay vì chia đều thời gian. Chốt ngưỡng READY chỉ sau held-out benchmark.

Cấu hình thiết kế giữ worker riêng, concurrency 1, lease120s, heartbeat20s,
poll2s, tối đa2 safe attempts, cap outstanding admin2/global10, queue warning120s.
Đây là đề xuất trong đặc tả, chưa bật/cài worker. Provider timeout180s cần đo lại.
Cap phút/ngày admin/global và ngân sách tiền chưa được thống nhất, để pending;
feature phải fail closed nếu enabled mà thiếu cap. Không suy quota từ API key
tồn tại và không dùng quota phút như bảo đảm hóa đơn tiền.

## Kết quả và điều kiện tiếp tục

Phần baseline/UX/offline tooling của Phase 1 đã có đầu ra review được. Cổng khả
thi trên bài hát thật **chưa đạt do chưa có dataset vocal/annotation, engine được
cài riêng và ngân sách/provider được xác định**. Không tự chuyển Phase 2.

Bước tiếp theo vẫn thuộc Phase 1: chuẩn bị ít nhất một bản hát tiếng Việt có
quyền sử dụng và lời đúng bản thu để smoke test, sau đó mở rộng 5–10 bài. Chọn
môi trường local nghiên cứu có quyền phù hợp hoặc API với trần chi phí cụ thể;
thử stems/alignment, ghi kết quả và pin engine nếu vượt cổng. Dataset và điều kiện
chi phí cần do chủ dự án xác định trước khi tải media lên provider hoặc gọi tính phí.
