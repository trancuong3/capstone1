# ViRead — Đặc tả kiến trúc Giọng nói Local-First, Google Dự phòng & Một Buổi Một Giọng

- **Base SHA kiểm kê**: `6cbc9b24` (`origin/main`)
- **Worktree triển khai**: `F:\c1\capstone1-local-voice` (branch `feat/local-voice-first-20261122`)
- **Môi trường giọng nói tách biệt khỏi OCR**: `F:\c1\tools\voice-runtime\.venv` + `F:\c1\tools\voice-runtime\models` (giữ nguyên 100% các pin ABI OCR trong `backend/requirements.txt`: `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`).
- **Tình trạng cấu hình Google Cloud hiện tại (`backend/.env`)**:
  - `ELEVENLABS_API_KEY`: `SET`
  - `GEMINI_API_KEY`: `SET` (dùng cho OCR proofreading/safety, KHÔNG phải Google Cloud Speech-to-Text / Text-to-Speech)
  - `GOOGLE_CLOUD_STT_API_KEY` / `GOOGLE_CLOUD_TTS_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS`: **CHƯA CẤU HÌNH** → Phần kiểm thử trên tài khoản Google Cloud thật sẽ được ghi nhận trung thực là `BLOCKED` cho đến khi có credential hợp lệ; toàn bộ adapter, chính sách dự phòng và kiểm thử cô lập bằng mock vẫn được triển khai và kiểm chứng đầy đủ.

---

## 1. Kiểm kê toàn bộ đường giọng nói tại SHA `6cbc9b24`

### 1.1 Các nguyên nhân gây đổi giọng ngoài ý muốn đã phát hiện
1. **`frontend/lib/reading/tts-playback.ts` (`WORD_RECORDINGS`)**: Với từ `"thức"` và `"thực"`, `TtsPlayback.play(..., { wordSample: true })` phát file WAV tĩnh của người đọc Wikimedia Commons khác hẳn giọng đang chọn.
2. **`frontend/lib/reading/tts-playback.ts` (`if (options.wordSample || deviceCanCoach)`)**: Mọi lời nhắc hướng dẫn (`coaching: true`) và đọc mẫu 1 từ (`wordSample: true`) tự chuyển sang `window.speechSynthesis` (giọng trình duyệt/OS ngẫu nhiên), trong khi đọc cả trang (`playWithWordTimings`) gọi server TTS → gây lệch giọng ngay trong cùng một buổi đọc.
3. **`frontend/lib/reading/tts-playback.ts` (fallback ngầm sang `playBrowser`)**: Khi server TTS lỗi hoặc timeout, tự động chuyển sang `window.speechSynthesis` (giọng khác) thay vì giữ đúng giọng đã khóa hoặc hiển thị chữ + thử lại.
4. **`backend/app/providers/elevenlabs_voice_provider.py` & `voice_studio.py`**: Hardcode hoàn toàn `ElevenLabsVoiceProvider` / `ElevenLabsStudioProvider`; nếu `voice_id` lỗi thì tự fallback sang `DEFAULT_VOICE_ID` (giọng khác).
5. **Khóa cache TTS thiếu định danh provider & phiên bản preset/model**: Hiện chỉ dùng `[voiceId, speed, text]`, dễ phát nhầm audio cũ khi đổi provider hoặc nâng cấp model.
6. **Các điểm gọi trực tiếp `window.speechSynthesis` / `SpeechRecognition` rải rác**:
   - `frontend/components/reading/reading-screen.tsx` (dùng Chrome Web Speech `SpeechRecognition`/`webkitSpeechRecognition` trực tiếp và gửi file lên `/voice/speech-to-text` ElevenLabs).
   - `frontend/components/reading/comprehension-question.tsx` (gọi `useSpeechPlayer` + `SpeechRecognition`).
   - `frontend/components/reports/difficult-word-practice-panel.tsx` (gọi `useSpeechPlayer` + `SpeechRecognition`).
   - `frontend/components/entertainment/picture-description/picture-description-screen.tsx` (gọi `createSpeechService`, `useSpeechPlayer`, `SpeechRecognition`, `speechSynthesis`).
   - `frontend/components/entertainment/sentence-shooter/sentence-shooter-screen.tsx` (gọi `speechSynthesis`).

### 1.2 Bảng kiểm kê Điểm dùng → Provider hiện tại → Provider local → Điều kiện Google → Kiểm thử

| Điểm dùng | File chính | Provider hiện tại (`6cbc9b24`) | Provider local mục tiêu | Điều kiện gọi Google dự phòng | Cách kiểm thử |
| --- | --- | --- | --- | --- | --- |
| Danh sách giọng & vùng miền | `backend/app/api/routes/voice_studio.py`, `frontend/components/reading/reading-voice-settings.tsx` | ElevenLabs `/v1/voices` | Local Worker (`127.0.0.1:8010`) — **VieNeu-TTS** với preset thật **Bắc · Trung · Nam** | Khi phụ huynh bật Google TTS dự phòng & backend có Google credential: hiển thị thêm giọng Google rõ nhãn, chỉ dùng khi phụ huynh chọn rõ | Unit + Integration + E2E chọn Bắc/Trung/Nam, nghe thử, lưu cấu hình |
| Đọc lời chào / hướng dẫn / từ mẫu / câu mẫu / động viên / kết thúc | `backend/app/api/routes/voice.py` (`/voice/text-to-speech`), `tts-playback.ts` | ElevenLabs + `window.speechSynthesis` + `WORD_RECORDINGS` | Local Worker **VieNeu-TTS** (cùng 1 `SessionVoiceLock`: `provider`, `voiceId`, `region`, `modelVersion`, `speed`) | Chỉ gọi Google TTS nếu buổi đọc đã khóa chính giọng Google đó; không tự trộn giọng Google vào buổi local | Unit + E2E kiểm tra 100% câu phát trong buổi có cùng `(provider, voiceId, modelVersion)` = **0 lần đổi giọng** |
| Đọc mẫu cả trang có word timings | `backend/app/api/routes/voice_studio.py` (`/voice/text-to-speech/timed`) | ElevenLabs `with-timestamps` + fallback `speechSynthesis` | Local Worker **VieNeu-TTS** + word timings chuẩn hóa từ độ dài âm tiết/năng lượng thực | Chỉ khi buổi khóa giọng Google TTS; khi local lỗi thì dùng cache cùng giọng hoặc báo chữ + nút thử lại | Unit + Integration + Playwright E2E |
| Nhận diện giọng bé khi đọc trang | `backend/app/api/routes/voice.py` (`/voice/speech-to-text`), `reading-screen.tsx` | Chrome `SpeechRecognition` (cloud ngầm của trình duyệt) + ElevenLabs STT | Local Worker **Sherpa-ONNX Vietnamese Zipformer** (hoặc **PhoWhisper** sau benchmark) qua FastAPI loopback | Chỉ khi phụ huynh bật `Máy này + Google dự phòng` + công tắc riêng `Nhận diện giọng nói` + backend có Google Cloud STT credential + xảy ra lỗi kỹ thuật local (worker chết/timeout/unavailable) ở ranh giới đoạn an toàn; KHÔNG kích hoạt khi bé im lặng, đọc sai hay nói giọng vùng miền | Unit + Integration + E2E (local khỏe = 0 gọi Google; local lỗi + tắt fallback = 0 gọi Google; local lỗi + bật fallback = gọi đúng 1 lần ở ranh giới đoạn) |
| Câu hỏi đọc hiểu cuối bài | `comprehension-question.tsx` | `useSpeechPlayer` + `SpeechRecognition` | `useSpeechPlayer` (cùng giọng khóa của buổi) + Local STT khi chế độ `Chỉ máy này` | Tuân thủ đúng chính sách STT/TTS của phiên | Vitest + Playwright E2E |
| Luyện từ khó / Trò chơi mô tả tranh / Bắn câu | `difficult-word-practice-panel.tsx`, `picture-description-screen.tsx`, `sentence-shooter-screen.tsx` | `useSpeechPlayer` + `SpeechRecognition` + `speechSynthesis` | Qua lớp `VoiceOrchestrator` chung (Local-first, không tự gọi cloud khi `Chỉ máy này`) | Tuân thủ đúng cấu hình phụ huynh | Vitest hồi quy |

---

## 2. Chính sách Provider & Quy tắc Khóa Giọng

### 2.1 Hai chế độ rõ ràng (`VoiceProviderPolicy`)
1. **`local_only` ("Chỉ máy này" — mặc định)**:
   - STT & TTS chỉ dùng worker local trên Windows (`127.0.0.1:8010`).
   - Khi local lỗi: hiển thị thông báo rõ ràng bằng chữ và nút thử lại. **Tuyệt đối không** tự mở Web Speech, không gọi Google/ElevenLabs, không đổi chế độ.
2. **`local_with_google_fallback` ("Máy này + Google dự phòng")**:
   - Mặc định vẫn gọi local trước.
   - Hai công tắc độc lập cho phụ huynh:
     - `allowGoogleSttFallback: boolean` (mặc định `false`)
     - `allowGoogleTtsFallback: boolean` (mặc định `false`)
   - Google STT dự phòng: chỉ kích hoạt ở ranh giới đoạn khi local lỗi kỹ thuật (`LOCAL_WORKER_UNAVAILABLE`, `LOCAL_WORKER_TIMEOUT`, `LOCAL_WORKER_ERROR`), giới hạn thời lượng audio, timeout, tối đa 1 lần thử, có cooldown khi lỗi/hết quota, gắn `session_id`, `page_id`, `turn_id`, `source`.
   - Google TTS dự phòng: **tuyệt đối không** trộn giọng Google vào một buổi đọc đang khóa giọng local. Chỉ dùng Google TTS khi phụ huynh chủ động chọn giọng Google trước buổi đọc hoặc khi tạm dừng và khóa giọng đó cho phần tiếp theo.

### 2.2 Cấu hình khóa giọng cho mỗi buổi đọc (`SessionVoiceLock`)
```ts
interface SessionVoiceLock {
  readonly sessionId: string;
  readonly provider: "local" | "google";
  readonly voiceId: string;
  readonly region: "north" | "central" | "south";
  readonly modelVersion: string;
  readonly speedPreset: "slow" | "normal" | "fast"; // 0.85 | 1.0 | 1.15
  readonly speed: number;
  readonly lockedAt: string;
}
```
- Lưu bền vững theo `sessionId` trong `sessionStorage`/`localStorage` để reload/tiếp tục phiên khôi phục đúng giọng đã khóa.
- Mọi khóa cache TTS (cả server & client) phải bao gồm: `(provider, voiceId, modelVersion, speed, text)`.
- Khi đọc chậm để hướng dẫn 1 từ khó (`speedScale`), vẫn gửi đúng `(provider, voiceId, modelVersion)` đã khóa, chỉ điều chỉnh tốc độ giữ cao độ (`preservesPitch = true`), không bao giờ áp tốc độ 2 lần (cả lúc tạo lẫn lúc phát).

---

## 3. Ngưỡng nghiệm thu bắt buộc (Khóa trước khi benchmark bộ giữ riêng)
- **Số lần đổi giọng ngoài ý muốn trong 1 buổi đọc**: `0`
- **Số lần gọi Google/Cloud khi local khỏe**: `0`
- **Số lần gọi Google khi chế độ `Chỉ máy này` hoặc công tắc dự phòng tắt**: `0`
- **Số lần bấm thêm trong ca đọc trơn tru sau Bắt đầu & cấp quyền**: `0`
- **Hỗ trợ đủ 3 vùng miền Bắc · Trung · Nam với 3 preset thật khác biệt**: Bắt buộc `>= 1` preset thật cho mỗi miền
- **3 mức tốc độ `Chậm (0,85×) · Vừa (1,0×) · Nhanh (1,15×)`**: Thời lượng audio chênh lệch đơn điệu (`duration(0.85) > duration(1.0) > duration(1.15)`), giữ thanh điệu tiếng Việt
- **Ca giọng trẻ em thật**: Ghi rõ `NOT RUN / BLOCKED (không có dữ liệu giọng trẻ được phép dùng theo quy tắc quyền riêng tư)` nếu không có tập dữ liệu giọng trẻ hợp lệ; chỉ nghiệm thu trên clip chuẩn tổng hợp / mẫu test hợp lệ và ghi rõ nguồn.


---

## 4. Đặc tả Phần Bổ Sung Bắt Buộc — Đánh vần từng bước, đọc đúng dấu tiếng Việt

### 4.1 Phạm vi đồng nhất trên 2 màn hình
- **Màn bé đang đọc sách (`ReadingScreen`)**:
  - Cho cơ hội tự sửa khi mới ngập ngừng nhẹ / lỡ lời lần đầu.
  - Khi bé nói **“Con không biết”**, **“Đánh vần giúp con”**, bấm **Nghe đánh vần**, hoặc mắc kẹt nhiều lần: chỉ đúng tiếng đang mắc, hiển thị thẻ đánh vần từng bước ngay tại chỗ (giữ nguyên vị trí trang, không chuyển màn hình), phát audio từng bước bằng **đúng giọng đã khóa**, highlight đúng phần âm/vần/dấu theo thời gian phát thực tế, đọc trọn tiếng có dấu, chờ hết tiếng vọng rồi mở mic mời bé đọc lại.
- **Màn Luyện từ khó (`DifficultWordPracticePanel`)**:
  - Mỗi mục có đủ 3 hành động rõ ràng: **Nghe từ**, **Nghe đánh vần**, **Đọc lại** (hỗ trợ cả nói **“Đọc lại”**, **“Đánh vần giúp con”** hoặc bấm nút).
  - Dùng chung 100% module `phonics-lesson.ts`, pipeline TTS khóa giọng và bộ phân loại kết quả với `ReadingScreen`.

### 4.2 Cấu trúc bài đánh vần (`PhonicsLessonPlan`) & Ca chuẩn “mốt”
Mỗi từ/cụm được chuẩn hóa NFC và phân tích thành cấu trúc tường minh:
- `rawText`: chuỗi gốc NFC (ví dụ `"hai mươi mốt"` hoặc `"mốt"`).
- `supported`: `boolean` — từ chối sinh bài đoán cho từ nước ngoài (`"pizza"`), viết tắt (`"SGK"`), chữ số chưa quy đổi, hoặc chuỗi lệch chính tả tiếng Việt (`"trng"`), trả về trạng thái **`"Chưa có mẫu đánh vần"`** (vẫn giữ **Nghe từ** nếu hợp lệ).
- `focusSyllable`: tiếng cần luyện (ví dụ `"mốt"` trong `"hai mươi mốt"`), kèm `focusRange` trong `rawText`.
- `onset`: âm đầu + cách đọc tên chuẩn SGK (`m` → `"mờ"`, `ngh` → `"ngờ"`, `qu` → `"quờ"`, `gi` → `"gi"`, `kh` → `"khờ"`, `ch` → `"chờ"`, `tr` → `"trờ"`, `nh` → `"nhờ"`, hoặc `null` nếu không có âm đầu).
- `rhyme`: vần gốc, âm chính (`nucleus`), âm cuối (`coda`), vần ghép phát âm chuẩn (với âm cuối khép `c/ch/p/t` như `ốt` mang thanh sắc tự nhiên khi đánh vần vần).
- `tone`: một trong 6 thanh (`ngang`, `sắc`, `huyền`, `hỏi`, `ngã`, `nặng`), giữ nguyên dấu Unicode NFC từ dữ liệu sách → UI → đầu vào TTS → khóa cache (tuyệt đối không bỏ dấu khi tra cache hay chấm điểm: `mốt ≠ một ≠ mót`, `ma ≠ má ≠ mà ≠ mả ≠ mã ≠ mạ`, phân biệt `đ/d`, `ă/â/a`, `ê/e`, `ô/ơ/o`, `ư/u`).
- **Kịch bản chuẩn cho ca bắt buộc `"mốt"`** (tách thành các bước riêng có khoảng nghỉ rõ, không đưa dấu gạch ngang hay ký hiệu lạ vào TTS):
  1. Bước 1 (`rhyme_build`, làm nổi `ốt`): hiển thị `ô · tờ → ốt` — đọc rõ từng nhịp: `"ô, tờ, ốt."`
  2. Bước 2 (`onset_blend`, làm nổi `m` + `ốt`): hiển thị `mờ + ốt` — đọc rõ: `"mờ, ốt."`
  3. Bước 3 (`tone_blend`, làm nổi dấu sắc & trọn tiếng `mốt`): hiển thị `sắc → mốt` — đọc rõ: `"sắc, mốt."`
  4. Bước 4 (`whole_syllable`, làm nổi trọn chữ `mốt`): hiển thị `mốt` — đọc trọn tiếng rõ dấu: `"mốt."`
  5. *(Nếu nằm trong cụm nhiều tiếng như `"hai mươi mốt"`)* Bước 5 (`context_phrase`, làm nổi cả cụm): `"hai mươi mốt."`

### 4.3 Bốn mức kết quả riêng biệt & Quy tắc chống chấm nhầm
1. **`FIRST_PASS_CORRECT`** — *“Đọc đúng ngay lần đầu”* (chỉ dành cho lượt đọc đầu tiên không cần gợi ý/đánh vần).
2. **`CORRECT_AFTER_HINT`** — *“Đọc đúng sau gợi ý”*.
3. **`CORRECT_AFTER_SPELLING`** — *“Đọc đúng sau đánh vần”* (chỉ ghi nhận khi bé đọc trọn tiếng có dấu sau bước đánh vần; **không** ghi đè kết quả lượt đầu, **không** tính là đạt nếu bé mới nhẩm lại `"ô, tờ, ốt"` mà chưa phát âm trọn `"mốt"`).
4. **`NEEDS_PRACTICE`** — *“Cần luyện lại”* (khi hết số lần thử giới hạn hoặc bấm bỏ qua).
