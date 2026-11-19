# E2E QA AUDIT REPORT — Kiểm thử cấp độ cao quy trình đọc lại từ sai (`"một"`), bảo toàn lỗi lần đầu & tối giản thao tác "Từ cần luyện"

> [!NOTE]
> Toàn bộ kết quả bên dưới được đo trực tiếp sau bản sửa lỗi cuối cùng. Các test Backend (`unittest`), Frontend (`Vitest`) và Browser E2E (`Playwright` cổng cô lập `127.0.0.1:3106` trên Chromium thật với Web Audio API `AudioContext` / `AnalyserNode`) sử dụng test double & fixture cô lập; **không** chạm cơ sở dữ liệu Supabase production.

---

## 1. Ma trận kết quả Kịch bản A / B / C & Cổng chất lượng

| Hạng mục / Kịch bản | Phạm vi kiểm chứng | Lệnh đã chạy | Kết quả thực tế | Thời gian chạy |
| --- | --- | --- | --- | --- |
| **Backend App & Schema** | Import entrypoint `app.sever:app`, kiểm tra bảo toàn `ReadingAssessmentMetrics`, `self_corrected_word_ids`, dual-store `WORD_RETRY`, `context_phrase` | `..\.\.venv\Scripts\python.exe -c "from app.sever import app; print(app.title)"` & `..\.\.venv\Scripts\python.exe -m unittest test_difficult_words test_reading_assessment test_reading_comparison_service test_parent_reports -v` | **PASS — 64/64 tests OK** (Exit 0) | `2.152 s` |
| **Kịch bản A (`Word 'một'` Post-Reading Sync)** | `ReadingScreen` đọc lại `"một"` 1 lần qua Acoustic VAD (đỏ → vàng → xanh), `ReadingReport` & `SessionReadingReports` tô xanh đồng bộ mà vẫn giữ lỗi lần đọc đầu | `npx.cmd vitest run --maxWorkers=1 tests/reading/word-mot-qa-audit.test.tsx ...` | **PASS — 3/3 tests OK** (`Scenario A1: 1586 ms`, `A2` & `C` OK) | `1.657 s` |
| **Kịch bản B (Tap-Budget & Zero-Extra-Tap Loop)** | Màn `/reports/difficult-words`: mở chip (1 tap) + `"Bắt đầu luyện"` (1 tap) → tự dừng & tự nhảy qua `"một"` → `"bông"` (`autoStart: true`, 0 tap thêm) | `npx.cmd vitest run --maxWorkers=1 ... test/real-parent-reports-ui.test.tsx ...` | **PASS — 22/22 tests OK** (test `"một" -> "bông"` `3186 ms`) | `6.336 s` |
| **8 Suite Vitest cộng gộp** | `word-mot-qa-audit`, `short-word-recognition`, `reading-retry-short-word`, `retry-word-recognition`, `audio-quality`, `session-reading-reports`, `real-parent-reports-ui`, `real-parent-report-services` | `npx.cmd vitest run --maxWorkers=1 ...` | **PASS — 8 files / 90/90 tests OK** (Exit 0) | `36.23 s` |
| **Playwright E2E Chromium VAD** | Chromium thật `desktop` (`1440px`) + `mobile` (`390px`), `4` kích thước `1440/1024/768/390`, reload bền vững, Web Audio burst -> tự ngắt silence -> sang từ #2 rảnh tay | `$env:PLAYWRIGHT_ROUTE_FILTER="/reports/difficult-words"; npx.cmd playwright test --config=playwright.real-data.config.ts test/browser/difficult-words.pw.ts` | **PASS — 6/6 tests OK** (Exit 0) | `1.4 m` |
| **Static Code Gates** | Prettier (10 file chạm), ESLint, TypeScript `tsc --noEmit` | `npx.cmd prettier --check ...; npm.cmd run lint; npm.cmd run typecheck` | **Prettier Exit 0**, **ESLint 0 errors** (9 warnings có sẵn), **tsc 0 errors** | — |
| **Knowledge Graph** | Đồng bộ lại đồ thị mã nguồn | `.\.venv\Scripts\python.exe -m graphify update .` | **Exit 0** (`17192 nodes, 37097 edges, 995 communities`) | — |

---

## 2. Bảng đối chứng "Tô xanh đối xứng vs. Giữ nguyên lỗi lần đầu" (`"Bé có một bông hoa."`, sai từ `"một"` thành `"mốt"`)

Kiểm chứng trực tiếp tại Backend ([test_difficult_words.py](file:///F:/c1/capstone1/backend/test_difficult_words.py) — `test_word_mot_post_reading_retry_preserves_first_pass_error_and_syncs_green`) và Frontend DOM ([word-mot-qa-audit.test.tsx](file:///F:/c1/capstone1/frontend/tests/reading/word-mot-qa-audit.test.tsx) — `Scenario A1` & `Scenario A2`):

| Thời điểm | Trạng thái từ `"một"` trên trang đọc & báo cáo | `first_pass_correct` | `first_pass_incorrect` (Lỗi gốc) | `Accuracy %` lần đầu | `self_corrected_words` / `self_corrected_word_ids` | Dữ liệu trong `"Từ cần luyện"` |
| --- | --- | --- | --- | --- | --- | --- |
| **1. Sau lần đọc đầu** (`"Bé có mốt bông hoa."`) | **Cam / Đỏ** (`bg-orange-200`, `MISPRONUNCIATION`) | `4` | `1` (`"một"`) | `80.0%` (`4/5`) | `0` / `[]` | Xuất hiện `"một"` (`mispronunciation_count = 1`, `NOT_PRACTICED`) |
| **2. Đang đọc lại từ `"một"`** (`activeRetryWordId`) | **Vàng nổi bật** (`ring-yellow-500`) | `4` | `1` (`"một"`) | `80.0%` | `0` / `[]` | Giữ nguyên `mispronunciation_count = 1` |
| **3. Sau 1 lần đọc đúng `"một"`** (`WORD_RETRY` = `CONFIRMED`) | **Xanh lá** (`bg-green-200`, mô tả `"Bé đã tự sửa đúng"`, huy hiệu `"Đã đọc lại đúng: 1 từ"`) | **`4` (Bất biến)** | **`1` (Bất biến — Vẫn tính sai lần 1)** | **`80.0%` (Không bị biến thành 100%)** | **`1`** / **`[mot_word_id]`** | Vẫn giữ `mispronunciation_count = 1` để báo cáo trung thực, **đồng thời đổi trạng thái luyện sang `COMPLETED` (xanh)** |

---

## 3. Bảng đo giảm thao tác & Độ nhạy thu âm thực tế (UX Friction & Latency Audit)

| Chỉ số | Quy trình cũ (Trước nâng cấp) | Quy trình sau QA Audit & Fix | Bằng chứng đo trực tiếp |
| --- | --- | --- | --- |
| **Số lần đọc đúng cần thiết để hoàn thành từ** | `2` lần đọc đúng liên tiếp (`required_consecutive_correct = 2`) | **`1` lần** (`REQUIRED_CONSECUTIVE_CORRECT = 1`) | [difficult_words_service.py](file:///F:/c1/capstone1/backend/app/services/difficult_words_service.py) |
| **Số tap/click cho trẻ để mở và đọc liên tiếp 2 từ** | `Mở từ (1) -> Bắt đầu (1) -> Dừng (1) -> Lưu/Xong (1) -> Đọc lại lần 2 (+2)` và tự bấm chuyển từng từ | **Mở thẻ/từ (1) + Bắt đầu luyện (1) = `2` tap cho cả chuỗi 2+ từ (`0` tap khi dừng, `0` tap sang từ kế tiếp)** | [real-parent-reports-ui.test.tsx](file:///F:/c1/capstone1/frontend/test/real-parent-reports-ui.test.tsx) (`2` taps cho `"một"` → `"bông"` = `100%`) |
| **Thời gian auto-stop khi nói `"một"` trên Chromium VAD thật** | Kẹt từ `3.5s–12s` (hoặc treo tới `6.5s` `maxCaptureMs` do bug sticky-latch vừa phát hiện) | **`~2.5s` toàn chu trình 1 từ** (`intro TTS + getUserMedia + 420ms burst + 520ms VAD silence + POST /evaluate`) và **`~5.7s` trọn vẹn 2 từ liên tiếp** | Playwright [difficult-words.pw.ts](file:///F:/c1/capstone1/frontend/test/browser/difficult-words.pw.ts): `desktop` `word1ElapsedMs = 2507ms`, `totalTwoWordMs = 5738ms`; `mobile` `word1ElapsedMs = 2475ms`, `totalTwoWordMs = 5760ms` |
| **Số request mạng khi chấm 1 lượt** | `2` request (`/practice/start` → `/evaluate-audio`) | **`1` request** (`POST /system/difficult-words/{child_id}/practice/evaluate`) | [system.py](file:///F:/c1/capstone1/backend/app/api/routes/system.py) & [difficult-word-service.ts](file:///F:/c1/capstone1/frontend/lib/api/difficult-word-service.ts) |
| **Khả năng chống lỗi `503`** | Crash `503` nếu DB thiếu bảng `difficult_word_practice_attempts` | **Dual-store fallback** ghi/đọc trên `readingevents` (`Type='WORD_RETRY'`) | [test_difficult_words.py](file:///F:/c1/capstone1/backend/test_difficult_words.py) (`persistence_backend == "READING_EVENT"`) |

---

## 4. Bảng kiểm chứng độ nhạy & chống nhận vơ cho từ `"một"` (`context_phrase = "Bé có một bông hoa."`)

| Kịch bản đầu vào (Âm thanh / Transcript STT) | Kỳ vọng | Kết quả Backend (`difficult_words_service.py`) | Kết quả Frontend (`word-mot-qa-audit.test.tsx`) | Ghi chú |
| --- | --- | --- | --- | --- |
| Nói `"một"` sớm ở `t = 40ms` trong mode `"short-word"` | Không nhiễm `noiseFloorRms`, giữ `speechDurationMs >= 60ms` | — | **PASS** (`noiseFloor <= 0.008`, `hasShortWordBlockingAudioIssue === false`) | Kẹp mẫu onset `rms >= 0.015` trong `calibrationWindowMs = 60ms` |
| Giọng trẻ nhỏ nhẹ (`LOW_VOLUME`, `rms ~ 0.006`, `260ms`) | Đi qua Pass 1 STT, chấm **`CORRECT`** | **PASS (`CORRECT`)** | **PASS (`CORRECT`)** | Không bị `AUDIO_QUALITY_GATE` chặn oan |
| Browser Web Speech im lặng hoàn toàn (`SpeechRecognition = undefined`) | Acoustic VAD vẫn bắt onset và tự ngắt qua `postSpeechSilenceMs` | — | **PASS** (Vitest `A1` `1586ms` + Playwright `6/6`) | Chống trượt âm đơn 1 âm tiết của Web Speech |
| `"một"`, `"Một."` | **`CORRECT`** | **PASS** | **PASS** | Chuẩn hóa NFC + giữ nguyên thanh điệu |
| `"[tiếng đập] một"` | **`CORRECT`** | **PASS** | **PASS** | Tách sạch nhãn tiếng động nền `_NON_SPEECH_TAG_RE` |
| `"một một"` | **`CORRECT`** | **PASS** | **PASS** | Gộp echo lặp liên tiếp |
| `"một bông hoa"`, `"bé có một bông hoa"` (có `context_phrase`) | **`CORRECT`** | **PASS** | **PASS** | Khớp chuỗi con liên tiếp (`5..10` token) trong câu gốc |
| `"mốt"`, `"mọt"`, `"bột"`, `"tốt"`, `"hột"` | **`INCORRECT`** | **PASS (5/5 `INCORRECT`)** | **PASS (5/5 `INCORRECT`)** | Giữ nghiêm thanh điệu, vần và phụ âm đầu tiếng Việt |
| `"một hai ba bốn năm"` (kể cả khi truyền `context_phrase`) | **`UNCERTAIN`** (Không nhận vơ) | **PASS (`UNCERTAIN`)** | **PASS (`UNCERTAIN`)** | Không xuất hiện liên tiếp trong câu `"Bé có một bông hoa."` |
| `"[tiếng đập]"`, `""`, `SILENCE` | **`NO_CLEAR_AUDIO` / `NOT_RECOGNIZED`** | **PASS (`NO_CLEAR_AUDIO`)** | **PASS (`NOT_RECOGNIZED`)** | Nhắc bé đọc lại nhẹ nhàng, **không cộng lần sai** |

---

## 5. Lỗi thực tế phát hiện được & đã tự động khắc phục ngay trong quá trình Audit

1. **Bug nghiêm trọng: Sticky Speech Latch làm kẹt bộ đếm im lặng đến `6.5s` (`maxCaptureMs`)**:
   - **Phát hiện khi test**: Khi chạy `Scenario A1` và test auto-stop không bấm `"Dừng ghi âm"`, nhận diện giọng nói không tự ngắt sau ~1.2s mà bị treo chờ quá timeout `4s`.
   - **Nguyên nhân**: Trong [word-practice-engine.ts](file:///F:/c1/capstone1/frontend/lib/reading/word-practice-engine.ts), `hasShortWordSpeechActivity` kiểm tra `input.hasLiveBrowserSpeech` (nhưng caller lại truyền biến dính `speechObservedRef.current`) và `(input.quality?.speechDurationMs ?? 0) >= 50` (biến đếm tích lũy luôn `>= 50` suốt phần còn lại của đoạn ghi âm). Điều này làm `active = true` mãi mãi, reset `silenceStartedAt = null` liên tục.
   - **Khắc phục**: Chuyển `hasShortWordSpeechActivity` sang chỉ xét hoạt động **tức thời** (`isSpeakingNow`, `quality.isSpeaking`, live `quality.rms >= 0.015`, xung `browserPulse` mới nhất, hoặc `speechDurationMs > previousSpeechDurationMs`; chỉ dùng `speechDurationMs >= 50` khi `!speechObserved`), cập nhật đồng bộ tại [difficult-word-practice-panel.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-word-practice-panel.tsx) và [reading-screen.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-screen.tsx).

2. **Thiếu tự động mở micro ở từ tiếp theo (`autoStart`) khi luyện nhiều từ liên tiếp**:
   - **Phát hiện khi kiểm toán UX**: Sau khi hoàn thành `"một"` và tự động chuyển sang `"bông"` sau `1100ms`, panel luyện từ trở về `IDLE`, buộc trẻ/phụ huynh phải bấm lại `"Bắt đầu luyện"` cho mỗi từ tiếp theo.
   - **Khắc phục**: Bổ sung luồng `autoStart` với guard StrictMode trong `difficult-words-screen.tsx` → `difficult-word-practice-panel.tsx` khi chuyển từ tự động sau kết quả `CORRECT`.

3. **Thiếu khớp cụm đọc tự nhiên dài > 4 tiếng nằm đúng trong câu nguồn (`"bé có một bông hoa"`)**:
   - **Phát hiện khi viết ma trận test `"một"`**: Trước đây mọi transcript `> 4` token đều trả `"UNCERTAIN"`, kể cả khi bé đọc trọn câu `"bé có một bông hoa"`.
   - **Khắc phục**: Truyền `context_phrase` (`Form` param ở `/practice/evaluate` và `resolveRetrySentenceContext` ở `ReadingScreen`), chấp nhận `CORRECT` cho `5..10` token **khi và chỉ khi** toàn bộ cụm đọc là chuỗi con liên tiếp hợp lệ nằm trong câu nguồn, đồng thời vẫn khóa chặt các câu đếm/nói lạc đề như `"một hai ba bốn năm"` ở trạng thái `UNCERTAIN`.
