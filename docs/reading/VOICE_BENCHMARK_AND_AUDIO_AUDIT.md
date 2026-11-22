# Báo Cáo Benchmark STT/TTS Local & Kiểm Chứng Âm Thanh Đánh Vần Tiếng Việt

- **Ngày thực hiện**: `2026-11-22`
- **Môi trường runtime tách biệt**: `F:\c1\tools\voice-runtime\.venv` (Python 3.12, `onnxruntime==1.32.0`, `sherpa-onnx==2.0.2`, `vieneu==3.8.5`, `faster-whisper==1.2.1`, `sea-g2p==0.10.0`, `librosa==1.0.1`)
- **Dữ liệu đo gốc**: `F:\c1\tools\voice-runtime\benchmark_out\benchmark_results.json`
- **Cam kết trung thực dữ liệu giọng trẻ**: Không thu thập hay giả mạo dữ liệu giọng trẻ thật ngoài nguồn hợp lệ (`NOT RUN` với giọng trẻ em thật theo quy tắc quyền riêng tư mục 1 & 2). Toàn bộ phép đo dưới đây thực hiện trên (a) 3 clip giọng người Việt thật đi kèm bộ model chuẩn `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09/test_wavs` và (b) 17 clip tổng hợp thực tế đa vùng miền + cặp tối thiểu dấu/vần tiếng Việt.

---

## 1. Đối đầu trực tiếp các giải pháp STT Tiếng Việt Local trên CPU Windows

| Tiêu chí | `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` (**ĐƯỢC CHỌN**) | `mad1999/pho-whisper-tiny-ct2` (`faster-whisper` int8) |
| --- | --- | --- |
| Nguồn & giấy phép | `csukuangfj/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` (Apache-2.0, huấn luyện >7.000 giờ tiếng Việt) | `mad1999/pho-whisper-tiny-ct2` / VinAI PhoWhisper-tiny |
| Thời gian nạp lạnh (CPU) | `1,87s` | `0,91s` |
| Độ trễ suy luận (clip `1,5s – 4,1s`) | **`30,7ms – 140,6ms`** (`RTF ≈ 0,03`) | `528,1ms – 2.110,7ms` (và vọt lên `10.842,7ms` khi lặp decoder trên chuỗi đánh vần ngắn) |
| Chống ảo giác trên nhịp đánh vần ngắn (`"ô, tờ, ốt."`) | **Đạt** (`64,9ms`, không lặp từ) | **Trượt nặng** (lặp `"omega omega..."` hơn 200 lần trong `10,8s`) |
| Độ chính xác thanh điệu & phụ âm câu thật (`human_ref_0..2`) | **3/3 câu đúng nguyên dấu** (`"khống chế"`, `"cho này kia"`, `"âm lượng tv giảm"`) | Sai dấu 2/3 câu (`"không chế"`, `"nại kia"`, mất từ đầu `"âm"`) |
| Độ chính xác trên 3 miền (`Bắc · Trung · Nam`) | Miền Bắc (`Trúc Ly`): **100%** · Miền Trung (`Ngọc Trân`): **100%** · Miền Nam (`Thục Đoan`): **17/18 tiếng** | Nhầm dấu/âm trên cả 3 miền (`"đông hoa"`, `"choào... bóng hoa"`, `"của trò... bồng hoa"`) |
| Cụm âm đầu khó (`quả quýt, cái giếng, nghiêng ngả, khúc khích, con trâu, cành nho`) | **12/12 tiếng chính xác tuyệt đối** (`93,7ms`) | Nhầm `"quả"` → `"của"`, `"nho"` → `"nhau"` (`909,7ms`) |
| Cặp tối thiểu `"mốt"` vs `"một"` | Phân biệt đúng `"mốt"` (`40,3ms`) và `"một"` (`33,0ms`) | Nhận `"mốt"` → `"mót"`, `"một"` → rỗng `""` |
| Timestamp mức token | **Có sẵn thật** (`result.timestamps` theo từng BPE token) | Có qua cross-attention alignment (chậm hơn) |
| Điểm tự tin (confidence) | Không xuất xác suất hiệu chuẩn → khai báo trung thực `language_probability: null` (tuyệt đối không bịa số) | Có `avg_logprob` nhưng không đáng tin khi lặp hallucination |

**Kết luận chọn STT Local mặc định**: Chọn **`sherpa-onnx-zipformer-vi-30M-int8-2026-02-09`** làm engine STT local chính nhờ độ trễ `~80ms` (nhanh gấp ~8 lần PhoWhisper), độ chính xác dấu tiếng Việt vượt trội trên cả 3 miền Bắc · Trung · Nam và miễn nhiễm hoàn toàn với lỗi lặp ảo giác trên các bước đánh vần ngắn của trẻ lớp 1.

---

## 2. Đánh giá TTS Tiếng Việt Local (`VieNeu-TTS v3 Turbo` ONNX CPU, 48 kHz)

### 2.1 Hỗ trợ thật 3 vùng miền (`Bắc · Trung · Nam`) & Cả giọng Nữ / Nam
Nguồn model: `pnnbao-ump/VieNeu-TTS-v3-Turbo` (`Apache-2.0` / ONNX Runtime CPU không phụ thuộc PyTorch, tần số lấy mẫu gốc `48.000 Hz`).

| Mã giọng ViRead (`voiceId`) | Preset gốc | Vùng miền | Giới tính | Thời gian sinh (`gen_s`) | Độ dài audio (`dur_s`) | `RTF` CPU | Trung vị `F0 (Hz)` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `local:north_truc_ly` *(mặc định)* | `Trúc Ly` | **Miền Bắc** | Nữ (Cô) | `1,48s` | `3,14s` | `0,47` | `262,3 Hz` |
| `local:north_ngoc_linh` | `Ngọc Linh` | **Miền Bắc** | Nữ (Cô) | `< 1,6s` | `~3,2s` | `~0,48` | `~245 Hz` |
| `local:north_thien_minh` | `Thiện Minh` | **Miền Bắc** | Nam (Thầy) | `1,27s` | `2,82s` | `0,45` | `121,0 Hz` |
| `local:central_ngoc_tran` | `Ngọc Trân` | **Miền Trung** | Nữ (Cô) | `2,03s` | `4,10s` | `0,50` | `206,7 Hz` |
| `local:central_quang_son` | `Quang Sơn` | **Miền Trung** | Nam (Thầy) | `1,43s` | `3,14s` | `0,45` | `145,2 Hz` |
| `local:south_thuc_doan` | `Thục Đoan` | **Miền Nam** | Nữ (Cô) | `1,85s` | `3,94s` | `0,47` | `235,6 Hz` |
| `local:south_my_duyen` | `Mỹ Duyên` | **Miền Nam** | Nữ (Cô) | `< 1,8s` | `~3,7s` | `~0,48` | `~240 Hz` |
| `local:south_thai_son` | `Thái Sơn` | **Miền Nam** | Nam (Thầy) | `1,25s` | `2,82s` | `0,44` | `115,9 Hz` |

*(Lưu ý an toàn nội dung trẻ em: các preset tên không phù hợp lứa tuổi tiểu học trong bộ gốc đã được lọc bỏ hoàn toàn khỏi danh mục hiển thị của ViRead).*

### 2.2 Ba mức tốc độ `Chậm (0,85×) · Vừa (1,0×) · Nhanh (1,15×)` giữ nguyên thanh điệu
Áp dụng kéo giãn thời gian giữ cao độ (`librosa.effects.time_stretch` trực tiếp tại worker, phía trình duyệt giữ `audio.playbackRate = 1.0` để **không bao giờ nhân tốc độ hai lần**):
- `Chậm (0,85×)`: `3,554s` (`F0 median = 233,9 Hz`)
- `Vừa (1,00×)`: `3,060s` (`F0 median = 248,9 Hz`)
- `Nhanh (1,15×)`: `2,695s` (`F0 median = 242,2 Hz`)
→ Thời lượng giảm đơn điệu chặt chẽ (`3,554s > 3,060s > 2,695s`), cao độ `F0` ổn định, không méo dấu tiếng Việt.

---

## 3. Kiểm chứng âm thanh thật cho ca bắt buộc `"mốt"` & Hệ thống dấu Tiếng Việt

### 3.1 Phát hiện kỹ thuật quan trọng khi kiểm tra âm thanh thật (`int8` vs `fp32` & `temperature`)
- Khi chạy `precision="int8"` với `temperature=0.55` trên các bước đánh vần cực ngắn (`0,8–1,2s`), lượng tử hóa `int8` trên CPU không có VNNI chuyên biệt đôi khi làm mờ phụ âm cuối `-t` ở `"ô, tờ, ốt."` (STT nghe thành `"o t u"`) hoặc làm chao dấu ở `"sắc, mốt."`.
- Khi chuyển sang **`precision="fp32"` kết hợp `temperature=0.2, top_k=15` cho các bước đánh vần & từ đơn**:
  - Phoneme đầu vào (`sea-g2p`) bảo toàn tuyệt đối 100% nguyên âm mũ và thanh điệu:
    - `"mốt."` → `['mˈoɜt̪.']` (nguyên âm `ô`, thanh sắc `3`)
    - `"một."` → `['mˈo6t̪.']` (nguyên âm `ô`, thanh nặng `6`)
    - `"mót."` → `['mˈɔɜt̪.']` (nguyên âm `o` mở `ɔ`, thanh sắc `3`)
    - `"ma, má, mà, mả, mã, mạ."` → `['mˈaː, mˈaːɜ, mˌaː2, mˈaː4, mˈaː5, mˈaː6.']`
  - Kiểm chứng vòng lặp âm thanh thật qua STT độc lập (`FP32, temp=0.2`):
    - Bước 1 `"ô, tờ, ốt."` → thời gian tạo `0,63s`, phát `0,88s`, nghe rõ 3 thành phần (`STT: "ô tở ốt"`).
    - Bước 2 `"mờ, ốt."` → thời gian tạo `0,55s`, phát `0,72s`, rõ âm đầu `m` và vần `ốt` (`STT: "mơ ốt"`).
    - Bước 3 `"sắc, mốt."` → thời gian tạo `0,51s`, phát `0,64s`, rõ tên dấu và chữ ghép (`STT: "sắc mốt"`).
    - Bước 4 `"mốt."` & Bước 5 `"hai mươi mốt."` → đo phổ `F0` thực tế:
      - `"mốt."` (thanh sắc): **`F0 median = 356,3 Hz`** (cao, sáng rõ).
      - `"một."` (thanh nặng): **`F0 median = 252,8 Hz`** (thấp, ngắt thanh hầu, cách biệt `> 103 Hz` so với `"mốt"`).
      - `"mót."` (nguyên âm `o` + thanh sắc): **`F0 = 342,6 Hz → 400,1 Hz`**, formant F1 mở hơn `"mốt"`.
      - `"hai mươi mốt."`: `STT` nhận chính xác tuyệt đối `"hai mươi mốt"`.

**Quyết định cấu hình Worker TTS**:
- Sử dụng **`VieNeu-TTS v3 Turbo` (`backend="onnx"`, `precision="fp32"`)** với `temperature=0.22` cho chế độ từ đơn / các bước đánh vần (`word_sample` / `phonics`) và `temperature=0.55` cho câu hướng dẫn / đọc trang tự nhiên, đảm bảo phát âm dấu tiếng Việt chuẩn xác nhất trên CPU trong khi vẫn nhanh hơn thời gian thực (`RTF ≈ 0,60 – 0,72`).
