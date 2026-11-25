# Đặc Tả Sư Phạm Học Đọc Tiếng Việt Lớp 1–3 & Hành Vi Gia Sư ViRead

> Tài liệu chuẩn hóa hành vi sản phẩm cho luồng học đọc của trẻ trên ViRead, kết hợp góc nhìn giáo viên tiểu học (CT GDPT 2018 môn Ngữ văn lớp 1–3), nghiên cứu học đọc tiếng Việt đầu cấp ([PMC7963025](https://pmc.ncbi.nlm.nih.gov/articles/PMC7963025/)), và nghiên cứu phương ngữ tiếng nói trẻ Việt Nam ([doi:10.1111/1460-6984.12992](https://doi.org/10.1111/1460-6984.12992)).

---

## 1. Bối cảnh phát hiện hiện trạng (Baseline trước khi sửa — `2026-11-25`)

Trước khi thay đổi mã nguồn trên `F:\c1\capstone1` (`main @ cad23ac`), bộ đo nền (`docs/reading/evidence/reading_acceptance_20261125/`) đã tái hiện và ghi nhận 4 nhóm nguyên nhân gốc:

1. **Độ trễ đường truyền STT qua Backend + gom WAV tích lũy (`839,57 ms` P50 / `2.902,75 ms` P95 từ cuối tiếng tới lúc vẽ):**
   - `backend/app/api/routes/voice.py` khởi tạo mới `VoiceOrchestrator()` → `LocalVoiceProvider()` → `httpx.AsyncClient` trên **mỗi request**, gây phụ phí **`~384–400 ms`/request** (trung bình backend overhead `384,33 ms` trong khi worker decode `71,83–223,29 ms`).
   - `LocalSegmentSpeechRecognition` gửi lại toàn bộ WAV tích lũy mỗi `320 ms` (tới `131,3 KB` ở `4,2 s`), và `interimInFlight` bỏ qua nhịp kế tiếp khi request trước chưa xong, khiến cuối câu dài bị trễ nặng.
2. **`EchoGuard` tự chặn tiếng bé + thiếu kiểm chất lượng âm cho luồng local (`reading-screen.tsx` & `echo-guard.ts`):**
   - `LocalSegmentSpeechRecognition` không gắn `onsetAt` và `audioQuality` trên sự kiện kết quả → ngay sau khi cô đọc mẫu một chữ (`"nghiêng"`), bé lặp lại `"nghiêng"` trong `1.500 ms` bị `EchoGuard` (`tail-overlap >= 0.6`, không có `onsetAt`) **từ chối nhầm** là tiếng vọng của cô.
   - `reading-screen.tsx` tạo nhiều timer rời (`pageSilenceTimerRef`, `wrongWordGraceTimerRef`, `overcamePraiseTimerRef`) thay vì nối bộ điều phối lượt `ReadingAutomationRuntime`.
   - `voice-intent.ts` thiếu các câu tự nhiên của trẻ: `"để con tự đọc"`, `"chữ này con chưa biết"`, `"nghỉ một chút"`, `"cho con thử thêm"`.
3. **Quiz hiểu bài (`comprehension-voice-matcher.ts`):**
   - `"ạ"` và `"à"` nằm trong `LETTER_ALIASES` của phương án `A` → bé nói `"ạ"` hoặc `"à..."` **tự nộp A**; bé nói `"con chọn B ạ"` bị lỗi `"ambiguous"` trả về `NONE`.
   - `"con không chọn bạn An"` không phân tích phủ định → **tự nộp B (`Bạn An`)**.
   - `"A… à không, con chọn B"` không có parser tự sửa → trả về `NONE`.
   - `"A, bạn An"` âm thầm chọn `B` thay vì phát hiện mâu thuẫn để hỏi lại; `"Bạn"` không gợi bé nói rõ giữa hai lựa chọn cùng chứa `"bạn"`.
   - Thiếu tô tạm phương án đang nghe và chốt ổn định trước khi nộp.
4. **Cấu hình TTS & nhân xưng thực chạy (`voice_worker.py` & UI):**
   - `Start-ViReadVoiceWorker.ps1` và `voice_worker.py` mặc định chạy **`int8`** dù `local_voice_provider.py` và `VOICE_BENCHMARK_AND_AUDIO_AUDIT.md` khai báo `fp32`. Đo trực tiếp bản `int8` trên cặp tối thiểu: `"mốt"` bị STT nghe thành `"một"`.
   - Một số tiêu đề/nhãn (`reading-screen.tsx`, `comprehension-question.tsx`, `word-presentation.ts`) vẫn cứng chữ `"Cô giáo"` ngay cả khi gia đình chọn giọng **Thầy giáo**.

---

## 2. Chuyển hóa yêu cầu sư phạm Tiếng Việt Lớp 1–3 thành hành vi sản phẩm

### 2.1 Bé mới ghép tiếng (Lớp 1 — giải mã âm–chữ & đánh vần)
- **Hiện tượng tự nhiên:** Tách âm đầu/vần/thanh (`"ô - i - ôi"`, `"tờ - ôi - tôi"`), kéo dài nguyên âm khi dò chữ, ngắt quãng giữa các bước đánh vần qua nhiều đoạn STT rời.
- **Hành vi bắt buộc trên ViRead:**
  1. Giữ bộ đệm đánh vần liên đoạn (`spellingBuffer`) và chịu lỗi biến âm nhẹ **duy nhất trên âm đệm**; **từ chốt cuối cùng** luôn giữ nguyên chính tả + thanh điệu + chữ `đ` (NFC).
  2. Khi bé vấp một tiếng trong cụm (ví dụ kẹt ở `"nghiêng"` trong `"nghiêng đầu"`):
     - Bước 1: Gợi ý / giúp gọn **đúng một tiếng** (`"nghiêng"`: âm đầu `ng/ngh`, vần `iêng`, thanh ngang).
     - Bước 2: Đọc mẫu tiếng hoặc cụm ngắn rồi mời bé **đưa tiếng ấy trở lại cụm/từ có nghĩa** (`"nghiêng đầu"`) để nối nghĩa, thay vì luyện rời rạc mãi một tiếng đơn.
  3. Khoảng lặng ngắn lúc bé đang đánh vần dở không bật hộp nghỉ và không ghi lỗi đọc sai.

### 2.2 Bé đã đọc thành câu (Lớp 1 cuối kỳ II – Lớp 3 — đọc trơn, ngắt nghỉ đúng dấu câu)
- **Hiện tượng tự nhiên:** Đọc liền cụm nhiều tiếng, ngắt hơi lâu hơn sau dấu phẩy `,`, dấu chấm `.`, chấm hỏi `?`, chấm than `!`, hoặc hết dòng thơ.
- **Hành vi bắt buộc trên ViRead:**
  1. Giữ mạch đọc qua nhiều tiếng; nhân hệ số khoan dung ngắt nghỉ (`punctuationFactor = 1.5`) sau tiếng có dấu câu và cuối dòng thơ.
  2. Không tự ý cắt ngang bài đọc để phát lời khen giữa chừng. Nếu bé tự sửa được (`"bàn… bạn"`) và vẫn đang đọc tiếp trôi chảy → ghi nhận **tự sửa một lần**, giữ micro mở, đặt lời khen gắn hành vi thật (ví dụ: *“Con vừa tự sửa được chữ ‘bạn’”*) dưới dạng bong bóng nhẹ hoặc sau khi hết cụm/câu.
  3. Chỉ xen vào khi bé chủ động xin giúp hoặc có đủ bằng chứng im lặng/vướng thật sau cửa sổ chờ thích ứng.

### 2.3 Bé đang đọc hiểu (Tách đọc lưu loát khỏi đọc hiểu — theo PMC7963025)
- Nghiên cứu theo dõi trẻ lớp 1 tại Hà Nội ([PMC7963025](https://pmc.ncbi.nlm.nih.gov/articles/PMC7963025/)) chỉ ra các yếu tố dự báo khả năng **đọc thành tiếng/lưu loát** và **đọc hiểu** có phần phân tách: một em bé ghép chữ chậm hoặc đọc chưa trôi vẫn có thể nắm rất tốt nội dung câu chuyện nếu được nghe và trả lời không áp lực thời gian.
- **Hành vi bắt buộc trên ViRead:**
  1. Tách hoàn toàn tốc độ đọc khỏi điểm đọc hiểu; gia sư đọc rõ câu hỏi + từng đáp án `A, B, C...`, chờ đủ thời gian để bé nghĩ (không giới hạn thời gian gắt).
  2. Tách biệt **3 bước độc lập**:
     - *(a) Nghe lời bé nói* (STT + chống vọng loa TTS).
     - *(b) Xác định lựa chọn của bé* (`ComprehensionVoiceMatcher` **tuyệt đối không được biết đáp án đúng**, chỉ nhận lời bé + các phương án hiển thị).
     - *(c) Chấm và phản hồi sư phạm* (sau khi chốt lựa chọn rõ ràng): nếu đúng → khen gắn bài; nếu sai rõ ràng → **ghi đúng phương án bé vừa chọn** lên máy chủ trước, sau đó gợi bé nhìn lại chi tiết cụ thể trong đoạn đọc; nếu STT chưa rõ / ngập ngừng / mâu thuẫn (`"A, bạn An"`) / phủ định (`"con không chọn bạn An"`) → **giữ lượt trả lời mở**, hỏi lại nhẹ nhàng một câu ngắn.

### 2.4 Phương ngữ, nhịp đọc cá nhân & chuẩn bảo toàn dấu tiếng Việt (theo doi:10.1111/1460-6984.12992)
- Nghiên cứu phát triển tiếng nói và phương ngữ tiếng Việt nhấn mạnh khác biệt âm vị theo vùng miền (Bắc · Trung · Nam: phụ âm đầu `ch/tr`, `s/x`, `r/d/gi`, `l/n`, thanh `hỏi/ngã`, vần `-n/-ng`, `-t/-c`) có thể ảnh hưởng đáng kể tới kết quả nhận diện tự động nếu áp đặt một chuẩn phát âm đơn nhất.
- **Hành vi bắt buộc trên ViRead:**
  1. Tốc độ (`0,85x / 1,0x / 1,15x`), lớp học và giọng mẫu gia đình chọn chỉ dùng **khởi tạo trải nghiệm**; trong buổi học, ngưỡng chờ (`paceMs`) và bậc hỗ trợ thích ứng theo nhịp thực tế của bé.
  2. **Không bao giờ** suy ra phương ngữ/giọng của bé từ giọng cô/thầy (bé miền Nam có thể chọn cô miền Bắc và ngược lại).
  3. **Không bao giờ** đánh giá năng lực của bé từ một lần STT nhận yếu, hoặc **xóa toàn bộ dấu thanh / gộp `đ → d`** để làm đẹp tỷ lệ khớp. Giữ nguyên chính tả chuẩn sách; nếu bằng chứng âm thanh yếu/nhiễu (quạt, tivi, nói nhỏ) thì gắn trạng thái **Chưa nghe rõ (`UNCERTAIN`)** và giữ nguyên điểm.
  4. Đồng bộ tuyệt đối **xưng hô (`Cô` ↔ `Thầy`), vùng giọng, tốc độ** ở mọi màn hình từ đọc bài, đánh vần, luyện từ khó, quiz tới thông báo lỗi.
