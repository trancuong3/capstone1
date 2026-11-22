# Nghiên cứu Chuyên sâu: Tâm lý, Ngữ âm & Thói quen Đọc của Trẻ Tiểu học Việt Nam (5–9 tuổi)

> Tài liệu đặc tả sư phạm & kỹ thuật nền tảng cho đợt nâng cấp **ViRead — Cô giáo / Thầy giáo AI** trên nhánh `feat/local-voice-first-20261122`.

---

## 1. Đặc trưng Giọng nói & Ngữ âm Trẻ nhỏ Việt Nam (5–9 tuổi)

Trẻ em Việt Nam trong giai đoạn Tiền tiểu học đến Lớp 3 có đặc điểm âm học và ngữ âm khác biệt hoàn toàn so với người lớn — là nguyên nhân gốc khiến các pipeline STT/VAD mặc định dễ bỏ sót tiếng hoặc chấm đỏ nhầm:

| Đặc trưng | Biểu hiện thực tế ở trẻ 5–9 tuổi | Hệ quả nếu hệ thống dùng cấu hình người lớn | Giải pháp kỹ thuật trên ViRead |
|---|---|---|---|
| **Biên độ âm thanh nhỏ & không đều** | Nhiều bé nhút nhát đọc khẽ, hoặc hạ giọng ở cuối câu / các thanh trắc thấp (`huyền`, `nặng`, `hỏi`). | Ngưỡng VAD cứng (`RMS >= 0.013`) không mở cổng ghi âm hoặc cắt sớm nửa sau của tiếng. | VAD thích nghi theo nhiễu nền (`onset = max(0.004, noiseFloor * 2.2)`, `hold = max(0.0025, noiseFloor * 1.5)`), kèm chuẩn hóa biên độ mềm (AGC) ở Local Voice Worker. |
| **Tần số cơ bản (F0) cao & kéo dài nguyên âm** | Giọng trẻ có F0 cao (~250–400 Hz), thường kéo dài nguyên âm khi đang dò chữ (`"môôôi..."`). | Cắt đoạn quá ngắn (`2.6s`) làm đứt giữa tiếng; thiếu đệm đầu/cuối làm Zipformer rơi âm tiết cuối. | Tăng cửa sổ đoạn tối đa (`4.2s`) có chồng lấn (`240ms`), chèn đệm im lặng `250ms` đầu + `350ms` cuối trước khi giải mã Sherpa-ONNX. |
| **Nhịp ngắt quãng giữa từng tiếng** | Đọc chậm từng tiếng hoặc dừng `350–600ms` để nhìn chữ kế tiếp. | `SILENCE_FLUSH_MS = 380ms` cắt rời chuỗi đánh vần thành nhiều mảnh nhỏ mất ngữ cảnh. | Nâng `SILENCE_FLUSH_MS = 520ms`, giữ `MIN_SPEECH_MS = 140ms` để không rơi từ đơn ngắn (`cá`, `ba`, `tự`). |
| **Biến âm / ngọng theo vùng miền & lứa tuổi** | Phổ biến nhất: `l/n` (Bắc), `ch/tr`, `s/x`, `r/d/gi`, `hỏi/ngã` (Trung/Nam), vần cuối `-n/-ng`, `-t/-c`, `v/d` (Nam). | Bắt buộc khớp cứng tuyệt đối trên âm đệm đánh vần gây lỗi giả; trong khi thả lỏng hoàn toàn trên tiếng chốt lại gây chấm đúng nhầm (false-correct). | Chấp nhận biến âm có kiểm soát ở **âm đệm đánh vần** và phân loại lỗi tinh (`TONE`, `NEAR_SOUND`, `GENERAL`) khi bé đọc trơn để vỗ về đúng lỗi, tuyệt đối không chấm sai dấu thành đúng. |

---

## 2. Thói quen Đọc & Đánh vần Thực tế của Học sinh Việt Nam (GDPT 2018)

### 2.1 Ba kiểu đọc phổ biến nhất trong thực tế
1. **Đánh vần từng tiếng đơn lẻ rồi đọc trơn:**
   - Kiểu Vần trước – Âm đầu sau: `"ê - tờ - ê - tê"`, `"ô - i - ôi - mờ - ôi - môi"`.
   - Kiểu Âm đầu – Vần – Thanh – Đọc trơn: `"tờ - ư - tư - nặng - tự"`.
2. **Đánh vần chuỗi 2–4 tiếng liên tiếp rồi mới đọc trơn cả cụm/câu (Rất phổ biến ở trẻ Lớp 1–2):**
   - Ví dụ với cụm **`"môi trường tự nhiên"`**:
     > *"ô i ôi mờ ôi môi, ư ơ ngờ ương trờ ương trương huyền trường, ư nặng ự tờ ư tư nặng tự, i ê nờ iên nhờ iên nhiên — môi trường tự nhiên!"*
   - **Vì sao hệ thống cũ bị hỏng ở ca này?**
     - Âm vần có dấu không có âm cuối như `"ự"` (trong `"tự"`) trước đây bị thiếu khỏi `buildPhonicsCueSet("tự")`.
     - Khi một đoạn STT chứa âm đệm đánh vần của 2–4 từ nối tiếp nhau, `isPhonicsInProgress` chỉ kiểm tra duy nhất 1 từ hiện tại → trả về `false` → rơi vào `processToken` → `pendingToken` coi từng âm đệm (`"ư"`, `"nặng"`, `"ự"`, `"i"`, `"ê"`, `"nờ"`) là một lần đọc sai và **đẩy con trỏ nhảy vọt qua 4–8 từ kế tiếp, bôi đỏ hàng loạt cả dòng sách**!
   - **Quy tắc sư phạm & kỹ thuật bắt buộc:**
     - Bộ alignment phải nhận diện được **âm đệm đánh vần nằm trong cửa sổ cụm 2–4 từ kế tiếp** (`SPELLING_IN_PROGRESS` / multi-word phonics buffer).
     - **Bất biến an toàn:** Các âm đệm đánh vần (`ô`, `i`, `mờ`, `trờ`, `nặng`, `huyền`, `hỏi`, `ngã`, `sắc`, `ự`, `iên`...) **TUYỆT ĐỐI KHÔNG** được kích hoạt `SUBSTITUTE` (đỏ) hay đẩy con trỏ bỏ qua từ chưa đọc.
     - Chấp nhận cả hai cách kết thúc tự nhiên của trẻ: (a) đánh vần tiếng nào chốt xanh tiếng đó rồi sang tiếng tiếp theo, hoặc (b) đánh vần xong cả 2–4 tiếng rồi đọc trơn cả cụm `"môi trường tự nhiên"` → chốt xanh mượt mà toàn bộ cụm từ.
3. **Đọc nhẩm nhỏ, đọc lặp lấy đà, hoặc dừng nhìn chữ giữa câu:**
   - Không phạt đỏ khi trẻ lặp lại 1–2 từ vừa đọc đúng để lấy đà đọc từ khó kế tiếp.
   - Cho trẻ nhịp tự sửa ngắn (`~1.4s`) trước khi Cô/Thầy giáo lên tiếng gợi ý.

---

## 3. Phân loại Tính cách & Trạng thái Tâm lý Khi Đọc → Chiến lược Phản hồi Thích ứng

| Nhóm tính cách / Trạng thái | Dấu hiệu quan sát được trên hệ thống | Điều cần TRÁNH | Chiến lược của Cô giáo / Thầy giáo AI |
|---|---|---|---|
| **Trẻ nhút nhát, sợ sai** | Giọng nhỏ, ngập ngừng lâu trước từ mới, hay dừng khi thấy màu đỏ. | Không tô đỏ hàng loạt; không nhắc giọng khô cứng hay cắt ngang khi bé đang ghép vần. | Dùng lời vỗ về ấm áp, giảm áp lực (*"Không sao đâu con, chữ này hơi khó một chút, mình cùng đánh vần chậm nhé"*), hạ ngưỡng VAD nhạy giọng nhỏ. |
| **Trẻ hay đánh vần chuỗi dài** | Đánh vần 2–4 tiếng liên tục trước khi đọc trơn cả cụm. | Không nhảy con trỏ sớm khi bé đang đánh vần; không ngắt lời bằng câu nhắc im lặng. | Giữ trạng thái "đang đánh vần" dịu mắt; khi bé ghép và đọc trơn thành công thì khen đúng nỗ lực đánh vần. |
| **Trẻ đọc nhanh, dễ bỏ chữ / lướt dấu** | Tốc độ nhanh, hay nhầm thanh điệu (`ma/má`, `tự/tứ`) hoặc nhảy qua từ ngắn. | Không chê bai trực diện. | Nhắc nhẹ vui vẻ chú ý dấu thanh (*"Con đọc nhanh lắm, chỉ cần thêm dấu sắc trên chữ này nữa là chuẩn luôn!"*). |
| **Trẻ dễ nản khi vấp nhiều lần** | Vấp ≥ 2–3 lần trên cùng 1 từ khó hoặc từ viết hoa/từ dài. | Không lặp lại cùng một câu nhắc máy móc. | Thang nâng đỡ 4 bước giàu cảm xúc: tự sửa → đánh vần từng bước → đọc mẫu theo cụm → khen lòng kiên trì và cất vào giỏ ôn cuối bài. |
| **Trẻ hào hứng, thích trò chuyện** | Đọc trôi chảy nhiều từ liền, trả lời nhanh khi hoàn thành trang/bài. | Không kết thúc bài đột ngột im lặng. | Luân phiên lời khen đa dạng theo chuỗi đọc trôi chảy, chủ động hỏi bằng giọng nói cuối bài (*"Con có muốn cùng cô/thầy đọc lại vài từ khó lúc nãy không?"*) rồi dẫn sang câu hỏi hiểu bài. |

---

## 4. Nguyên tắc Sư phạm, Persona Đồng bộ & Minh bạch Nguồn Giọng nói

1. **Một giọng đọc — Một nhân vật xuyên suốt toàn buổi học:**
   - Giọng nữ → **Cô giáo AI** (nhân xưng nhất quán `"cô"`, avatar/nhãn Cô giáo AI).
   - Giọng nam → **Thầy giáo AI** (nhân xưng nhất quán `"thầy"`, avatar/nhãn Thầy giáo AI).
   - Đồng bộ tuyệt đối 100% từ **Đọc sách → Đọc lại từ sai cuối bài → Màn Luyện từ khó → Đánh vần từng bước → Câu hỏi hiểu bài**. Không bao giờ xảy ra hiện tượng đọc sách giọng nữ nhưng sang ôn từ sai/từ khó lại đổi sang giọng nam.
2. **Đọc mẫu chuẩn dấu 100% tiếng Việt:**
   - Chuẩn hóa chữ IN HOA (`TRƯỜNG`, `TOÁN`, `PHAN`, `NHI`, `BẬC`), số đếm, khoảng năm (`2024-2025`), mã chữ-số (`MTH-341`), và chặn lỗi `sea_g2p` đọc nhầm tiếng Việt không dấu (`me`, `an`, `em`, `no`, `to`, `be`) hoặc nguyên âm đơn (`â`, `ă`, `đ`) sang tiếng Anh.
3. **Minh bạch nguồn STT & TTS theo thời gian thực:**
   - Hiển thị rõ nguồn đang hoạt động thực tế theo thứ tự ưu tiên:
     1. **Ưu tiên 1 (Offline trên máy):** `STT: Offline (Sherpa-ONNX)` · `TTS: Offline (VieNeu-TTS)`
     2. **Dự phòng 1 (khi Local lỗi & phụ huynh bật cho phép):** `Google Cloud API`
     3. **Dự phòng cuối (khi cả Local & Google lỗi/tắt):** `Trình duyệt mặc định`
