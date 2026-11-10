# Hợp đồng ba màu cho OCR Admin và kết quả đo

Tài liệu này mô tả luật tô màu từng từ ở màn Admin OCR Review, nguyên nhân gốc
của hiện tượng "từ đúng vẫn bị vàng", những gì đã sửa và số liệu đo được.
Số liệu chi tiết của lần chạy mới nhất nằm ở
[ocr-color-benchmark.md](ocr-color-benchmark.md).

## 1. Ý nghĩa ba màu

| Màu | Trạng thái | Điều kiện |
|---|---|---|
| Xanh | Đã xác nhận đúng | Khớp reference đã xác minh qua ánh xạ một-một, **hoặc** (khi chưa có reference) hai engine tiếng Việt độc lập đọc cùng một token |
| Đỏ | Đã xác nhận sai | Chỉ khi có reference đã xác minh, ánh xạ một-một rõ ràng và token đang lưu khác reference |
| Vàng | Chưa đủ bằng chứng | Mọi trường hợp còn lại |

Đây là ba kết luận, không phải ba mức confidence. Raw score, trạng thái trang,
token bên cạnh, cache hay fallback của frontend không tham gia quyết định màu.

## 2. Thứ tự ưu tiên (`classify_word_evidence`)

1. Có reference tin cậy (`verification_source` là `admin` hoặc
   `verified_revision`) và `reference_alignment` là `match`/`substitute`:
   token khớp reference → xanh; token khác reference và vẫn là token OCR gốc →
   đỏ; token đã bị sửa sang nội dung khác → vàng cho tới khi được xác minh lại.
2. Có provenance reference nhưng ánh xạ không một-một (`insert`, `unmatched`,
   `ambiguous`) → vàng.
3. Admin đã xác minh từng từ (`verified`) → xanh.
4. Không có reference → phân xử bằng chứng engine (`adjudicate_word`), không
   bao giờ ra đỏ.

Frontend (`getWordReviewColorGroup`) dùng màu do backend trả về. Khi payload cũ
không có màu, hoặc khi Admin vừa sửa một token, frontend tính lại bằng cùng luật.
Hai phía được đối chiếu trên 706 ca xuất từ backend
(`frontend/tests/admin/fixtures/ocr-color-parity.json`).

## 3. Nguyên nhân gốc đã tìm thấy

| Tầng | Lỗi | Hệ quả |
|---|---|---|
| Recognition | PaddleOCR 2.7 `lang="vi"` dùng model nhận dạng Latin, không xuất được phần lớn chữ tiếng Việt (`Hôm` → `Höm`, `ngồi` → `ngi`, `BỮA` → `BU'A`) | Luật cũ đòi PaddleOCR và VietOCR đọc giống nhau nên gần như mọi từ có dấu đều vàng: chỉ 15,9% từ đúng được xanh |
| Crop dòng | Ảnh dòng đưa cho VietOCR bị kéo giãn 1,3 lần rồi thêm viền trắng; VietOCR luôn thu về cao 32 px nên dấu bị nhòe | Nhầm hỏi/huyền/ngã (`kể` → `kề`, `rỡ` → `rõ`); độ chính xác từ 90,7% |
| Tesseract | `TESSDATA_PREFIX` trỏ vào thư mục cha của `tessdata`; Tesseract 5 cần chính thư mục `tessdata` | Tesseract không nạp được tiếng Việt trên Windows, kể cả đường fallback |
| VietOCR | Cấu hình mặc định tải thêm backbone VGG19 (~550 MB) dù checkpoint đã có đủ trọng số | VietOCR không khởi tạo được khi không tải được file đó |
| Căn chỉnh reference | Một token thừa/thiếu ở bất kỳ đâu khiến mọi mismatch trên trang mất trạng thái `confirmed_mismatch`, trong khi evidence vẫn ghi `substitute` | Trạng thái và màu của cùng một từ mâu thuẫn nhau |
| Căn chỉnh reference | Từ bị đọc sai hoàn toàn bị tách thành delete + insert | Từ sai rõ ràng giữa hai từ đúng lại ra vàng |
| Evidence | `source_text` rỗng khi engine được chọn trả chuỗi rỗng | Mismatch đã xác minh bị hạ xuống vàng |
| Frontend | Token vừa sửa vẫn giữ màu cũ của server | Màu hiển thị không phản ánh nội dung đang sửa |
| Frontend/API | Trang `VERIFIED` ghi đè trạng thái từ thành `verified` kể cả từ đang đỏ | Nhãn trạng thái không khớp màu |
| Crop từ | Tỷ lệ mực tính theo điểm tối nên chữ sáng trên nền tối bị loại | Không dùng được crop cho trang nền tối |

## 4. Những gì đã thay đổi

- **Ba engine, hai engine tiếng Việt.** Tesseract (`vie`) đọc cả trang một lần
  (≈0,3 s), được ghép với từng dòng theo vùng phủ và ghép token theo cùng thuật
  toán căn chỉnh đang dùng giữa PaddleOCR và VietOCR. Ảnh được chuẩn hóa nền
  trước khi đưa vào Tesseract để chịu được bóng đổ và ánh sáng không đều.
- **Luật xác nhận** (`backend/app/services/ocr_adjudication.py`): xanh khi
  VietOCR và Tesseract đọc cùng token NFC, không có lượt đọc nào của hai engine
  này khác dấu trên cùng chữ cái gốc, và số lượt ủng hộ nhiều hơn số lượt phản
  bác. PaddleOCR không được dùng để phản bác một cách đọc tiếng Việt. Evidence
  cũ chưa có Tesseract giữ nguyên chuẩn trước đây (PaddleOCR + VietOCR giống
  nhau).
- **Chọn candidate tách khỏi xác nhận.** Khi nhiều lượt đọc của engine tiếng
  Việt ủng hộ một candidate khác với candidate đang chọn, văn bản hiển thị được
  đổi sang candidate đó nhưng từ vẫn vàng nếu chưa đủ điều kiện xác nhận. Văn
  bản trước khi đổi và output gốc của từng engine được giữ trong evidence.
- **Crop.** Ảnh dòng cho VietOCR không còn bị kéo giãn. Crop từ chỉ chạy cho
  những từ hai engine tiếng Việt chưa thống nhất; Tesseract đọc thêm crop đó.
- **Reference.** Tính mơ hồ được xét theo từng token: substitution kề một
  token thừa/thiếu hoặc nằm trong nhóm split/merge là `ambiguous` (vàng), các
  mismatch khác trên trang vẫn đỏ. Một cặp delete + insert đơn lẻ giữa hai
  token đã ghép được coi là thay thế một-một.
- **Không đổi schema.** Các trường mới nằm trong `crop_evidence` (vốn là
  object tự do ở Pydantic và Zod) và `engine_outputs.tesseract` đã có sẵn. Không
  có migration.

## 5. Kết quả đo

Đo trên 45 ảnh trong `backend/tests/fixtures/ocr/` (15 điều kiện ảnh × 3 trang,
943 từ ground truth). Ground truth là văn bản được soạn rồi vẽ thành ảnh, không
lấy từ kết quả OCR.

| Chỉ số | Trước (commit `408fd13`) | Sau |
|---|---|---|
| Exact word accuracy | 855/943 = 90,7% | 924/943 = 98,0% |
| CER trung bình | 0,0317 | 0,0143 |
| GREEN precision (chưa có reference) | 136/145 = 93,8% | 882/882 = 100% (CI 95%: 99,6–100%) |
| GREEN recall trên từ đúng | 136/855 = 15,9% | 882/924 = 95,5% (CI 95%: 93,9–96,6%) |
| Từ đúng bị vàng | 719/855 = 84,1% | 42/924 = 4,5% |
| Từ đúng → xanh khi có reference | không đo riêng | 924/924 = 100% |
| Từ sai → đỏ khi có reference | không đo riêng | 17/17 = 100% |
| Thời gian mỗi trang (CPU) | 3,84 s | 2,34 s |

Cột "Trước" được đo bằng cùng script trên mã nguồn trước thay đổi.

### Giới hạn của bằng chứng

- Ảnh là ảnh dựng bằng máy với một họ font. Đây là phép thử có kiểm soát, **chưa
  phải** bằng chứng về độ chính xác trên ảnh chụp/scan sách thật. Gate B chưa
  được tuyên bố đạt cho sách thật.
- RED precision khi có reference dựa trên 17 từ sai (CI 95%: 81,6–100%); cỡ mẫu
  nhỏ vì OCR sau khi sửa ít sai. Phần tất định (200 cặp từ sai × 9 biến thể trong unit
  test) đạt 100%.
- Hai engine tiếng Việt vẫn có thể cùng đọc sai một dấu trên ảnh nhiễu. Trong
  lần đo cuối không có trường hợp nào, nhưng ở một lần đo trung gian có 1 trường
  hợp (`bàn` → `bản`). Chỉ reference đã xác minh mới loại trừ được.
- Chữ sát mép ảnh (crop chạm biên) luôn vàng khi chưa có reference vì dấu có thể
  bị cắt.
- Chưa kiểm thử E2E trên giao diện thật với tài khoản Admin và Supabase; phần
  này cần được chạy thủ công.

## 6. Chạy lại

```powershell
# Từ thư mục backend, với môi trường đã cài PaddleOCR, VietOCR, Tesseract
python scripts/ocr_color_benchmark.py --report ../docs/ocr-color-benchmark.md
python scripts/export_ocr_color_parity.py   # sau khi đổi luật màu ở backend
python -m pytest test_ocr_color_matrix.py test_ocr_adjudication.py
```

```powershell
# Từ thư mục frontend
npm test -- tests/admin/ocr-word-color-matrix.test.ts
```

`test_ocr_adjudication.py::RealOcrFixtureGate` tự bỏ qua khi máy không có đủ
PaddleOCR, VietOCR và Tesseract; các test còn lại không cần engine.

## 7. Bộ kiểm thử

| Nhóm | Số kịch bản | Nơi đặt |
|---|---:|---|
| A. Nhận dạng tiếng Việt (dấu thanh, nguyên âm, đ, NFC/NFD, chữ hoa) | 60 | `test_ocr_adjudication.py::VietnameseTokenRules` |
| B. Chất lượng ảnh, chạy engine thật | 45 | `RealOcrFixtureGate`, `GroundTruthFixtures` |
| C. Bounding box và crop | 40 | `BoundingBoxAndCrop` |
| D. Đa engine | 45 | `MultiEngineEvidence` |
| E. Căn chỉnh reference | 35 | `ReferenceAlignment` |
| F. Phân loại, lưu trữ, sửa của Admin, 16 invariant | hơn 40 | `test_ocr_color_matrix.py` |
| G. Frontend và API | hơn 35, cộng 706 ca đối chiếu | `ocr-word-color-matrix.test.ts` |
| GREEN bắt buộc | 180 từ × 10 biến thể | `GreenHardAssertions` |
| RED bắt buộc | 200 cặp × 9 biến thể × 2 trạng thái trang | `RedHardAssertions` |
| Trang trộn màu | 10 kịch bản + ma trận 120 trang | `MixedPageScenarios` |
