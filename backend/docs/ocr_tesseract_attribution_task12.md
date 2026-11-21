# TASK 12 — Truy nguồn 15 cách đọc đúng dấu và đánh giá Tesseract ngoại tuyến

## Dữ liệu đã đo từ máy Windows

Các A/B TASK 09–11 đều dùng 10 ảnh trong thư mục riêng tư
`F:\c1\ocr-private-eval`, checkpoint cố định
`200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6`
và `FLOW1_EXTERNAL_TRDG`. Baseline strict: CER 34/1647=0.020644,
WER 30/364=0.082418.

TASK 11:
- `paddleocr_line_priority` đã đổi **236 từ**, không có sửa đúng
  nào được xác nhận bằng so sánh token cùng vị trí,
  **182 từ vốn đúng trở thành sai**, 20 từ thay đổi nhưng vẫn sai,
  và 34 lượt đổi không thể khẳng định đúng/sai do token counts không
  khớp. CER tăng lên 276/1647=0.167577; WER 245/364=0.673077.
- `paddle_line_vietocr_crop_agreement` không tạo đề xuất.
- Các số liệu này **không** chứng minh riêng engine PaddleOCR tệ với
  mọi loại ảnh; chúng chứng minh **chính sách thay trực tiếp** là nguy
  hiểm trên bộ đánh giá hiện tại. Không bật production.
- Nghiên cứu trước tìm 15/15 lỗi dấu có cách đọc đúng trong engine
  evidence nhưng chưa xác định rõ engine nào cung cấp chúng.
  13/15 có đáp án đúng ở line và 11/15 ở crop (giao nhau).

## TASK 12 thay đổi gì?

1. Xuất `engine_attribution_audit` chỉ chứa **số đếm**, phân tách
   PaddleOCR, VietOCR, Tesseract ở **line có status success** và
   **crop đã lưu**: số vị trí có cách đọc khác dấu cùng chữ nền và
   trong **15 lỗi dấu** số lượt mỗi engine chứa đáp án đúng. Kết quả
   crop là bằng chứng đã lưu, *không phải* phiếu đồng thuận độc lập
   với line của cùng engine, cũng không bảo đảm crop đã thành công.
2. `tesseract_line_priority`: nhánh đối chứng **rủi ro cao**, thay
   token bằng cách đọc dòng của Tesseract nếu cùng chữ nền/different
   diacritics và per-word status success.
3. `tesseract_line_vietocr_crop_agreement`: nhánh thận trọng hơn;
   yêu cầu Tesseract line và **VietOCR crop đã completed** với
   `vietocr_error=None` cùng đọc một phương án, 2 engine độc lập,
   và Tesseract/VietOCR đều có trạng thái success.
4. Các đề xuất chỉ dùng `output.words[].ocr_evidence` và giữ
   nguyên OCR text/word boxes. `ground_truth` chỉ dùng *sau khi*
   tạo đề xuất để chấm strict CER/WER và tách
   `corrected_words`, `regressed_words`, `other_changed_words`,
   `flips_without_positional_truth`.

Báo cáo chỉ là aggregate numeric; không ghi private image, từ OCR,
văn bản tham chiếu, raw crop hoặc private file paths.

## Chạy trên Windows bằng ba lệnh

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-tesseract-tone-source-ab
& "F:\c1\capstone1-ocr-acceptance\backend\scripts\run_ocr_task12_tesseract_ab.ps1"
```

Script chạy 4 bộ unit tests rồi xác minh full checkpoint trên 10 trang
trước khi in bảng **ENGINE-SPECIFIC SOURCE ATTRIBUTION** và kết quả
hai chính sách. Nếu baseline hoặc một test không khớp, script dừng.

## Cổng an toàn

Không áp dụng sửa dấu Tesseract/PaddleOCR tự động vào production chỉ
vì A/B in-sample tốt hơn. Không so sánh qua số vị trí khác số token
thực, không tự chấm IoU hoặc chức năng màu phản hồi đọc của trẻ.

**Chưa có tập ảnh held-out độc lập**, chưa chứng minh bộ chọn dấu
không làm sai từ đã đúng. Kể cả nếu chính sách Tesseract tốt hơn trên
10 ảnh, cần thêm ảnh giữ lại, đo CER/WER, corrected/regressed words
và kiểm tra thủ công những vị trí đề xuất thay.
