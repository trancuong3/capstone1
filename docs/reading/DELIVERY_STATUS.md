# ViRead — Luồng đọc tự động: DELIVERY STATUS

> Tài liệu bàn giao & checkpoint sống. Mọi số liệu bên dưới đều đến từ lệnh chạy thật có bằng chứng lưu trong `docs/reading/evidence/`. Không đánh dấu đạt cho cổng `BLOCKED`.

## 0. Định danh bàn giao

| Mục | Giá trị |
|---|---|
| Repo | `https://github.com/trancuong3/capstone1` (remote `origin`) |
| Worktree / Branch | `F:\c1\capstone1-reading-auto` (`feat/reading-autopilot-20261121`) |
| Base commit | `aafa3966f75b0d4671eec49ff0b5550668f2d998` (`origin/main` cục bộ) |
| Delivery code SHA (đã chạy toàn bộ cổng cuối) | `a30a5e0e` (commit kế tiếp chỉ cập nhật tài liệu bàn giao & file bằng chứng này) |
| Công việc chưa commit của người dùng | Nằm nguyên vẹn tại `F:\c1\capstone1` (không bị đụng tới). |
| Python ABI pins | Không thay đổi (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`). |
| Chi phí phát sinh | 0 đồng. Không gọi provider trả phí, không gửi email thật (dùng local `.eml` mail sink). |

## 1. Bảng cổng nghiệm thu (G1–G18 — ngưỡng đã khóa trước khi sửa)

| ID | Cổng | Ngưỡng đã khóa | Kết quả thực đo trên SHA `a30a5e0e` | Trạng thái | Bằng chứng |
|---|---|---|---|---|---|
| G1 | Tô đúng nhầm (false-correct) | `= 0` (tuning & holdout) | Tuning: **0/157** (cũ: 8). Holdout: **0/139** (cũ: 5). | **PASS** *(synthetic transcript-level)* | `after-autopilot-tuning.json`, `final-autopilot-holdout.json` |
| G2 | Tô sai nhầm (false-wrong) | Fluent `= 0`; tổng `≤ 2%` | Tuning: Fluent **0**, tổng **0/157 (0%)** (cũ: 24/157 = 15.3%). Holdout: Fluent **0**, tổng **0/139 (0%)**. | **PASS** *(synthetic transcript-level)* | `after-autopilot-tuning.json`, `final-autopilot-holdout.json` |
| G3 | Tô lệch từ (duplicate-words) | `= 0` | Tuning: **0**. Holdout: **0**. | **PASS** *(synthetic transcript-level)* | `alignment-gates.test.ts` (3/3) |
| G4 | Tô xanh do tiếng TTS / đuôi vọng | `= 0` | Tuning echo: **0** (cũ: 5). Holdout echo: **0** (cũ: 5). RTL + Playwright E2E desktop/mobile: **0**. | **PASS** | `final-autopilot-holdout.json`, `reading-automation-screen.test.tsx`, `reading-autopilot.pw.ts` |
| G5 | Số lần bấm sau Bắt đầu + cấp quyền (ca đọc trơn, tự chuyển trang bật) | `= 0` lần bấm | **0 lần bấm** qua 2 trang đọc trơn (RTL + Playwright desktop 1440×1000 & mobile 390×844). | **PASS** | `reading-automation-screen.test.tsx`, `e2e-autopilot-fluent-{desktop,mobile}.png` |
| G6 | Ngắt lời nhầm khi bé đang nói / ngắt hơi hợp lý | `= 0` | **0** trên toàn bộ kịch bản fake-clock (nhanh/chậm/ngắt câu/tách âm tiết). | **PASS** | `reading-automation.test.ts` (70/70, soak 3×) |
| G7 | Độ trễ từ ý định "xin giúp" tới lệnh đọc mẫu (điều phối) | `≤ 300 ms` (p95 fake clock) | **0 ms** dispatch điều phối (ngay chu kỳ tick); độ trễ I/O TTS thật tách riêng ở G17. | **PASS** *(logic điều phối)* | `reading-automation.test.ts` |
| G8 | Chuyển trang nhầm / hoàn tất 2 lần / lưu trùng | `= 0` (cả đảo thứ tự sự kiện) | **0** trên 40 ca property-style đảo thứ tự + RTL + E2E. | **PASS** | `reading-automation.test.ts` (70/70) |
| G9 | Từ bỏ qua / được đọc mẫu không tô xanh, ghi "Cần luyện lại" (`assisted`) | `= 0` sai | Thang 4 bước (`word → 0.8x slow word → phrase → encourage + giveUp`); từ được giúp hiển thị `assisted` (gạch chấm + `♪` + label ẩn), không tô xanh `CORRECT`. | **PASS** | `reading-automation-screen.test.tsx`, `e2e-autopilot-assisted-{desktop,mobile}.png` |
| G10 | Lưu thất bại: không chuyển trang mất tiến độ, retry idempotent, khôi phục sau reload | Pass toàn bộ ca | Khi `completeCurrentPage` lỗi 503 → ở lại trang 1, báo **Chưa lưu**, retry thành công không trùng, reload giữ đúng trang 2. | **PASS** | `reading-automation-screen.test.tsx`, `reading-autopilot.pw.ts` |
| G11 | Presence → email: 0 email ở ca cúi/quay đầu/che camera/nền/camera lỗi/hết phiên/opt-out/email chưa xác minh/sai chủ phiên/hết hạn | `0` email | **0 email** trên 30 ca frontend `presence-monitor.test.ts` + 25 ca backend `test_reading_presence.py` + 14 ca PostgreSQL/HTTP. | **PASS** | `presence-monitor.test.ts`, `test_reading_presence.py`, `test_reading_presence_postgres_integration.py` |
| G12 | Presence → email: ca hợp lệ | **đúng 1 email** (đồng thời, retry, worker restart) | **Đúng 1 file `.eml`** trong mail sink (unique `(sessionid, episodeid)` + `FOR UPDATE SKIP LOCKED` + `UNKNOWN_DELIVERY` crash recovery trên PostgreSQL 16 thật). | **PASS** | `test_reading_presence_postgres_integration.py` (14/14), 3× soak `test_reading_presence.py` |
| G13 | Nội dung email | Trung tính ("ViRead đã tạm dừng vì một lúc không thấy người đọc trong khung hình"), không sách/transcript/ảnh | Đã kiểm chứng trên file `.eml` thật trong mail sink; schema API `extra="forbid"` từ chối mọi trường ảnh/audio/email từ client. | **PASS** | `test_reading_presence.py`, `test_reading_presence_postgres_integration.py` |
| G14 | Phụ huynh tắt riêng được 3 tùy chọn | Pass UI + service | 3 công tắc độc lập: **Hỗ trợ tự động** (mặc định BẬT), **Tự chuyển trang** (mặc định BẬT), **Nhắc ba mẹ qua email** (mặc định TẮT, lưu server). | **PASS** | `reading-automation-settings.test.tsx` (7/7), `e2e-autopilot-settings-{desktop,mobile}.png` |
| G15 | Lint, typecheck, build, unit, integration | Exit 0 trên SHA bàn giao | `eslint .` (0), `tsc --noEmit` (0), `next build --webpack` (0, 38/38 routes), `vitest tests/reading` (41/41 files, 552 passed, 0 failed), frontend soak 3× (333/333), backend pytest + Postgres (262 passed, 86 subtests, 0 failed), backend soak 3× (75/75). | **PASS** | `final-reading-vitest.log`, `final-backend-pytest.log` |
| G16 | Playwright E2E + PostgreSQL/HTTP thật | Chạy được | Playwright desktop (1440×1000) & mobile (390×844): **8/8 PASS** (56.5s) với fixture API + 6 ảnh chụp thật; Backend HTTP + PostgreSQL 16 thật + mail sink: **14/14 PASS**. *(Chưa chạy Playwright nối trực tiếp live FastAPI + Supabase Auth do không có Supabase Auth cục bộ).* | **PASS (tách lớp)** | `reading-autopilot.pw.ts`, `test_reading_presence_postgres_integration.py`, `e2e-autopilot-*.png` |
| G17 | Benchmark STT/TTS thật (clip giọng trẻ/người lớn được phép dùng, đo WER/CER thật & p50/p95 I/O) | Số mẫu/lần lặp thực tế | **Chưa chạy.** Không có clip giọng trẻ được cấp phép trong repo/máy; ElevenLabs cần credit trả phí (ràng buộc chi phí 0đ). **Không** tuyên bố chuẩn giọng trẻ từ benchmark synthetic. | **BLOCKED** | Điều kiện tối thiểu: cung cấp tập clip tiếng Việt có phép (tách tuning/holdout + ground truth) và/hoặc STT/TTS local/API được phép dùng. |
| G18 | Nghiệm thu thiết bị Android thật (loa/mic/camera/WebView/nền) | Thiết bị đã cấp quyền ADB | **Chưa chạy.** Máy Windows không có `adb` và không có điện thoại Android kết nối. | **BLOCKED** | Điều kiện tối thiểu: kết nối điện thoại Android bật USB Debugging + cài `adb` + cấp quyền mic/camera. |

## 2. Bảng đo trước / sau (Synthetic Transcript-Level — không phải WER/CER audio thật)

> **Lưu ý trung thực:** Kết quả dưới đây đo lớp căn chỉnh + lọc tiếng vọng + lọc ngoài bài + chấm trạng thái trên chuỗi transcript tổng hợp (24 ca tuning / 157 từ; 20 ca holdout giữ riêng chạy **1 lần duy nhất** / 139 từ). Đây **không** phải đo WER/CER nhận diện giọng nói trẻ thật.

| Nhóm tình huống | Tuning (Legacy → Autopilot) | Holdout 1-shot (Legacy → Autopilot) |
|---|---|---|
| `fluent` (đọc trơn) | 0/18 → **0/18** lỗi | 0/16 → **0/16** lỗi |
| `self-correct` (tự sửa) | 4 false-wrong → **0** | 0 → **0** |
| `restart` (đọc lại đầu câu) | 5 false-wrong → **0** | 0 → **0** |
| `off-topic` (TV / nói ngoài bài) | 3 false-correct, 14 false-wrong → **0, 0** | 0 → **0** |
| `echo` (vọng TTS & bắt chước sau mẫu) | 5 false-correct → **0** | 5 false-correct → **0** |
| `unicode-number` (số ↔ chữ, NFC) | 1 false-wrong → **0** | 0 → **0** |
| `duplicate-words` / `skip` / `wrong` / `repeat` / `pause` / `uncertain` | 0 → **0** | 0 → **0** |
| **Tổng cộng** | **8 false-correct, 24 false-wrong (10/24 ca trượt) → 0, 0 (24/24 ca PASS)** | **5 false-correct, 0 false-wrong (3/20 ca trượt) → 0, 0 (20/20 ca PASS)** |

## 3. Lệnh tái lập trên SHA `a30a5e0e`

```powershell
# 1. Frontend lint, typecheck, production build (worktree junction dùng --webpack)
cd F:\c1\capstone1-reading-auto\frontend
npm run lint
npm run typecheck
$env:NEXT_PUBLIC_SUPABASE_URL="https://example.supabase.co"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_test"
$env:NEXT_PUBLIC_API_URL="http://127.0.0.1:8000"
npx next build --webpack

# 2. Frontend unit/integration (41 files, 552 tests) + Holdout benchmark (1-shot)
npx vitest run tests/reading --maxWorkers=2
$env:READING_BENCH_HOLDOUT="1"
$env:READING_BENCH_OUT_DIR="F:\c1\capstone1-reading-auto\docs\reading\evidence"
npx vitest run tests/reading/benchmark/alignment-gates.test.ts

# 3. Playwright E2E (desktop 1440x1000 + mobile 390x844, 8/8 tests)
$env:PLAYWRIGHT_ROUTE_FILTER="/reading"
npx playwright test --config=playwright.real-data.config.ts test/browser/reading-autopilot.pw.ts

# 4. Backend unit + real PostgreSQL HTTP/worker/mail-sink/RLS integration (262 tests, 86 subtests)
cd F:\c1\capstone1-reading-auto\backend
$env:READING_PRESENCE_TEST_DATABASE_URL="postgresql+asyncpg://postgres@127.0.0.1:<PORT>/postgres"
F:\c1\capstone1\.venv\Scripts\python.exe -m pytest test_reading_presence.py test_reading_presence_postgres_integration.py test_reading_reminder_worker.py test_alignment.py test_reading_assessment.py test_reading_comparison_repository.py test_reading_comparison_service.py test_reading_content_service.py test_reading_history.py test_reading_input_safety.py test_reading_management.py test_reading_management_rules.py test_reading_practice_state.py test_reading_progress.py test_reading_revision_image.py test_voice.py test_voice_studio.py test_migration_versions.py -q
```

## 4. Hướng dẫn cài đặt cho phụ huynh

1. Mở màn hình đọc sách và bấm nút **Giọng đọc** trên thanh điều khiển (hoặc ở trạng thái sẵn sàng trước khi đọc).
2. Trong hộp thoại cài đặt, phụ huynh có thể **bật/tắt độc lập 3 tùy chọn**:
   - **Hỗ trợ tự động** *(mặc định BẬT)*: Tự động đọc mẫu khi bé ngập ngừng lâu theo thang 4 bước (đọc mẫu từ → đọc chậm hơn → đọc cụm từ → động viên & cho qua, lưu vào mục cần luyện lại). Khi tắt, máy không tự chen lời khi bé im lặng nhưng vẫn hỗ trợ ngay nếu bé nói *"con không biết"* hoặc *"đọc mẫu giúp con"*.
   - **Tự chuyển trang** *(mặc định BẬT)*: Tự động lưu và sang trang tiếp theo sau khi bé hoàn thành trang hiện tại. Khi tắt, bé chủ động bấm *"Đánh dấu trang đã đọc xong"*.
   - **Nhắc ba mẹ qua email** *(mặc định TẮT)*: Khi bật, ứng dụng xin quyền camera một lần và chỉ phân tích hiện diện cục bộ trên thiết bị (không lưu/gửi ảnh, âm thanh hay nội dung sách). Nếu buổi đọc đang diễn ra mà không thấy người đọc liên tục đủ lâu, máy sẽ nhắc nhẹ, tạm dừng đúng vị trí và gửi **đúng 1 email trung tính** tới email đã xác minh của phụ huynh. Phụ huynh có thể tắt bất kỳ lúc nào để hủy ngay các thông báo đang chờ.
3. Chạy worker gửi nhắc (môi trường test dùng local mail sink bằng biến `READING_PRESENCE_MAIL_SINK_DIR`):
   ```powershell
   python -m app.jobs.reading_presence_alert_worker
   ```

---

## 5. Đợt nâng cấp 2 — Baseline & Cổng nghiệm thu mở rộng (G19–G24 — KHÓA trước khi sửa)

### 5.1 Baseline đo trước khi sửa (trên SHA `1ab03803`)
1. **Highlight thời gian thực (`BookPageContent`, trang 120 từ, 30 gói interim liên tiếp):**
   - `p50 = 28.48 ms`, `p95 = 41.35 ms` trong jsdom (`tests/reading/benchmark/highlight-latency.test.tsx`).
   - Toàn bộ **120/120 từ** re-render mỗi gói interim (chưa `React.memo`), `page.text.matchAll(/\S+/gu)` và `querySelectorAll("[data-word-id]")` chạy lại trên từng lần cập nhật; trong `ReadingScreen` mỗi interim tạo 3 `setState` (`previewSnapshot`, `currentWordId`, `latestTranscript`).
2. **Đánh vần tiếng Việt lớp 1:** chưa có bộ nhận diện chuỗi đánh vần (`"ô i ôi tờ ôi tôi"`, `"cờ a ca sắc cá"`). Với engine hiện tại, chuỗi 3–6 tiếng đánh vần bị `isOffTopic` loại bỏ (tỷ lệ khớp < 0.5) hoặc bị chấm `SUBSTITUTE` oan.
3. **Đọc lại trọn câu sau khi luyện từ khó/sai:** chưa có bước mời bé đọc lại trọn câu (ví dụ `"Tôi ăn cơm"`) sau khi hoàn tất luyện từ `"Tôi"`.
4. **Câu hỏi đọc hiểu cuối bài (`ComprehensionQuestion`):** chưa có TTS đọc câu hỏi/đáp án, chưa có mic/STT; bé phải bấm tối thiểu **6 lần** cho 3 câu hỏi (chọn đáp án + bấm tiếp × 3).
5. **Thu âm giọng trẻ & ngữ cảnh trang sách:** `AudioQualityMonitor` chế độ `passage` dùng `minPeakRms = 0.008`, `hangoverMs = 350 ms` (dễ coi giọng bé nói nhỏ hoặc ngắt hơi đánh vần là `LOW_VOLUME`/dứt câu); `transcribeRecording` ở chế độ đọc đoạn chưa truyền `keyterms` từ trang sách hiện tại.

### 5.2 Cổng nghiệm thu đợt 2 (G19–G24 — Kết quả thực đo trên SHA `4f097c40`)

| ID | Cổng | Ngưỡng đã khóa (pass nếu) | Kết quả thực đo trên SHA `4f097c40` | Trạng thái | Bằng chứng |
|---|---|---|---|---|---|
| G19 | Đánh vần tiếng Việt lớp 1 | ≥ 25 ca test (6 thanh, âm đầu/vần phổ biến, đánh vần chậm/sai/nhiễu): **100%** chấp nhận đánh vần đúng kết thúc bằng tiếng đích, **0** false-positive trên đánh vần rác/ngoài bài, không ngắt lời khi đang đánh vần | **44/44 PASS** trong `phonics-spelling.test.ts` (20 mẫu đánh vần đủ 6 thanh, 7 ca từ chối sai thanh/ngoài bài = 0 false-positive, 5 ca tích hợp engine đa chunk/preview) + ca màn đọc thực tế giữ im timer 10s khi đang đánh vần `"ô i ôi"` → `"tờ ôi tôi ăn cơm"`. | **PASS** | `phonics-spelling.test.ts`, `reading-automation-screen.test.tsx` |
| G20 | Đọc lại trọn câu sau luyện từ khó/sai | Sau luyện từ (đúng lại hoặc hết lượt), mời đọc lại trọn câu 2–12 từ (hoặc mệnh đề nếu câu dài), tối đa 1 lượt/câu, cho qua/bỏ qua; **0** ghi đè lượt đầu, **0** báo cáo trùng | **6/6 PASS** trong `sentence-reinforcement.test.ts` + ca `ReadingScreen` `"Tôi ăn cơm. Mẹ nấu canh."`: mời đọc lại câu `"Tôi ăn cơm."`, chấp nhận đánh vần khi đọc lại, tối đa 1 lượt/câu, có nút `"Bỏ qua đọc lại câu"`, **0** ghi đè điểm lượt đầu. | **PASS** | `sentence-reinforcement.test.ts`, `reading-automation-screen.test.tsx` |
| G21 | Highlight thời gian thực siêu mượt | Trang 120 từ / 30 gói interim: `p95 ≤ 50 ms`, chỉ re-render từ đổi trạng thái (≤ 3 từ/gói thay vì 120), **0** màu xanh oan từ interim đổi | **Trước:** `p50 = 28.48 ms`, `p95 = 41.35 ms`, `120` token/gói. **Sau:** **`p50 = 6.07 ms`** (nhanh hơn **4.7×**), **`p95 = 8.56 ms`** (nhanh hơn **4.8×**), **`maxRendersPerStep = 2`** (giảm **60×** số token render). Đẩy con trỏ tạm tiến trước sang từ kế tiếp tức thời; tối ưu cả `BookPageViewer` overlay + rút ngắn restart recognizer `200ms → 80ms`. | **PASS** | `highlight-latency.test.tsx`, `book-page-viewer.test.tsx` (12/12) |
| G22 | Tối ưu VAD giọng trẻ & `keyterms` trang sách | Giọng nhỏ (`RMS 0.005–0.0075`) & ngắt hơi đánh vần (`~450 ms`) không bị phạt nhầm; `transcribeRecording` gửi `keyterms` an toàn theo trang; **100%** test chống "đọc hộ" vẫn PASS | Thêm chế độ `child-passage` (`minPeakRms = 0.0045`, `hangoverMs = 480ms`, `calibrationWindowMs = 180ms`) + gửi `keyterms` (tối đa 40 từ NFC duy nhất của trang hiện tại) trong `transcribeRecording`. **10/10** `audio-quality.test.ts` + **75/75** `reading-screen.test.tsx` (gồm toàn bộ ca chống đọc hộ/off-topic/wrong-language/low-confidence) PASS. | **PASS** | `audio-quality.test.ts`, `reading-screen.test.tsx` |
| G23 | Giọng đọc mẫu đa dạng & lời thoại tương tác | Kho lời thoại ấm áp xoay vòng không lặp liên tiếp, có giới hạn tần suất; bộ chọn giọng hỗ trợ lọc/gắn nhãn rõ nhóm giọng thân thiện lớp 1 từ metadata thật | `InteractivePromptSelector` xoay vòng 13 nhóm lời thoại ấm áp, chống lặp liên tiếp, giới hạn tần suất khen (`25s/15s`). Thêm preset tốc độ `"Chậm rõ (Lớp 1)"` (`0.75×`) và bộ lọc `"Giọng trẻ em"` thuần metadata trong `ReadingVoiceSettings`. | **PASS** | `interactive-prompts.test.ts` (3/3), `reading-voice-settings.test.tsx` (12/12) |
| G24 | Câu hỏi đọc hiểu cuối bài bằng giọng nói | **0 lần bấm nút bắt buộc** qua 3 câu hỏi (tự đọc câu hỏi + đáp án A/B/C kèm highlight → hỏi *"Bé chọn đáp án nào?"* → chặn 100% echo → nhận giọng A/B/C, biến thể tiếng Việt hoặc nội dung đáp án → tự chọn, phản hồi & qua câu kế → hoàn tất); bấm tay chen ngang hủy ngay TTS và chọn tức thì; 100% test cũ vẫn PASS | **0 lần bấm** qua 3 câu hỏi trên cả RTL (`comprehension-voice-flow.test.tsx`, **14/14 PASS**) và Playwright E2E desktop 1440×1000 & mobile 390×844 (**10/10 PASS**); chặn 100% echo đáp án vừa đọc; chạm tay chen ngang hủy TTS cũ ngay lập tức; `comprehension-question-flow.test.tsx` cũ **4/4 PASS**. | **PASS** | `comprehension-voice-flow.test.tsx`, `reading-autopilot.pw.ts`, `e2e-autopilot-quiz-voice-{desktop,mobile}.png` |

### 5.3 Bảng so sánh Trước / Sau (Đợt nâng cấp 2 — SHA `1ab03803` → `4f097c40`)

| Chỉ số | Trước (SHA `1ab03803`) | Sau (SHA `4f097c40`) |
|---|---|---|
| Độ trễ DOM highlight (120 từ, 30 gói interim) | `p50 = 28.48 ms`, `p95 = 41.35 ms` | **`p50 = 6.07 ms` (-78.7%), `p95 = 8.56 ms` (-79.3%)** |
| Số token re-render mỗi gói interim | `120 / 120` từ | **`2 / 120` từ (giảm 60×)** |
| Độ trễ restart `SpeechRecognition` sau `onend` | `200 ms` | **`80 ms` (nhanh hơn 2.5×)** |
| Chấp nhận đánh vần lớp 1 (`ô i ôi tờ ôi tôi`, `cờ a ca sắc cá`, ...) | `0%` (bị loại off-topic hoặc phạt sai) | **100% (20/20 mẫu đủ 6 thanh), 0 false-positive (7/7 ca nhiễu/sai thanh)** |
| Đọc lại trọn câu sau khi luyện từ sai/khó (`Tôi ăn cơm.`) | Chưa có | **Tự mời 1 lượt/câu, giữ nguyên điểm lượt đầu, có nút bỏ qua** |
| Số lần bấm bắt buộc ở 3 câu hỏi đọc hiểu cuối bài | `6` lần bấm | **`0` lần bấm (tự đọc câu hỏi + A/B/C + nghe giọng bé + tự qua câu), vẫn chạm tay bất cứ lúc nào** |
| Tổng kiểm thử tự động trên SHA `4f097c40` | 41 file / 552 tests, 8 Playwright E2E | **46 file / 623 tests PASS (0 fail), holdout 3/3 PASS, 10/10 Playwright E2E PASS, 248 backend tests + 86 subtests PASS, lint/typecheck/build exit 0** |

### 5.4 Lệnh tái lập Đợt 2 (SHA `4f097c40`)

```powershell
cd F:\c1\capstone1-reading-auto\frontend
npm run lint
npm run typecheck
$env:NEXT_PUBLIC_SUPABASE_URL="https://example.supabase.co"
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_test"
$env:NEXT_PUBLIC_API_URL="http://127.0.0.1:8000"
npx next build --webpack
npx vitest run tests/reading --maxWorkers=2
$env:READING_BENCH_HOLDOUT="1"
npx vitest run tests/reading/benchmark/alignment-gates.test.ts
$env:PLAYWRIGHT_ROUTE_FILTER="/reading"
npx playwright test --config=playwright.real-data.config.ts test/browser/reading-autopilot.pw.ts
```


---

## 6. Đợt nâng cấp 3 — Sư phạm Lớp 1, Đánh vần thực chiến & Tương tác cảm xúc (G25–G29 — KHÓA trước khi sửa)

> Đặc tả sư phạm & kỹ thuật chi tiết: `docs/reading/GRADE1_PEDAGOGY_AND_PHONICS_SPEC.md`.

### 6.1 Baseline thực trạng trước khi sửa (trên SHA `5f0c9d58`)
1. **Đánh vần thực chiến (`"ê tờ ê tê"`, biến âm STT & tách gói rời):**
   - `RealtimeAlignmentEngine.addFinalTranscript` chưa có `SpellingBuffer` liên đoạn: khi bé đọc rời 4 gói `isFinal` (`"ê"` → `"tờ"` → `"ê"` → `"tê"`) hoặc STT nghe `"tờ"` thành `"tơ"` / `"ê"` thành `"ế"`, các âm đệm lọt vào `pendingToken` và làm nổ `SUBSTITUTE` (đỏ) trước khi bé ghép xong tiếng `"tê"`.
   - `hasUsableBrowserConfidence >= 0.50` loại bỏ các âm đánh vần đơn lẻ có `confidence` `0.28–0.49` từ Web Speech API (`vi-VN`).
   - `classifyRetryTranscript` chặn cứng `> 4 tokens` nên từ chối chuỗi đánh vần trong chế độ luyện lại từ sai (`retry mode`).
2. **Tương tác cảm xúc khi bé đọc sai (`SUBSTITUTE`):**
   - Khi bé đọc sai 1 từ và dừng lại, ứng dụng chỉ chờ timer im lặng `~9.000 ms` rồi nói câu ngắn `"Cô đọc mẫu cho con nhé."` — chưa có phản hồi vỗ về tức thì (~1.4s), chưa phân biệt lỗi dấu thanh / lỗi âm gần / lỗi lúng túng, chưa có hàm đánh vần mẫu từng bước `generateSpokenPhonicsGuide(word)` chuẩn SGK Lớp 1, và chưa có bong bóng nhân vật đồng hành cảm xúc.

### 6.2 Bảng cổng nghiệm thu đợt 3 (G25–G29 — KHÓA trước khi sửa code)

| ID | Cổng | Ngưỡng đã khóa (pass nếu) | Kết quả thực đo | Trạng thái | Bằng chứng |
|---|---|---|---|---|---|
| G25 | Đánh vần thực chiến Lớp 1 & chịu lỗi biến âm STT (`phonics-spelling.ts`) | `≥ 50` ca test trong `phonics-spelling.test.ts` (đủ vần trước–âm đầu sau `"ê tờ ê tê"`, `"a cờ a ca sắc cá"`, `"ô i ôi tờ ôi tôi"`, `"ơ mờ ơm cờ ơm cơm"`; âm đầu trước–vần sau; lặp/ngập ngừng; biến âm STT `"ê tơ ê tê"`, `"ế tờ ê tê"`): **100%** chấp nhận đánh vần đúng, **0** false-positive trên từ ngoài bài hoặc sai thanh cuối (`"ê tờ ê tề"` cho `"tê"` & `"ma"` đơn lẻ cho `"má"` bị từ chối 100%) | *Đang triển khai* | **PENDING** | `phonics-spelling.test.ts` |
| G26 | Bộ đệm `SpellingBuffer` liên đoạn, confidence âm đánh vần & đồng bộ `retry mode` | Tách 3–6 gói `isFinal` rời (`"ê"` / `"tờ"` / `"ê"` / `"tê"` trong cửa sổ 6s, kể cả `confidence 0.30–0.49`) không nổ `SUBSTITUTE` đỏ giữa chừng, không bị `isOffTopic` loại; đồng bộ 100% sang `classifyRetryTranscript` (`retry mode`) & `SentenceReinforcementTracker` | *Đang triển khai* | **PENDING** | `phonics-spelling.test.ts`, `retry-word-recognition.test.ts`, `reading-automation-screen.test.tsx` |
| G27 | An ủi nhiều câu ấm áp tức thì (~1.4s) theo đúng nhóm lỗi khi bé đọc sai | Xóa bỏ im lặng 9s khi bé đọc sai: chờ nhịp tự sửa ngắn `~1.4s` (nếu tự sửa ngay thì không cắt lời); nếu chưa sửa → phát lời an ủi nhiều câu đúng nhóm lỗi (**Nhóm A dấu thanh ≥ 8 mẫu**, **Nhóm B âm gần ≥ 8 mẫu**, **Nhóm C lúng túng ≥ 10 mẫu**), không lặp câu liên tiếp, `EchoGuard` chặn **100%** tiếng cô giáo | *Đang triển khai* | **PENDING** | `empathetic-reading-flow.test.tsx` |
| G28 | Cô giáo đánh vần mẫu từng bước (`generateSpokenPhonicsGuide`), bong bóng đồng hành & chế độ hướng dẫn | Lần sai 2 phát câu đánh vần từng âm chuẩn SGK Lớp 1 + mẫu chậm `0.75×`; hết lượt (lần 4) khen nỗ lực nhiều câu + lưu `assisted` (không tô xanh lượt đầu) + đọc lại trọn câu; bong bóng đồng hành đồng bộ lời nói không che chữ/không giật layout; cài đặt phụ huynh chọn được **Dịu dàng chi tiết (Lớp 1)** vs **Ngắn gọn (Đọc thạo)** | *Đang triển khai* | **PENDING** | `empathetic-reading-flow.test.tsx`, `reading-automation-settings.test.tsx`, `reading-autopilot.pw.ts` |
| G29 | Kiểm thử thực chứng toàn diện & không hồi quy G1–G24 trên SHA bàn giao | `eslint .` (0), `tsc --noEmit` (0), `next build --webpack` (0), toàn bộ `vitest tests/reading` PASS, holdout `READING_BENCH_HOLDOUT=1` PASS, Playwright E2E desktop & mobile PASS kèm ảnh chụp bằng chứng mới, backend `pytest` PASS; giữ nguyên toàn bộ cổng G1–G24 PASS | *Đang triển khai* | **PENDING** | `DELIVERY_STATUS.md`, `docs/reading/evidence/` |
