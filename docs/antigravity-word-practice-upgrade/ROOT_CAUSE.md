# ROOT CAUSE — Hệ thống luyện từ khó & đọc lại từ ngắn tiếng Việt ("có")

Báo cáo phân tích nguyên nhân gốc rễ cho các lỗi khiến trẻ đọc đúng từ ngắn tiếng Việt (như `"có"`) trong điều kiện âm thanh rõ nhưng hệ thống timeout, hiểu nhầm tiếng ồn, báo `503`, hoặc không đồng bộ trạng thái đỏ → vàng → xanh.

---

## 1. Từ ngắn tiếng Việt (`"có"`) bị chờ quá lâu (3.5s–12s) hoặc báo `AUDIO_TOO_SHORT` / `NO_CLEAR_AUDIO`

### Nguyên nhân tại `AudioQualityMonitor` ([audio-quality.ts](file:///F:/c1/capstone1/frontend/lib/reading/audio-quality.ts))
- Trước khi nâng cấp, cả luồng đọc cả đoạn sách lẫn luồng đọc lại **1 từ đơn** đều dùng chung cấu hình mặc định `"passage"` trong `AUDIO_QUALITY_PROFILES`:
  - `calibrationWindowMs: 250` (cần 250ms đầu chỉ để đo nền ồn `noiseFloorRms`)
  - `minDurationMs: 300`, `minSpeechDurationMs: 120`, `minPeakRms: 0.008`, `candidateOnsetMs: 120`, `hangoverMs: 350`.
- Trẻ lớp 1 bấm nói một từ đơn âm tiết `"có"` ngay sau khi chạm micro mất tổng cộng ~150ms–350ms:
  1. Phần năng lượng chính rơi vào ngay cửa sổ hiệu chuẩn 250ms đầu tiên (`calibrationWindowMs: 250`), làm **nhiễm `noiseFloorRms`** (`noiseFloor` bị đẩy lên gần mức giọng nói → mọi khung tiếng sau đó bị xem là dưới ngưỡng giọng nói).
  2. `candidateOnsetMs: 120` + `minSpeechDurationMs: 120` làm từ 1 âm tiết phát âm nhanh (~80ms–140ms) không kịp kích hoạt `speaking`, hoặc rơi vào `LOW_VOLUME` / `AUDIO_TOO_SHORT`.
  3. Trong [reading-screen.tsx](file:///F:/c1/capstone1/frontend/components/reading/reading-screen.tsx) và panel luyện từ cũ, luồng retry dựa chủ yếu vào browser interim/final transcript (`Web Speech API`), nhưng browser STT thường bỏ qua hoặc trễ 1 âm tiết tiếng Việt như `"có"`; nếu không dừng bằng VAD âm học (`silenceElapsedMs`), micro treo tới 3.5s–12s rồi mới chốt hoặc rơi vào `LOW_VOLUME` bị `hasUsableTranscript` / audio gate chặn trước khi gửi về backend.

### Cách đã sửa
- Bổ sung `AudioQualityMode = "passage" | "short-word"` trong [audio-quality.ts](file:///F:/c1/capstone1/frontend/lib/reading/audio-quality.ts): giữ nguyên `"passage"` cho đọc cả đoạn, dùng preset `"short-word"` cho từ đơn (`calibrationWindowMs: 60`, kẹp các mẫu onset `rms >= 0.015` trong cửa sổ hiệu chuẩn về `<= 0.008`, `minDurationMs: 160`, `minSpeechDurationMs: 60`, `minPeakRms: 0.003`, `candidateOnsetMs: 50`, `hangoverMs: 220`).
- Bổ sung `hasShortWordBlockingAudioIssue` chỉ chặn các lỗi thực sự không có dữ liệu (`NO_AUDIO`, `SILENCE`, `AUDIO_TOO_SHORT`, `INVALID_AUDIO`), cho phép `LOW_VOLUME` và `BACKGROUND_NOISE` đi qua Pass 1 STT tương tự backend `difficult_words_service.py`.
- Chuẩn hóa bộ đếm tự dừng theo VAD âm học tại `SHORT_WORD_CAPTURE_CONFIG` trong [word-practice-engine.ts](file:///F:/c1/capstone1/frontend/lib/reading/word-practice-engine.ts) (`minCaptureMs: 650`, `postSpeechSilenceMs: 520`, `noSpeechTimeoutMs: 4500`, `maxCaptureMs: 6500`).

---

## 2. STT trả về nhãn không phải lời nói (`[tiếng đập] có`) hoặc lặp âm (`có có`) gây đánh sai

### Nguyên nhân tại lớp phân loại transcript
- Các engine STT thực tế đôi khi chèn chú thích âm thanh như `[tiếng đập]` / `[tiếng chuông]` ngay trước hoặc sau từ bé đọc (`"[tiếng đập] có"`), hoặc lặp token echo (`"có có"`).
- Trước đây tokenizer chưa tách bỏ các thẻ `[tiếng ...]` khỏi token ứng viên một cách nhất quán giữa frontend và backend.
- Khi bé nói cả câu ngắn chứa từ mục tiêu trong ngữ cảnh (ví dụ `"bé có một bông hoa"`), bộ phân loại câu ngữ cảnh trước chưa tách riêng khỏi bộ phân loại từ đơn lẻ.

### Cách đã sửa
- Frontend ([retry-word-recognition.ts](file:///F:/c1/capstone1/frontend/lib/reading/retry-word-recognition.ts)): thêm `stripNonSpeechAnnotations`, gộp token lặp echo đồng nhất trong `classifyRetryTranscript`, và thêm `classifyPracticePhraseTranscript`.
- Backend ([difficult_words_service.py](file:///F:/c1/capstone1/backend/app/services/difficult_words_service.py)): lọc thẻ phi lời nói `_NON_SPEECH_TAG_RE` (`[tiếng đập]`, `[tiếng chuông]`, vẫn giữ an toàn các từ tiếng Việt chứa `tiếng`), gộp token lặp echo trong `classify_practice_transcript` (vẫn giữ phân biệt thanh điệu và `đ`/`d`).

---

## 3. Lỗi `503` *"Chưa lưu được kết quả. Hệ thống lưu lịch sử luyện từ chưa được khởi tạo bảng dữ liệu trên máy chủ"* & yêu cầu 2 lần đọc cứng nhắc

### Nguyên nhân tại Backend & Contract `/reports/difficult-words`
1. **Phụ thuộc cứng bảng chưa migrate**: Nếu bảng `public.difficult_word_practice_attempts` chưa tồn tại trên môi trường DB đang chạy, backend từ chối thao tác luyện bằng HTTP `503`. Trong khi đó hệ thống đã có bảng `public.readingevents` (lưu `Type = 'WORD_RETRY'`) đang hoạt động.
2. **Ngưỡng hoàn thành `2` lần liên tiếp & 2 vòng HTTP `start` → `evaluate-audio`**:
   - Ngưỡng `required_consecutive_correct = 2` buộc bé đã đọc đúng rõ một lần vẫn phải đọc lại lần 2 mới đổi trạng thái `COMPLETED` (xanh).
   - Luồng cũ phải gọi 2 request tuần tự (`POST .../practice/start` rồi `POST .../practice/{attempt_id}/evaluate-audio`), tăng độ trễ và điểm gãy mạng trên mobile.

### Cách đã sửa
- Đổi `REQUIRED_CONSECUTIVE_CORRECT = 1` ở cả backend ([difficult_words_service.py](file:///F:/c1/capstone1/backend/app/services/difficult_words_service.py), [difficult_words.py](file:///F:/c1/capstone1/backend/app/schemas/difficult_words.py)) lẫn đồng bộ rule hiển thị phía UI.
- Bổ sung cơ chế **Dual-Store `WORD_RETRY` Fallback** trong [difficult_words_repository.py](file:///F:/c1/capstone1/backend/app/repositories/difficult_words_repository.py) và `DifficultWordsService`: khi `is_practice_storage_ready()` trả `false`, backend đọc/ghi đầy đủ vào `public.readingevents` (`Type = 'WORD_RETRY'`) thông qua `resolve_retry_target`, `create_retry_event`, `list_retry_events_for_child`, `find_retry_event_by_request`, loại bỏ hoàn toàn lỗi `503`.
- Thêm endpoint gộp 1 roundtrip `POST /system/difficult-words/{child_id}/practice/evaluate` tại [system.py](file:///F:/c1/capstone1/backend/app/api/routes/system.py) và `evaluatePracticeWord` tại [difficult-word-service.ts](file:///F:/c1/capstone1/frontend/lib/api/difficult-word-service.ts).

---

## 4. Thiếu đồng bộ Đỏ → Vàng → Xanh và thiếu ngữ cảnh sách/trang nguồn

### Nguyên nhân
- Khi trẻ đọc lại đúng trong buổi đọc sách (`WORD_RETRY` `CONFIRMED`), highlight từ trong `WordHighlightOverlay` / `ReadingReport` / `SessionReadingReports` không ưu tiên trạng thái tự sửa đúng (`self_corrected_word_ids`) trước danh sách `skippedWordIds` / `mispronouncedWordIds` cũ.
- Dữ liệu `GET /system/difficult-words/{child_id}` trước đó chỉ trả danh sách từ phẳng theo bé, không trả `sources` (sách nguồn, trang, ngữ cảnh câu `"Bé có một bông hoa."`).
- Trong [difficult-word-practice-panel.tsx](file:///F:/c1/capstone1/frontend/components/reports/difficult-word-practice-panel.tsx), cần bảo đảm cleanup hook micro chỉ chạy khi unmount để việc re-render state của `speechRecorder` không vô tình hủy phiên ghi âm đang mở.

### Cách đã sửa
- Backend bổ sung `DifficultWordSourceRead` + `_build_context_phrase` trên `DifficultWordRead`, đồng thời `ReadingComparisonService.list_for_session` trả `self_corrected_word_ids` từ các sự kiện `WORD_RETRY` `CONFIRMED`.
- Frontend ưu tiên `selfCorrectedWordIds` + `activeRetryWordId` (đỏ → vàng khi đang luyện → xanh sau khi xác nhận) đồng nhất từ màn hình đọc sách tới báo cáo phiên và màn `/reports/difficult-words` nhóm theo sách.
