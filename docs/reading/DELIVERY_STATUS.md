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
