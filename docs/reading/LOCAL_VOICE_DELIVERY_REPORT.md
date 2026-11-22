# Báo Cáo Bàn Giao — ViRead Ưu Tiên Giọng Nói Local, Google Dự Phòng Có Kiểm Soát, Một Giọng Xuyên Suốt & Đánh Vần Từng Bước Chuẩn Dấu Tiếng Việt

- **Ngày nghiệm thu:** `2026-11-22`
- **Nhánh triển khai:** `feat/local-voice-first-20261122` (tách từ `origin/main` @ `6cbc9b24`)
- **Tài liệu thiết kế & kiểm toán đi kèm:**
  - Đặc tả kiến trúc & kiểm kê luồng giọng nói: `docs/reading/LOCAL_VOICE_FIRST_SPEC.md`
  - Báo cáo benchmark STT/TTS & kiểm toán âm học F0 chữ `"mốt"`: `docs/reading/VOICE_BENCHMARK_AND_AUDIO_AUDIT.md`

---

## 1. Tóm Tắt Kiến Trúc & Các Mô Hình Local Đã Ghim

Để bảo vệ tuyệt đối các gói OCR đã khóa ABI trong `backend/requirements.txt` (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13` — `git diff backend/requirements.txt` hoàn toàn rỗng), toàn bộ dịch vụ giọng nói chạy trong một môi trường độc lập tại `F:\c1\tools\voice-runtime\.venv` thông qua worker loopback `scripts/windows/voice_worker.py` (`http://127.0.0.1:8010`).

| Thành phần | Gói / Trọng số đã ghim | Giấy phép | Kết quả đo thực tế trên máy Windows |
| --- | --- | --- | --- |
| **Local STT (Mặc định)** | `sherpa-onnx==1.12.39` + `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` (ghim 5 mã SHA-256 trong `Download-ViReadVoiceModels.ps1`) | Apache-2.0 | Độ trễ `30,7–140,6 ms` (`RTF ≈ 0,03`), đúng `100%` tập câu thử giọng Bắc/Trung/Nam & phụ âm ghép, `0` ảo giác lặp từ trên âm đánh vần ngắn (`"ô, tờ, ốt."`), trả `language_probability: null` trung thực |
| **Ứng viên STT đã loại** | `faster-whisper==1.2.1` + `mad1999/pho-whisper-tiny-ct2` | MIT | Loại bỏ vì chậm `528–10.842 ms` và bị vòng lặp giải mã `"omega omega..."` khi nghe tiếng đánh vần ngắn `"ô, tờ, ốt."` |
| **Local TTS (Mặc định)** | `vieneu==3.8.5` (`VieNeu-TTS v3 Turbo`, ONNX `fp32`, 48 kHz) | Apache-2.0 | 8 giọng chuẩn **Bắc · Trung · Nam** (cả nữ & nam), tổng hợp câu `~363–414 ms` (lần đầu) / `<5 ms` (từ cache đĩa), tốc độ đơn điệu giữ nguyên cao độ (`0,85× = 3,43 s` > `1,00× = 2,87 s` > `1,15× = 2,595 s`) |
| **Google Dự Phòng (Tắt mặc định)** | `GoogleCloudVoiceProvider` (REST v1 STT & TTS trong `backend/app/providers/google_voice_provider.py`) | Cloud API | Chỉ được gọi khi phụ huynh chủ động bật **`Máy này + Google dự phòng`** và bật nút gạt riêng của STT hoặc TTS, đồng thời local gặp lỗi kỹ thuật thực sự |

### Danh mục 8 giọng đọc Local đã kiểm định (3 miền Bắc · Trung · Nam)
- **Miền Bắc:** `local_north_truc_ly` (Cô Trúc Ly — mặc định), `local_north_ngoc_linh` (Cô Ngọc Linh), `local_north_thien_minh` (Thầy Thiên Minh)
- **Miền Trung:** `local_central_ngoc_tran` (Cô Ngọc Trân), `local_central_quang_son` (Thầy Quang Sơn)
- **Miền Nam:** `local_south_thuc_doan` (Cô Thục Đoan), `local_south_my_duyen` (Cô Mỹ Duyên), `local_south_thai_son` (Thầy Thái Sơn)

---

## 2. Nghiệm Thu Bốn Kết Quả Cốt Lõi & Phần Bổ Sung Bắt Buộc Đánh Vần `"mốt"`

### 2.1 STT & TTS chạy Local mặc định — Web & Android APK dùng chung qua Wi‑Fi LAN HTTPS
- Luồng mạng duy nhất trên LAN: `https://<IP-LAN>:8443/_viread_api/voice/*` (`scripts/windows/lan-https-proxy.mjs`, TLS 1.2+) → FastAPI (`127.0.0.1:8000`) → `voice_worker.py` (`127.0.0.1:8010`). Không mở cổng `8010` hay `8000` ra ngoài LAN.
- Bộ nhận diện đoạn trực tiếp `frontend/lib/reading/local-segment-speech-recognition.ts` (`LocalSegmentSpeechRecognition`) thu PCM 16 kHz mono theo nhịp nói của bé và gửi về `/voice/speech-to-text` local trên cả trình duyệt Web lẫn Android `WebView` — không dùng `webkitSpeechRecognition` đám mây của Chrome khi đang ở chế độ local.
- Kiểm toán socket thực tế (`live_e2e_verification.json`): **`outbound_external_connections = []` (`0` kết nối ra đám mây)**.

### 2.2 Google dự phòng có kiểm soát & hai nút gạt độc lập cho phụ huynh
- Trong hộp thoại **`Giọng đọc`**, phụ huynh chọn rõ giữa:
  1. **`Chỉ máy này`** (`local_only` — **mặc định**): chạy 100% trên máy Windows, tuyệt đối không gọi Google.
  2. **`Máy này + Google dự phòng`** (`local_with_google_fallback`): mở hai hộp kiểm hoàn toàn độc lập:
     - **`Dự phòng Google cho Nhận diện giọng nói (STT)`** (`allowGoogleSttFallback`)
     - **`Dự phòng Google cho Đọc mẫu (TTS)`** (`allowGoogleTtsFallback`)
- `VoiceOrchestrator` (`backend/app/services/voice_orchestrator.py`) chỉ cho phép dự phòng STT ở ranh giới đoạn khi local gặp lỗi kỹ thuật (`LOCAL_STT_UNAVAILABLE`, `TIMEOUT`, `BUSY`), **không bao giờ** gọi Google khi bé im lặng, ngập ngừng hoặc đọc sai; chống gửi trùng theo `(session_id, page_id, turn_id)` và tự ngắt mạch tạm thời khi gặp lỗi hạn mức `429` hoặc `5xx`.

### 2.3 Một buổi, một giọng (`SessionVoiceLock`) + Bắc · Trung · Nam + Tốc độ `0,85× · 1,00× · 1,15×`
- Trước khi bắt đầu buổi đọc (và khi mở màn Luyện từ khó), `lockSessionVoice(sessionId)` (`frontend/lib/reading/session-voice-lock.ts`) khóa bất biến bộ 5 tham số `(provider, voiceId, region, modelVersion, speed)` trong `sessionStorage`.
- Loại bỏ hoàn toàn các nhánh tự động rơi sang `window.speechSynthesis` của hệ điều hành hoặc file `.mp3` thu sẵn giọng khác giữa buổi đọc (`countUnintendedVoiceSwitches(sessionId) === 0` trên toàn bộ 9 loại câu thoại: lời chào, hướng dẫn, nhắc thử lại, đọc mẫu từ lẻ, đánh vần từng bước, đọc mẫu cụm/trang, khen ngợi, nhắc tạm dừng, hoàn thành).
- Mọi khóa bộ nhớ đệm trên trình duyệt (`TtsPlayback`) và đĩa (`voice_worker.py`) đều bao gồm đầy đủ `(provider, voiceId, modelVersion, speed, NFC text)`. Tốc độ đọc được áp dụng đúng **1 lần** lúc tổng hợp âm thanh (`audio.playbackRate = 1.0`), không bị biến dạng cao độ.

### 2.4 Đánh vần từng bước chuẩn dấu Tiếng Việt ở cả 2 màn (`ReadingScreen` & `DifficultWordPracticePanel`)
- Cả màn đọc sách và màn Luyện từ khó dùng chung một bộ phân tích âm vị chuẩn NFC (`frontend/lib/reading/phonics-lesson.ts`), một thẻ giao diện đồng bộ từng bước (`frontend/components/reading/phonics-lesson-card.tsx`), và một API âm thanh có mốc thời gian mẫu chính xác (`POST /voice/text-to-speech/phonics`).
- Bé có thể nói **`"Con không biết"`**, **`"Đánh vần giúp con"`**, **`"Nghe đánh vần"`** (và **`"Đọc lại"`** trong Luyện từ khó) hoặc bấm nút **`Nghe đánh vần`**:
  - Trên màn đọc sách: thẻ `PhonicsLessonCard` mở ngay tại chỗ bên dưới trang sách, giữ nguyên vị trí từ đang đọc, không chuyển màn hình.
  - Chuỗi chuẩn bắt buộc cho tiếng **`"mốt"`** (trong `"hai mươi mốt"`):
    1. Hiển thị `ô · tờ → ốt` · phát âm sạch: **`"ô, tờ, ốt."`** (`[0,08s – 1,147s]`)
    2. Hiển thị `mờ + ốt` · phát âm sạch: **`"mờ, ốt."`** (`[1,567s – 2,278s]`)
    3. Hiển thị `sắc → mốt` · phát âm sạch: **`"sắc, mốt."`** (`[2,698s – 3,498s]`)
    4. Hiển thị `mốt` · phát âm sạch: **`"mốt."`** (`[3,948s – 4,570s]`)
    5. Ghép lại ngữ cảnh (khi có cụm nhiều tiếng): **`"hai mươi mốt."`** (`[5,020s – 5,820s]`)
  - Không bao giờ truyền ký tự `-`, `→`, `+` thô vào TTS. Kiểm định phổ F0 thực tế xác nhận phân biệt rõ dấu thanh: **`"mốt"`** (`F0 trung bình = 356,3 Hz`, sắc cao) ≠ **`"một"`** (`F0 trung bình = 252,8 Hz`, nặng trầm) ≠ **`"mót"`** (`F0 = 342,6 → 400,1 Hz`, nguyên âm mở `o`).
  - Các từ ngoài quy tắc đánh vần lớp 1 (`"pizza"`, `"SGK"`, `"21"`, `"trng"`, tên riêng nước ngoài chưa xác minh) không bao giờ bị đoán bừa — hiển thị rõ **`"Chưa có mẫu đánh vần"`** và vẫn giữ nút **`Nghe từ`** khi hợp lệ.
  - Đồng bộ chặt với Micro & `EchoGuard`: dừng thu trước khi phát đánh vần → tô sáng từng phần theo audio → đọc trọn tiếng có dấu → chờ qua đuôi vọng âm → mời bé đọc lại → lắng nghe & chấm. Nếu bé mới lặp lại bước trung gian (`"ô, tờ, ốt"`), ViRead khen nhịp ghép và mời bé đọc trọn tiếng `"mốt"`, tuyệt đối không tính nhầm là đã hoàn thành từ.
  - **4 kết quả tách biệt rõ ràng** (không bao giờ ghi đè kết quả lượt đọc đầu):
    1. `Đọc đúng ngay lần đầu` (`FIRST_PASS_CORRECT`)
    2. `Đọc đúng sau gợi ý` (`CORRECT_AFTER_HINT`)
    3. `Đọc đúng sau đánh vần` (`CORRECT_AFTER_SPELLING`)
    4. `Cần luyện lại` (`NEEDS_PRACTICE`)

### 2.5 Giữ nguyên luồng đọc tự động 1 chạm của bé & chạy song song mượt cùng OCR
- Luồng đọc 1 lần bấm **Bắt đầu** (`G4`, `G5`, `G9`, `G10`, `G14`, `G24`, `G25–G28`) vượt qua trọn vẹn `100%` bộ kiểm thử Playwright trên cả Desktop (`1440×1000`) và Mobile (`390×844`), độ trễ tô chữ `highlight-latency` đạt `p50 = 6,02 ms`, `p95 = 8,11 ms` (ngưỡng `<= 50 ms`).
- Chạy đồng thời **OCR Tiếng Việt (OpenCV + Tesseract `vie`) + Local TTS + Local STT** hoàn thành song song trong **`564,8 ms`** (OCR `348,8 ms` đọc chính xác `"Hai mươi mốt bông hoa đỏ thắm."`, Backend+OCR RSS `212,1 MB`, `voice_worker.py` RSS `1.631,3 MB` — tổng bộ nhớ `< 1,85 GB` trên máy 15,8 GB RAM).

---

## 3. Bảng Phân Tách Trung Thực Các Cổng Kiểm Chứng (Thật vs Giả Lập vs Bị Chặn)

| Hạng mục kiểm chứng | Phân loại thực thi | Trạng thái | Bằng chứng cụ thể |
| --- | --- | --- | --- |
| **Local TTS + Local STT 3 miền, 3 tốc độ & đánh vần `"mốt"`** | **Hệ thống thật (Real Local Execution)** | **PASS** | `voice_worker.py` (`127.0.0.1:8010`) + FastAPI; 8 giọng 3 miền, tốc độ `0,85/1,0/1,15`, 5 bước `"mốt"` + `"hai mươi mốt"`, `outbound_external_connections = []` (`F:\c1\tools\voice-runtime\benchmark_out\live_e2e_verification.json`) |
| **Chạy song song OCR Tiếng Việt + Local STT + Local TTS & Phục hồi lỗi Worker** | **Hệ thống thật (Real Local Execution)** | **PASS** | Song song hoàn tất trong `564,8 ms`; ngắt worker trả mã an toàn `LOCAL_TTS_UNAVAILABLE` / `LOCAL_STT_UNAVAILABLE` (`503`, `0` gọi Google) và hồi phục tức thì khi nối lại |
| **Wi‑Fi LAN HTTPS Reverse Proxy cho Web & Android APK** | **Hệ thống thật (Real LAN TLS 1.2+ Execution)** | **PASS** | `https://192.168.1.4:18443/_viread_api/voice/*` xác thực chuỗi chứng chỉ `viread-lan-ca.pem` (`lan_https_voice_proxy_e2e.json`) |
| **Frontend Format, ESLint, TypeScript & Vitest toàn bộ dự án** | **Hệ thống thật (Automated Suite)** | **PASS** | `prettier --check` PASS, `eslint .` PASS (`0` lỗi, `0` cảnh báo), `tsc --noEmit` PASS, Vitest **`170/170` file (`2.542` test PASS)** |
| **Playwright Trình duyệt thật Chromium (Desktop & Mobile 390px)** | **Hệ thống thật (Real Browser E2E)** | **PASS** | **`28/28` ca PASS** (`local-voice-and-phonics.pw.ts`, `reading-autopilot.pw.ts`, `tts-upgrade.pw.ts`), `0` tràn ngang |
| **Backend Voice Unit & Policy Suite + Repo Hygiene** | **Hệ thống thật + Fault-Injection** | **PASS** | `47/47` test giọng nói (`test_voice.py`, `test_voice_studio.py`, `test_voice_local_and_google_fallback.py`) PASS; `1.433` test backend không cần Docker Postgres PASS (`0` FAIL); `verify_repository_hygiene.py` & `validate_agent_config.py` PASS |
| **Build, Ký số & Kiểm định chất lượng Android Debug APK** | **Hệ thống thật (Gradle 8.11.1 + SDK 35)** | **PASS** | `:app:testDebugUnitTest`, `:app:lintDebug`, `:app:assembleDebug`, `apksigner` v2 & `verify_apk_quality.py` PASS (`android/app/build/outputs/apk/debug/app-debug.apk`, `2,08 MB`, SHA-256: `c16031d23a0cbd08193becf83398d981fd9945b8502eec53b5e274ffa60a71c3`) |
| **Chính sách chuyển mạch, chống gửi trùng & ngắt mạch Google STT/TTS** | **Giả lập lỗi (Simulated / Mocked Fault-Injection)** | **PASS (Mocked)** | Kiểm chứng đầy đủ trong `backend/test_voice_local_and_google_fallback.py` (không tính là gọi tài khoản Google thật) |
| **Gọi API trực tiếp tới tài khoản Google Cloud STT/TTS thật** | **Tài khoản Cloud thật** | **BLOCKED** | `backend/.env` hiện chưa có biến xác thực `GOOGLE_CLOUD_TTS_API_KEY` / `GOOGLE_CLOUD_STT_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` |
| **Cài đặt & tương tác trực tiếp trên thiết bị Android vật lý qua ADB** | **Thiết bị phần cứng thật** | **BLOCKED** | `adb devices -l` hiện không có điện thoại/emulator kết nối; bản APK Debug LAN đã đóng gói & ký hợp lệ sẵn sàng cài ngay khi cắm máy |
| **Đo WER trên tập ghi âm giọng trẻ em 6–7 tuổi ngoài đời thực** | **Dữ liệu giọng trẻ em thật** | **NOT RUN** | Tuân thủ ràng buộc bảo vệ dữ liệu giọng nói trẻ em (không tự tải bộ dữ liệu thiếu giấy phép rõ ràng); đã kiểm chứng trên giọng người Việt thật trưởng thành + kiểm toán âm học F0 |

---

## 4. Hướng Dẫn Khởi Động, Kiểm Tra & Dừng Cho Phụ Huynh Trên Windows

```powershell
# 1. (Chỉ cần chạy 1 lần đầu hoặc khi kiểm tra lại SHA-256 model) Tải & xác minh model giọng nói local
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Download-ViReadVoiceModels.ps1

# 2. Khởi động toàn bộ ViRead (tự động bật Local Voice Worker 127.0.0.1:8010 + FastAPI + Next.js + LAN HTTPS Proxy)
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Start-ViRead.ps1

# 3. Kiểm tra trạng thái toàn hệ thống & trạng thái riêng của Local Voice Worker
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Get-ViReadStatus.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Get-ViReadVoiceWorkerStatus.ps1

# 4. Dừng sạch toàn bộ dịch vụ (bao gồm cả Local Voice Worker)
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Stop-ViRead.ps1
```

### Tùy chọn bật Google dự phòng (khi phụ huynh có khóa Google Cloud API)
1. Điền `GOOGLE_CLOUD_STT_API_KEY` và/hoặc `GOOGLE_CLOUD_TTS_API_KEY` (hoặc `GOOGLE_APPLICATION_CREDENTIALS`) vào `backend/.env`.
2. Mở **`Giọng đọc`** trên màn đọc sách → chọn **`Máy này + Google dự phòng`** → bật riêng từng mục **STT** hoặc **TTS** theo nhu cầu. Khi máy local hoạt động bình thường, hệ thống vẫn ưu tiên xử lý local `100%` để tiết kiệm hạn mức.
