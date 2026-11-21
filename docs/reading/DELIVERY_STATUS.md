# ViRead — Luồng đọc tự động: DELIVERY STATUS (checkpoint sống)

> Tài liệu checkpoint. Khi đổi phiên/hết quota, tiếp tục từ mục **NEXT**. Không reset công việc đã có bằng chứng.

## 0. Định danh

| Mục | Giá trị |
|---|---|
| Repo | `https://github.com/trancuong3/capstone1` (remote `origin`) |
| Worktree | `F:\c1\capstone1-reading-auto` (branch `feat/reading-autopilot-20261121`) |
| Base commit | `aafa3966f75b0d4671eec49ff0b5550668f2d998` (= `origin/main` cục bộ = HEAD của checkout chính `feat/flow2-google-drive-first-training`) |
| Fetch `origin/main` | NOT RUN: sandbox không có mạng (`Could not resolve host: github.com`). `origin/main` cục bộ trùng base commit. |
| Công việc chưa commit của người dùng | Nằm ở checkout `F:\c1\capstone1` (24 file sửa + file chưa theo dõi: OCR/Drive/parent-private-books). **Không đụng tới.** Worktree này tách riêng từ commit đã commit nên không chứa các thay đổi đó. |
| `node_modules` | Junction tới `F:\c1\capstone1\frontend\node_modules` (cùng `package-lock.json`, không có thay đổi frontend chưa commit). |
| Python | `F:\c1\capstone1\.venv\Scripts\python.exe` (3.12.10). Không đổi ABI pin (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`). |
| Hạ tầng máy | Không có `adb`, `docker`, `psql`, `ffmpeg` trên máy này. Không có Postgres cục bộ. |

## 1. Baseline (đo TRƯỚC khi sửa, trên đúng SHA base)

### 1.1 Baseline kiểm thử hiện có
- `npx vitest run tests/reading` (33 file): **382 pass, 2 fail**, 122.8 s.
- Hai test fail là `reading-screen.test.tsx › uses recorded Vietnamese STT for retry outcome: low-confidence-keyterm` và `…: silent-help-limit` — **timeout 5000 ms khi chạy song song toàn nhóm** (máy tải cao: jsdom 33 lần). Chạy riêng `-t "recorded Vietnamese STT for retry outcome"`: **17/17 pass**, mỗi ca 0.9–3.7 s. Kết luận: lỗi hiệu năng dưới tải, không phải lỗi logic. Không sửa test, không hạ ngưỡng; cổng cuối chạy với `--maxWorkers` thấp và ghi rõ.

### 1.2 Khảo sát code (đã đọc)
`reading-screen.tsx` (4955 dòng), `reading-controls.tsx`, `word-highlight-overlay.tsx`, `camera-preview.tsx`, `realtime-alignment.ts`, `word-practice-engine.ts`, `recognition-evidence.ts`, `audio-quality.ts`, `use-speech-recorder`, `use-speech-player`, `tts-playback.ts`, `speech-service.ts`, `voice.py`, `reading_reminder_worker.py`, `reading_reminder_email_provider.py`.

Khả năng đã có (tái sử dụng): chuẩn hóa tiếng Việt giữ dấu; `RealtimeAlignmentEngine` (lookahead, pending token, uncertain); chặn bằng chứng khi `assistantAudioPlayingRef`; `isAssistantPromptBleed`; "con không biết" (`isWordHelpRequest`); timer im lặng → `offerPassageHelp` (đọc mẫu 1 lần); `autoCompletePageAfterFinalWord` (chỉ khi từ cuối là `MATCH`); retry-mode sau buổi đọc (ngưỡng 3 lần sai); email nhắc lịch đọc có sẵn (SMTP, email đã xác minh qua Supabase Auth, claim/idempotent).

Khoảng trống đã xác định (mục tiêu sửa):
1. Không có công tắc phụ huynh riêng cho **hỗ trợ tự động / tự chuyển trang / nhắc email**.
2. Tự chuyển trang chỉ khi từ cuối `MATCH` → trang kết thúc bằng từ bỏ qua/sai bắt bé bấm tay; không có "hết lượt thử thì động viên và cho qua".
3. Echo: chỉ chặn khi `assistantAudioPlayingRef` đang `true`; **không có đuôi vọng sau khi mẫu kết thúc**, không đối chiếu nội dung TTS.
4. Tự sửa: mèo→chó→mèo không bao giờ cập nhật; đọc lại đầu câu có thể ghi **SUBSTITUTE oan** cho từ hiện tại.
5. Không có ý định "đợi con", "dừng lại", "đọc tiếp", "đọc mẫu giúp con" ngoài mẫu "con không biết".
6. Không có bộ điều phối kiểm thử được; mọi timer/transcript nằm trong component 5k dòng.
7. Không có phát hiện hiện diện/nhắc phụ huynh; không có API/worker/bảng cho việc đó.
8. Không có dữ liệu giọng trẻ được phép dùng; `docs/child-reading-experience/REAL_AUDIO_REPORT.md` ghi WER/CER "Not measured".

## 2. Cổng nghiệm thu (KHÓA trước khi sửa)

Repo **không** quy định ngưỡng số cho nhận diện/highlight (xác nhận bằng tìm kiếm `p95|threshold|WER|CER` trong `docs/`). Ngưỡng dưới đây chốt dựa trên baseline + phần cứng; **không hạ sau khi thấy kết quả**.

### 2.1 Phạm vi dữ liệu và trung thực
- **Corpus tổng hợp mức transcript** (do nhóm tự viết, không có giọng trẻ): luồng bằng chứng STT giả lập theo kịch bản. Chia **tuning** (dùng để sửa) và **holdout** (chỉ chạy *một lần* cho kết luận cuối; ca nào mở ra để sửa thì chuyển sang tuning/hồi quy và phải có ca holdout mới).
- Đây **không** phải đo WER/CER thật, **không** phải giọng trẻ. Báo cáo ghi rõ "synthetic transcript-level".
- Giọng trẻ được phép dùng: **không có** → mọi cổng "chuẩn giọng trẻ" = `BLOCKED`.

### 2.2 Danh sách cổng

| ID | Cổng | Ngưỡng (pass nếu) | Loại bằng chứng | Trạng thái |
|---|---|---|---|---|
| G1 | Tô đúng nhầm (false-correct) trên ca lỗi/ngoài bài/echo/bỏ từ | **= 0** từ trên cả tuning và holdout | benchmark synthetic | PENDING |
| G2 | Tô sai nhầm (false-wrong) trên ca đọc đúng/tự sửa/lặp/đọc lại | tuning & holdout: nhóm "fluent" **= 0**; tổng **≤ 2%** từ | benchmark synthetic | PENDING |
| G3 | Tô lệch từ (match vào sai `word_id`) | **= 0** | benchmark synthetic | PENDING |
| G4 | Tô xanh do tiếng TTS (kể cả đuôi vọng, nội dung TTS bị STT nghe lại) | **= 0** | benchmark + unit | PENDING |
| G5 | Số lần bấm sau Bắt đầu + cấp quyền, ca đọc trơn, tự chuyển trang bật | **= 0** | test màn đọc (RTL) | PENDING |
| G6 | Ngắt lời nhầm (nhắc/đọc mẫu khi bé đang nói hoặc ngắt hơi hợp lý) | **= 0** trên kịch bản fake-clock | `reading-automation.test.ts` | PENDING |
| G7 | Thời gian từ khi có ý định "xin giúp" tới lệnh đọc mẫu đầu tiên (logic điều phối) | **≤ 300 ms** (fake clock, p95; trễ I/O TTS thật tách riêng) | automation test | PENDING |
| G8 | Chuyển trang nhầm / hoàn tất 2 lần / lưu trùng | **= 0** (cả khi đảo thứ tự sự kiện) | property-style test | PENDING |
| G9 | Từ bỏ qua / hết lượt không bị ghi là đúng; được ghi "Cần luyện lại" | **= 0 sai** | automation + alignment | PENDING |
| G10 | Lưu thất bại: không chuyển trang làm mất tiến độ; retry idempotent; khôi phục sau reload | pass toàn bộ ca | automation + screen test | PENDING |
| G11 | Presence → email: không gửi ở ca cúi/quay đầu/che camera/nền/camera lỗi/hết phiên/opt-out/email chưa xác minh/sai chủ phiên/hết hạn | **0 email** | backend + presence tests | PENDING |
| G12 | Presence → email: ca hợp lệ | **đúng 1 email**, kể cả 2 request đồng thời, retry, worker restart | backend tests (fake repo) + DB thật nếu có | PENDING |
| G13 | Nội dung email | chỉ nêu "ViRead đã tạm dừng vì một lúc không thấy người đọc trong khung hình"; không chứa sách/transcript/ảnh | backend test mail sink | PENDING |
| G14 | Phụ huynh tắt riêng được 3 tùy chọn | pass UI + service test | RTL | PENDING |
| G15 | lint, typecheck, build, unit, integration | exit 0 trên SHA bàn giao | lệnh tái lập | PENDING |
| G16 | Playwright với frontend/backend/DB thật | chạy được | E2E | `BLOCKED` nếu không có Postgres/backend thật (xem mục 4) |
| G17 | Benchmark STT/TTS thật (clip giữ riêng, audio chuẩn) | số mẫu/lần lặp đã định | benchmark thật | `BLOCKED`: chưa có clip được phép; ElevenLabs cần credit |
| G18 | Nghiệm thu Android thật (loa/mic/camera/WebView/nền) | thiết bị đã cấp quyền | thiết bị | `BLOCKED`: không có `adb`/thiết bị |

Quy tắc kết luận: chỉ dùng ngưỡng trên. Cổng `BLOCKED/NOT RUN` **không** được tính là đạt; goal không đóng khi còn cổng bắt buộc `BLOCKED`.

## 3. Nhật ký tiến độ

| Mốc | Trạng thái | Ghi chú |
|---|---|---|
| Worktree + baseline + khóa cổng | DONE | tài liệu này |
| Corpus + benchmark baseline (engine gốc) | TODO | |
| Alignment/evidence/echo fixes | TODO | |
| Điều phối + TTS queue | TODO | |
| Presence + email backend | TODO | |
| Tích hợp màn đọc + công tắc phụ huynh | TODO | |
| Vòng lặp kiểm thử/sửa | TODO | |
| Cổng cuối trên SHA bàn giao | TODO | |

## 4. NEXT

1. Viết corpus synthetic (tuning/holdout) + runner; chạy trên engine gốc → bảng baseline.
2. Sửa theo khoảng trống 3–5.
