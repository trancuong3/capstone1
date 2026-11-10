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
- (Đã thay đổi ở vòng 2, xem mục 8) Chữ sát mép ảnh không còn bị vàng chỉ vì crop
  chạm biên; chất lượng box được báo riêng.
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

## 8. Vòng 2: giảm vàng sai, dấu câu và hình học (2026-11-10)

Vòng này đo trên bộ fixture mở rộng: 63 trang, 21 điều kiện, 1.314 từ ground
truth (thêm font serif, font sách thiếu nhi, trang dày dấu câu, hội thoại và ma
trận 60 từ chỉ khác dấu). Cột "Trước" là mã nguồn ở commit `9e3e121` chạy trên
cùng bộ fixture.

### A. Vì sao từ đúng vẫn bị vàng (63 từ ở baseline)

| Nguyên nhân | Số từ | Tỷ lệ | Xử lý |
|---|---:|---:|---|
| Crop gate: crop chạm biên hoặc yếu dù hai engine tiếng Việt đã đồng thuận | 23 | 36,5% | Đã sửa: bỏ cổng crop/bbox khỏi kết luận văn bản |
| Hai engine tiếng Việt đọc khác dấu | 17 | 27,0% | Giữ vàng: chưa có căn cứ để chọn |
| Hai engine tiếng Việt đọc khác chữ | 10 | 15,9% | Giữ vàng |
| Tesseract không có token cho từ | 8 | 12,7% | Một phần được crop xác nhận; còn lại giữ vàng |
| Token mapping (split/merge) | 4 | 6,3% | Giữ vàng: không có ánh xạ một-một |
| Bbox gate: box không hợp lệ | 1 | 1,6% | Đã sửa như crop gate |

Sau khi sửa còn 42 từ, toàn bộ thuộc bốn nhóm "giữ vàng" ở trên; danh sách từng
từ kèm bằng chứng ở [ocr-false-yellow-report.md](ocr-false-yellow-report.md).
12 trong số đó nằm ở font sách thiếu nhi, nơi Tesseract đọc sai phần lớn.

### B. Thay đổi về nhận dạng

- **Giữ nguyên model.** VietOCR `vgg_transformer` và Tesseract `vie` là hai
  engine đọc tiếng Việt; PaddleOCR chỉ làm detector và bỏ phiếu dấu câu. Chưa
  tích hợp model PaddleOCR khác: các model nhận dạng tiếng Việt mới hơn cần
  PaddleOCR 3.x, không tương thích với bộ đã pin (PaddleOCR 2.7.3 +
  PaddlePaddle 2.6.2); việc nâng cả stack nằm ngoài phạm vi an toàn của vòng này.
- **Box đo thay cho box ước lượng.** Khi Tesseract và pipeline đọc cùng chữ
  cái, box của từ lấy từ box Tesseract đo được thay cho box chia tỷ lệ trong
  dòng. IoU trung bình 0,573 → 0,893.
- **Crop theo box mới** giúp lượt đọc lại của VietOCR trên từ tranh chấp đúng
  hơn (34/79 → 44/79), nhờ đó candidate hiển thị được đổi đúng thêm 4 từ.
- **Lượt đọc Tesseract trên crop từng từ kém** (8/79 đúng với box cũ, 26/79 với
  box mới): chỉ được dùng như một lượt đọc bổ sung, không tự xác nhận được từ.

### C. Tiếng Việt

| Chỉ số | Trước | Sau |
|---|---|---|
| Dấu thanh | 903/931 = 97,0% | 907/931 = 97,4% |
| Dấu mũ/trăng/râu | 554/568 = 97,5% | 554/568 = 97,5% |
| Chữ đ | 68/69 = 98,6% | 68/69 = 98,6% |

Lỗi còn lại tập trung ở: mất dấu huyền (7), mất dấu râu của ơ (8, chủ yếu
`rỡ` → `rõ` do VietOCR), và font sách thiếu nhi (14/54 từ sai). Ma trận nhầm lẫn
đầy đủ ở [ocr-color-benchmark.md](ocr-color-benchmark.md).

### D. Dấu câu

| Chỉ số | Trước | Sau | Mục tiêu |
|---|---|---|---|
| Precision | 181/191 = 94,8% | 207/216 = 95,8% | ≥ 98% |
| Recall | 181/224 = 80,8% | 207/224 = 92,4% | ≥ 98% |
| F1 | 0,872 | 0,941 | |
| Ranh giới câu (. ! ?) | 129/166 = 77,7% | 152/166 = 91,6% | |

- Baseline mất 33 dấu chấm cuối câu vì VietOCR hay bỏ dấu chấm và bước chuyển
  dấu câu từ PaddleOCR không gồm dấu chấm.
- Dấu câu đầu/cuối mỗi từ nay được quyết định bằng đa số giữa các engine đã đọc
  đúng chữ cái của từ đó (cần ít nhất hai engine, hòa thì giữ nguyên). Phần chữ
  không bị đụng tới; bề mặt trước khi đổi được lưu lại.
- Dấu câu đứng riêng (`–` đầu câu thoại, `...`) được giữ trong văn bản trang
  nhưng không thành token từ.
- Dấu nháy đơn và gạch nối ở mép từ (`'An'`) nay là dấu câu; trước đây chúng
  làm từ bị coi là từ khác và tô đỏ.
- Mỗi từ có thêm `punctuation_status` (`correct`, `incorrect`, `uncertain`,
  `consistent`, `not_assessed`), độc lập với màu của từ.

### E. Vàng sai

| Chỉ số | Trước | Sau | Mục tiêu | Đạt |
|---|---|---|---|---|
| GREEN precision | 1207/1207 = 100% | 1232/1232 = 100% (CI 95%: 99,7–100%) | ≥ 99% | Có |
| GREEN recall trên từ đúng | 1207/1270 = 95,0% | 1232/1274 = 96,7% (CI 95%: 95,6–97,6%) | ≥ 98% | Chưa |
| Từ đúng bị vàng | 63/1270 = 5,0% | 42/1274 = 3,3% (CI 95%: 2,4–4,4%) | ≤ 2% | Chưa |
| False green | 0 | 0 | 0 | Có |

### F. Nhận dạng

| Chỉ số | Trước | Sau | Mục tiêu | Đạt |
|---|---|---|---|---|
| Exact word accuracy | 1270/1314 = 96,7% | 1274/1314 = 97,0% | ≥ 99% | Chưa |
| Diacritic word accuracy | 1069/1112 = 96,1% | 1073/1112 = 96,5% | ≥ 99% | Chưa |
| CER trung bình | 0,0169 | 0,0160 | ≤ 0,01 | Chưa |
| WER trung bình | 0,0420 | 0,0383 | | |
| Punctuation F1 | 0,872 | 0,941 | | |
| IoU của box | 0,573 | 0,893 | | |
| Thời gian mỗi trang (CPU) | 2,68 s | 2,39 s | | |

Từng engine trên cùng ground truth (sau thay đổi): PaddleOCR 19,0% từ đúng,
VietOCR 96,5%, Tesseract 96,7%, hybrid 97,0%. Không tính font sách thiếu nhi,
hybrid đạt 1234/1260 = 97,9%.

### G. Release gates

| Gate | Kết quả |
|---|---|
| A. Phân loại theo reference | Đạt: 1274/1274 từ đúng → xanh, 38/38 từ sai → đỏ, không false green/red |
| B. Nhận dạng tiếng Việt | **Chưa đạt** (97,0% so với 99%; CER 0,016 so với 0,01) |
| C. Vàng sai | Precision đạt; recall 96,7% và vàng sai 3,3% **chưa đạt** |
| D. Dấu câu | **Chưa đạt** (precision 95,8%, recall 92,4%); không còn mất dấu câu khi lưu/tải và không làm lệch ánh xạ từ |
| E. Ảnh sách thật | **Chưa đạt**: repository không có ảnh chụp/scan sách đã được xác minh độc lập |

### H. Lịch sử tự sửa

| Vòng | Phát hiện | Nguyên nhân | Sửa | Kết quả |
|---|---|---|---|---|
| 1 | 24 từ đúng vàng dù hai engine tiếng Việt đồng thuận | Cổng crop/bbox nằm trước phân xử | Bỏ cổng hình học khỏi kết luận văn bản khi Tesseract đã chạy; thêm `geometry_quality` | Vàng sai 5,0% → 3,4% |
| 2 | Lượt đọc crop gần như vô dụng (Tesseract 8/79) | Box từ chỉ là ước lượng (IoU 0,57) | Dùng box Tesseract đo được | IoU 0,89; thêm 4 từ đúng |
| 3 | Mất 33 dấu chấm, recall dấu câu 80,8% | VietOCR bỏ dấu chấm; không có bước đối chiếu dấu câu | Bỏ phiếu dấu câu theo từng từ | Recall 92,4% |
| 4 | Dấu `–` đầu câu thoại biến mất khỏi văn bản | Token chỉ có dấu câu bị loại khi dựng văn bản | Giữ bố cục dòng gồm cả token dấu câu | Văn bản trang giữ đủ |
| 5 | `'An'` bị tô đỏ so với reference `An` | Dấu nháy/gạch ở mép từ được coi là chữ | Chuẩn hóa mép từ ở backend và frontend | Từ đúng, dấu câu báo riêng |
| 6 | Hai ca test cũ còn đòi vàng khi crop yếu | Hợp đồng đã đổi theo yêu cầu mới | Cập nhật kỳ vọng D29, D30 và test vùng crop | Khớp hợp đồng mới |

### I. Giới hạn còn lại

- Font sách thiếu nhi (Comic Sans): VietOCR 74%, Tesseract 52%. Đây là giới hạn
  của model; các từ sai ở đây không bao giờ được tô xanh, nhưng nhiều từ đúng
  phải ở lại màu vàng.
- Khi VietOCR và Tesseract khác nhau một dấu (`rỡ`/`rõ`), không có căn cứ ảnh
  độc lập thứ ba để phân xử. Cần thêm một recognizer tiếng Việt độc lập hoặc
  calibration trên dữ liệu thật.
- Dấu câu đứng riêng chỉ được giữ khi VietOCR đọc được nó; chưa bỏ phiếu cho
  loại này.
- Chưa có ảnh sách thật và chưa chạy E2E trên giao diện Admin.

### J. Bộ kiểm thử mới của vòng 2

| Nhóm | Số kịch bản | Nơi đặt |
|---|---:|---|
| A. 60 từ chỉ khác dấu, vẽ thành ảnh, chạy engine thật | 60 từ × 2 kiểu chữ | `test_ocr_false_yellow_suite.py::RealOcrIntegration` |
| B. Dấu thanh và Unicode | 30 | `ToneMarkAndUnicodeRules` |
| C. Dấu câu | 55, cộng 23 test pipeline | `test_ocr_punctuation.py` |
| D. Từ đúng không được vàng | 35, cộng 11 test riêng | `FalseYellowRegressionSuite` |
| E. Độ chính xác của đỏ | 25 | `RedPrecision` |
| F. Trang trộn | 25 | `MixedPages` |
| G. Tích hợp engine thật theo 21 điều kiện ảnh | 20 điều kiện có ngưỡng sàn + 8 test | `RealOcrIntegration` |
| Frontend: hình học, dấu câu, chuẩn hóa mép từ | 18 | `ocr-word-color-matrix.test.ts` |

Nhóm G dùng ảnh dựng bằng máy; test `test_g_real_book_photographs_are_not_available`
tự bỏ qua kèm thông báo Gate E chưa đạt cho tới khi có thư mục
`backend/tests/fixtures/ocr_real_books/`.

### K. Kết luận

Phần phân loại màu (Gate A, GREEN precision) đủ cơ sở để dùng. Chất lượng nhận
dạng, tỷ lệ vàng sai và dấu câu đã cải thiện có đo đếm nhưng **chưa đạt các
ngưỡng nghiệm thu B, C, D, E**, nên chưa thể tuyên bố nghiệm thu toàn bộ.
