# Đặc tả Sư phạm Tiếng Việt Lớp 1 (GDPT 2018), Nhận diện Đánh vần Thực chiến & Luồng Tương tác Cảm xúc

> Tài liệu khảo sát gốc và thiết kế kỹ thuật khóa trước khi sửa mã nguồn đợt 3 (Cổng **G25–G29**).

---

## 1. Chẩn đoán 4 nguyên nhân gốc khiến thực tế trẻ đánh vần & đọc sai còn gặp nghẽn

Qua khảo sát trực tiếp mã nguồn tại SHA `5f0c9d58` (`phonics-spelling.ts`, `realtime-alignment.ts`, `recognition-evidence.ts`, `browser-transcript-collector.ts`, `retry-word-recognition.ts`, `reading-screen.tsx`), 4 điểm nghẽn thực tế đã được xác định chính xác:

1. **Thiếu bộ đệm đánh vần liên đoạn (`SpellingBuffer`) và thiếu bảng chịu lỗi biến âm STT trên âm đệm:**
   - Khi trẻ lớp 1 đọc chữ `"tê"` theo kiểu SGK (`"ê - tờ - ê - tê"`), Web Speech API thường cắt từng nhịp nghỉ thành 3–4 sự kiện `isFinal` rời (`"ê"` → `"tờ"` → `"ê"` → `"tê"`). `RealtimeAlignmentEngine.addFinalTranscript` trước đây chỉ xét `matchPhonicsSpelling` trong phạm vi **một gói `isFinal` đơn lẻ**.
   - Khi STT nghe `"tờ"` thành `"tơ"` (rơi dấu huyền) hoặc `"ê"` thành `"ế"`, `isPhonicsInProgress` trả về `false`, đẩy âm đệm vào `pendingToken` và làm nổ **`SUBSTITUTE` (tô đỏ)** ngay trước khi bé kịp ghép xong chữ `"tê"`.
2. **Ngưỡng `hasUsableBrowserConfidence >= 0.5` loại bỏ các âm đánh vần đơn lẻ:**
   - Web Speech API (`vi-VN`) thường trả `confidence` trong khoảng **`0.28 – 0.49`** cho các âm tiết rời 1 nguyên âm / tên phụ âm (`"ê"`, `"tờ"`, `"ô"`, `"i"`). Ở `reading-screen.tsx`, mọi kết quả `< 0.5` bị loại ngay và gọi `markCaptureUncertain`, khiến chuỗi đánh vần đứt gãy.
3. **Chế độ luyện lại từ sai (`retry-word-recognition.ts`) từ chối chuỗi đánh vần:**
   - `classifyRetryTranscript` giới hạn cứng `candidateTokens.length > 4` → trả về `"UNCERTAIN"` hoặc `"INCORRECT"`, đồng thời `retryBrowserFinalRef` ghi đè từng gói `isFinal` thay vì gom chuỗi đánh vần trong cùng lượt thử. Kết quả là khi bé luyện lại từ `"tê"` bằng cách đánh vần `"ê tờ ê tê"` hoặc `"ô i ôi tờ ôi tôi"`, máy không chấm đạt.
4. **Trải nghiệm "bé đọc sai → tô đỏ → máy im lặng ~9 giây":**
   - Khi bé đọc nhầm 1 từ rồi ngừng lại chờ phản hồi, token sai nằm chờ trong `pendingToken` hoặc đã thành `SUBSTITUTE` nhưng `ReadingScreen` chỉ kích hoạt `offerPassageHelp` sau `WORD_HELP_SILENCE_LIMIT × noSpeechTimeoutMs` (~9 giây im lặng), với câu nhắc ngắn khô khan (`"Cô đọc mẫu cho con nhé."`), không phân biệt lỗi dấu thanh / lỗi âm gần / lỗi lúng túng và chưa có hướng dẫn đánh vần từng bước.

---

## 2. Quy tắc dạy đọc thành tiếng Tiếng Việt Lớp 1 (Chương trình GDPT 2018)

Trong các bộ SGK Tiếng Việt 1 hiện hành (*Kết nối tri thức với cuộc sống*, *Chân trời sáng tạo*, *Cánh diều*), học sinh 6–7 tuổi sử dụng song song **2 mô hình đánh vần chuẩn** trước khi đọc trơn:

### 2.1 Mô hình 1: Đánh vần Vần trước – Âm đầu sau (cực phổ biến ở Học kỳ I & II Lớp 1)
Trẻ nhận diện và ghép phần **vần** trước để nắm khuôn vần trên trang sách, sau đó mới ghép **âm đầu** + **vần** + **thanh điệu** + **đọc trơn**:
- **Vần 1 nguyên âm:**
  - `"tê"` → `"ê - tờ - ê - tê"`
  - `"cá"` → `"a - cờ - a - ca - sắc - cá"`
  - `"nhỏ"` → `"o - nhờ - o - nho - hỏi - nhỏ"`
  - `"bơ"` → `"ơ - bờ - ơ - bơ"`
- **Vần ghép (nhiều âm):**
  - `"tôi"` → `"ô - i - ôi - tờ - ôi - tôi"`
  - `"cơm"` → `"ơ - mờ - ơm - cờ - ơm - cơm"`
  - `"đang"` → `"a - ngờ - ang - đờ - ang - đang"`
  - `"nước"` → `"ư - ơ - cờ - ước - nờ - ước - nước - sắc - nước"`

### 2.2 Mô hình 2: Đánh vần Âm đầu trước – Vần sau – Thanh điệu – Đọc trơn
Khi đã quen mặt vần, trẻ đánh vần trực tiếp từ trái sang phải:
- `"tờ - ê - tê"`, `"tờ - ôi - tôi"`, `"mờ - e - me - nặng - mẹ"`, `"gi - a - gia - huyền - già"`, `"quờ - a - qua - hỏi - quả"`.

### 2.3 Hành vi tự nhiên của trẻ 6–7 tuổi khi đánh vần
- **Lặp âm / ngập ngừng / tự sửa giữa chừng:** `"ê... ê... tờ... ê... tê"`, `"tờ... tờ... ôi... tôi"`.
- **Từ đệm tự nhiên khi tìm dấu thanh:** `"cờ... a... ca... à sắc... cá"`, `"mờ... e... me... dấu nặng... mẹ"`.
- **Vần khép kết thúc bằng `c, ch, p, t`:** khi phát âm rời luôn mang thanh sắc (`ước`, `át`, `ắc`, `ấp`) trước khi gắn thanh sắc hoặc thanh nặng.
- **Quy tắc chính tả âm đầu đặc biệt:** `c/k/qu` (`cờ / ca / quờ / cờ-u`), `g/gh` (`gờ`), `ng/ngh` (`ngờ`), `gi` (`di / giờ`).

---

## 3. Bảng chịu lỗi biến âm STT thực tế (ASR Phonetic Tolerance) & Ràng buộc an toàn tuyệt đối

### 3.1 Nguyên tắc bất biến chống chấm đúng nhầm (`G1 = 0 false-correct`)
- Bảng chịu lỗi biến âm STT **CHỈ áp dụng cho các âm đệm đánh vần đứng trước tiếng đích cuối cùng** (`index < finalTargetIndex`).
- **Tiếng chốt cuối cùng** bắt buộc phải khớp chính xác từ đích trên sách sau chuẩn hóa NFC (giữ nguyên 100% nguyên âm `a/ă/â`, `e/ê`, `o/ô/ơ`, `u/ư`, phụ âm `d/đ`, và 6 thanh điệu):
  - `"ê tờ ê tê"` cho `"tê"` → **CHẤP NHẬN** (`MATCH`).
  - `"ê tơ ê tê"` / `"ế tờ ê tê"` cho `"tê"` → **CHẤP NHẬN** (`MATCH` — biến âm STT ở âm đệm, tiếng chốt `"tê"` chuẩn xác).
  - `"ê tờ ê tề"` hoặc `"ê tờ ê tế"` cho `"tê"` → **TỪ CHỐI 100%** (tiếng chốt sai thanh điệu!).
  - Đọc đơn lẻ 1 tiếng `"ma"` cho `"má"` → **TỪ CHỐI 100%** (`SUBSTITUTE`, phân loại lỗi Nhóm A — sai dấu thanh).

### 3.2 Bảng ánh xạ biến âm STT cho âm đệm đánh vần
- **Phụ âm đọc tên bị rơi/lệch dấu thanh:**
  - `b`: `bờ, bơ, bợ, bê, b`
  - `c`: `cờ, cơ, cợ, ca, kờ, xê, c`
  - `k`: `ca, cờ, cơ, kờ, kơ, k`
  - `d`: `dờ, dơ, giờ, dê, d`
  - `đ`: `đờ, đơ, đợ, đê, đ`
  - `g / gh`: `gờ, gơ, ghờ, giê, g, gh`
  - `gi`: `gi, di, giờ, giơ, dờ, dơ, gờ, i`
  - `h`: `hờ, hơ, hát, h`
  - `l`: `lờ, lơ, l`
  - `m`: `mờ, mơ, mợ, m`
  - `n`: `nờ, nơ, n`
  - `p`: `pờ, pơ, pê, p`
  - `ph`: `phờ, phơ, pờ, hờ, ph`
  - `q / qu`: `quờ, quơ, cu, cờ, cơ, u, q, qu`
  - `r`: `rờ, rơ, r`
  - `s`: `sờ, sơ, xờ, s`
  - `t`: `tờ, tơ, tợ, tở, từ, tê, t`
  - `th`: `thờ, thơ, tờ, hờ, th`
  - `tr`: `trờ, trơ, chờ, tờ, rờ, tr`
  - `ch`: `chờ, chơ, cờ, hờ, ch`
  - `kh`: `khờ, khơ, ca, cờ, hờ, kh`
  - `ng / ngh`: `ngờ, ngơ, nghờ, nờ, gờ, hờ, ng, ngh`
  - `nh`: `nhờ, nhơ, nờ, hờ, nh`
  - `v`: `vờ, vơ, vê, v`
  - `x`: `xờ, xơ, sờ, x`
- **Nguyên âm đơn rời bị STT gắn thanh hoặc âm đệm `h`:**
  - `a`: `a, á, à, ả, ạ, ha`
  - `ă`: `ă, á, ắ, ằ`
  - `â`: `â, ớ, ơ, ấ, ầ`
  - `e`: `e, é, è`
  - `ê`: `ê, ế, ề, ể, ệ, hê`
  - `i / y`: `i, í, ì, y, ý, ỳ`
  - `o`: `o, ó, ò, ho`
  - `ô`: `ô, ố, ồ, ổ, ộ, hô`
  - `ơ`: `ơ, ớ, ờ, ở, ợ, hơ`
  - `u`: `u, ú, ù`
  - `ư`: `ư, ứ, ừ`
- **Tên thanh điệu bị STT nghe lệch nhẹ & từ đệm ngập ngừng:**
  - `sắc`: `sắc, sắt, xắc`
  - `huyền`: `huyền, hiền`
  - `hỏi`: `hỏi`
  - `ngã`: `ngã, ngả`
  - `nặng`: `nặng, nặn`
  - Từ đệm ngập ngừng hợp lệ giữa chuỗi đánh vần (không được đứng một mình): `dấu, à, ờ, ừm`.

### 3.3 Bộ đệm `SpellingBuffer` & Hạ ngưỡng Confidence có kiểm soát
- **`SpellingBuffer` trong `RealtimeAlignmentEngine`:**
  - Gắn trực tiếp với `currentBookIndex` / `wordId` hiện tại, cửa sổ sống `6.000 ms` tính từ âm đánh vần gần nhất.
  - Khi nhận từng gói `isFinal` rời (`"ê"` → `"tờ"` → `"ê"` → `"tê"`): gom tích lũy vào `SpellingBuffer`. Chừng nào chuỗi tích lũy còn là tiền tố đánh vần hợp lệ (`isPhonicsInProgress`), giữ `spellingInProgress = true` và **tuyệt đối không đẩy vào `pendingToken`** (tránh nổ `SUBSTITUTE` đỏ và giữ im timer nhắc tự động). Ngay khi tiếng đích xuất hiện (`matchPhonicsSpelling`), xác nhận `MATCH`, gắn `spelledOutWordIds`, xóa `SpellingBuffer` và tiến con trỏ sang từ kế tiếp.
- **Ngưỡng confidence trình duyệt cho âm đánh vần (`>= 0.28`):**
  - Giữ nguyên `hasUsableBrowserConfidence >= 0.50` cho lời đọc thường để bảo vệ chống nhiễu/tiếng nền.
  - Bổ sung `hasUsablePhonicsBrowserConfidence >= 0.28` chỉ kích hoạt khi chuỗi đang xét khớp âm đánh vần hợp lệ của từ hiện tại (hoặc kết hợp cùng `SpellingBuffer` hiện có).

---

## 4. Thiết kế Luồng Tương tác Cảm xúc chuẩn Tâm lý Học sinh Tiểu học

### 4.1 Phản hồi ấm áp sau nhịp tự sửa ngắn (~1.4 giây) khi bé đọc sai
- Khi bé đọc một từ lệch với từ sách hiện tại (không phải âm đánh vần đang dở, không phải từ lặp):
  1. **Nhịp chờ tự sửa (`1.400 ms`):** Cho phép trẻ tự phát hiện và đọc sửa lại ngay trong nhịp thở. Nếu trẻ tự sửa đúng trước khi hết nhịp chờ → hủy ngay lịch nhắc lỗi, không cắt lời trẻ, ghi nhận trẻ tự sửa giỏi.
  2. **Nếu sau `1.400 ms` trẻ dừng lại và chưa sửa được (`assist = true`):** Chốt trạng thái cần hỗ trợ trên từ hiện tại và **lập tức lên tiếng vỗ về 2–3 câu giàu cảm xúc** theo đúng loại lỗi (`classifyReadingMistake`):
     - **Nhóm A (`TONE`) — Đúng chữ nhưng nhầm dấu thanh** (ví dụ `"má"` đọc thành `"ma"`, `"mèo"` đọc `"méo"`): ≥ 8 biến thể nhiều câu ấm áp, chỉ rõ chữ chỉ khác dấu thanh trên/dưới để bé nhìn lại dấu.
     - **Nhóm B (`NEAR_SOUND`) — Nhầm cặp âm đầu / vần gần âm phổ biến Lớp 1** (`d/đ/gi`, `s/x`, `ch/tr`, `l/n`, `c/k/qu`, `g/gh`, `ng/ngh`, `r/d`, `t/th`, `b/p`, `an/ang/anh`, `ăn/ăng`, `ân/âng`, `ôn/ông`, `at/ac/ach`, `ăt/ăc`, `iê/ươ/uô`, `o/ô/ơ`, `e/ê`, `a/ă/â`, `u/ư`, `ai/ay/ây`, `ao/au/âu`, `oi/ôi/ơi`): ≥ 8 biến thể nhiều câu đồng cảm rằng hai âm rất giống nhau, hướng dẫn nhìn kỹ âm đầu/vần.
     - **Nhóm C (`GENERAL`) — Đọc lệch sang từ khác hoặc lúng túng:** ≥ 10 biến thể nhiều câu vỗ về chống sợ sai, trấn an rằng có cô ngồi đọc cùng con.

### 4.2 Cô giáo đánh vần mẫu từng bước (`generateSpokenPhonicsGuide`) & Thang 4 bước giàu tình cảm
- Hàm `generateSpokenPhonicsGuide(word)` tự động tách âm đầu – vần – thanh của mọi từ tiếng Việt để tạo câu hướng dẫn đánh vần chuẩn SGK Lớp 1:
  - Từ vần đơn không dấu (`"tê"`): *"Mình đánh vần chậm cùng cô nhé: tờ... ê... tê! Đọc trơn là: tê. Giờ con đọc thử cùng cô nào!"*
  - Từ vần đơn có dấu (`"cá"`): *"Con nghe cô đánh vần nhé: cờ... a... ca... sắc... cá! Đọc trơn là: cá. Đến lượt con giỏi lắm nào!"*
  - Từ vần ghép (`"tôi"`): *"Mình ghép vần cùng cô nha: ô... i... ôi, tờ... ôi... tôi! Đọc trơn là: tôi. Con thử đọc lại chữ ‘tôi’ nhé!"*
  - Từ không có âm đầu (`"ăn"`): *"Mình ghép vần cùng cô nhé: ă... nờ... ăn! Đọc trơn là: ăn. Giờ con đọc thử cùng cô nào!"*
- **Thang nâng đỡ 4 bước khi bé sai nhiều lần ở cùng một từ:**
  1. **Lần sai 1:** An ủi nhiều câu ấm áp theo Nhóm A / B / C + mời bé tự nhìn chữ thử lại.
  2. **Lần sai 2:** Vỗ về dịu dàng + phát câu đánh vần từng bước `generateSpokenPhonicsGuide(word)` + phát mẫu từ chậm rõ (`speedScale: 0.75`) + mời bé đánh vần hoặc đọc trơn theo.
  3. **Lần sai 3:** Khen ngợi sự kiên trì + đọc mẫu cụm 2–3 từ chứa từ đó + mời bé đọc nối theo cụm.
  4. **Lần sai 4 (Hết lượt thử):** Khen ngợi lòng dũng cảm và nỗ lực bằng lời thoại nhiều câu ấm áp (≥ 6 biến thể), cất từ vào giỏ luyện sau (`assisted` / Cần luyện lại — **không bao giờ tô xanh lượt đầu**), rồi mời đọc lại trọn câu nếu câu có dấu kết thúc (G20).
- Mọi câu thoại cô giáo đều đi qua `speakGuarded` (`EchoGuard` + đuôi bảo vệ `1.500 ms`), đảm bảo **0%** tiếng cô giáo bị nhận nhầm thành giọng bé.

### 4.3 Khích lệ khi vượt qua từ khó, Bong bóng đồng hành & Tùy chọn phụ huynh
- **Bong bóng Cô giáo đồng hành (`ReadingCompanionBubble`):** Đặt cố định gọn gàng trong bố cục đọc (không đè lên trang sách, chiều cao ổn định không gây nhảy dòng), đồng bộ biểu cảm (`listening`, `comforting`, `teaching`, `celebrating`) và lời thoại với giọng nói.
- **Ăn mừng khi bé tự sửa đúng / đánh vần thành công từ khó:** Cập nhật lời khen ngay trên bong bóng đồng hành; chỉ phát lời khen ngắn bằng giọng nói khi bé đang ở cuối câu hoặc tạm nghỉ hơi để tuyệt đối không cắt ngang luồng đọc nối tiếp của trẻ.
- **Tùy chọn phụ huynh trong Cài đặt Giọng đọc (`Phong cách hướng dẫn`):**
  - **Dịu dàng chi tiết (Lớp 1)** *(mặc định)*: Lời thoại an ủi nhiều câu giàu cảm xúc + hướng dẫn đánh vần từng âm.
  - **Ngắn gọn (Đọc thạo)**: Phản hồi ngắn gọn 1 câu cho bé Lớp 2+ đã đọc nhanh, vẫn giữ đầy đủ `EchoGuard` và quy tắc chấm điểm.
