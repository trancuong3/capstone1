# PERFORMANCE RESULTS — Số liệu cấu hình thời gian thu âm & hiệu năng đo được

Tài liệu chỉ ghi nhận các thông số cấu hình và số liệu đo được trực tiếp từ mã nguồn và công cụ kiểm thử. Không ngoại suy độ trễ mạng thực tế của dịch vụ Whisper/ElevenLabs bên ngoài.

---

## 1. Tối ưu cửa sổ thu âm & VAD cho từ đơn (`"có"`)

| Thông số | Profile `"passage"` (Trước / Đọc cả đoạn) | Profile `"short-word"` (Mới / Từ đơn) | Ý nghĩa thực tế |
| --- | --- | --- | --- |
| `calibrationWindowMs` | `250 ms` | `60 ms` | Ngăn lời nói bật sớm (`rms >= 0.015`) làm nhiễm `noiseFloorRms` |
| `minDurationMs` | `300 ms` | `160 ms` | Từ 1 âm tiết nhanh không bị loại `AUDIO_TOO_SHORT` |
| `minSpeechDurationMs` | `120 ms` | `60 ms` | Phát âm ngắn ~80–120ms vẫn được công nhận là có lời nói |
| `minPeakRms` | `0.008` | `0.003` | Trẻ đọc nhỏ nhẹ vẫn không bị gate âm thanh chặn trước STT |
| `candidateOnsetMs` | `120 ms` | `50 ms` | Kích hoạt cờ `speaking` nhanh hơn 70ms cho âm đầu bật ngắn |
| `hangoverMs` | `350 ms` | `220 ms` | Nhả trạng thái đang nói nhanh hơn sau khi dứt âm |

### Bộ hẹn giờ dừng thu tự động (`SHORT_WORD_CAPTURE_CONFIG` tại [word-practice-engine.ts](file:///F:/c1/capstone1/frontend/lib/reading/word-practice-engine.ts))
- Trước đây: chờ cửa sổ đọc lại dài 3.5s–12s hoặc phụ thuộc browser speech event hay trượt từ 1 âm tiết.
- Sau nâng cấp:
  - `pollIntervalMs: 120`
  - `minCaptureMs: 650`
  - `postSpeechSilenceMs: 520` (tự dừng ngay khi đã quan sát được tiếng nói qua Acoustic VAD hoặc Browser STT và qua 520ms im lặng kể từ lúc đạt 650ms)
  - `noSpeechTimeoutMs: 4500`, `maxCaptureMs: 6500`
  - `autoAdvanceCorrectMs: 1100`, `autoRetryPauseMs: 900`

---

## 2. Giảm số vòng gọi HTTP & ngưỡng hoàn thành

| Chỉ số | Trước nâng cấp | Sau nâng cấp | Nguồn xác minh |
| --- | --- | --- | --- |
| Số lần đọc đúng rõ để hoàn thành từ | `2` lần liên tiếp | **`1` lần** | `REQUIRED_CONSECUTIVE_CORRECT = 1` ([difficult_words_service.py](file:///F:/c1/capstone1/backend/app/services/difficult_words_service.py)) |
| Số request lưu & đánh giá 1 lượt luyện | `2` request (`POST .../practice/start` + `POST .../evaluate-audio`) | **`1` request** (`POST .../practice/evaluate`) | `evaluate_word_direct` ([system.py](file:///F:/c1/capstone1/backend/app/api/routes/system.py)) & `evaluatePracticeWord` ([difficult-word-service.ts](file:///F:/c1/capstone1/frontend/lib/api/difficult-word-service.ts)) |

---

## 3. Hiệu năng CPU / Test / Build đo trực tiếp

- **Backend Python classifier (`classify_practice_transcript`)** với `n = 2000` lượt chạy trên 8 mẫu tiếng Việt thực tế (`có`, `[tiếng đập] có`, `có có`, `bé có một bông hoa`, `cá`, `cỏ`, `chó`, `từ khác`):
  - `p50 = 0.0173 ms`
  - `p95 = 0.0363 ms`
  - `max = 1.6696 ms`
- **Frontend short-word suite (`tests/reading/short-word-recognition.test.ts`)**:
  - Toàn bộ **16 tests** (bao gồm tổng hợp sóng formant `F0=260Hz`, `F1=550Hz`, `F2=900Hz`, 12 kịch bản nhận diện `"có"`, kiểm tra độ trễ `< 50ms`) chạy xong trong tổng thời gian **`29 ms`** (`Vitest v5.0.0`).
- **Production Next.js Build**:
  - Compile time: **`13.0 s`**, TypeScript finish time: **`33.3 s`**, **`38/38` static pages**, exit `0`.
- **Playwright Route Warmup Optimization**:
  - Bổ sung lọc `PLAYWRIGHT_ROUTE_FILTER` trong [warm-routes.ts](file:///F:/c1/capstone1/frontend/test/browser/warm-routes.ts) giúp scoped E2E `/reports/difficult-words` hoàn tất cả 2 project desktop + mobile trong **`1.2 phút`** thay vì ép biên dịch 45 route webpack gây nghẽn thread/RAM trên Windows.
