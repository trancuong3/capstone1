# TASK 11 — Đo A/B: PaddleOCR line vs xác nhận bằng VietOCR crop

## Kết quả đầu vào (TASK 10 đã kiểm chứng trên 10 ảnh riêng tư)

- Tất cả 10 ảnh được OCR thành công với checkpoint SHA
  `200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6`.
- Baseline nghiêm ngặt: **34/1647 CER = 0.020644**;
  **30/364 WER = 0.082418**.
- TASK 10: `line_majority_2` và `vietocr_line_priority` đều
  **0/367 từ bị đổi**, do không có phương án VietOCR line khác dấu
  và không có ứng viên đa số khác chữ đang chọn.
- 239/367 vị trí có phương án khác dấu; 237 vị trí có ứng viên line,
  24 có crop, 2 chỉ có crop; 0 khác dấu từ VietOCR line.
- Trong 15 lỗi dấu thực, 13 có đáp án đúng trong kết quả line,
  11 trong crop, bao gồm 2 chỉ xuất hiện trong crop.
- Đây là quan sát từ tập nghiên cứu, **không** bảo đảm PaddleOCR
  tốt hơn VietOCR hay engine khác trên dữ liệu ngoài tập.

## Hai chính sách mới, không nhìn ground truth khi đề xuất

1. `paddleocr_line_priority` — chỉ xem line output của PaddleOCR
   đã có status `success`, cùng chữ cái nền với token đang hiển thị
   (dấu thanh/đ-d có thể khác), giữ dấu câu và cách viết hoa.
   Đây là **nhánh đối chứng rủi ro cao**: có thể sửa một số lỗi dấu
   nhưng cũng có thể phá nhiều từ đang đúng.
2. `paddle_line_vietocr_crop_agreement` — chỉ đề xuất khi **hai engine
   khác nhau** đồng thuận: PaddleOCR line có status success và
   VietOCR crop riêng của từ đó đã `status=completed`, không
   có `vietocr_error`, VietOCR status success, và cả hai cùng cách
   đọc. Không coi PaddleOCR line + PaddleOCR crop là 2 phiếu độc lập.

Hai chính sách đã định nghĩa trước khi chạy benchmark mới.
Không đọc `ground_truth` để đề xuất. Nếu `words[]` không khớp
`output.text` hoặc bbox không hợp lệ, từ chối phân tích.
Không sửa word box, checkpoint, production OCR, child feedback hoặc API.

## Tiêu chí đánh giá

Ngoài strict CER/WER, đo:
- `flipped_words`, `corrected_words`, `regressed_words`,
  `other_changed_words`, `flips_without_positional_truth`;
- số trang tăng/giảm/giữ nguyên CER và WER;
- checkpoint/runtime trùng với baseline và cả 10 ảnh đều thành công.

**Tuyệt đối không triển khai vào production chỉ dựa trên tập 10 ảnh
này.** Nếu `regressed_words>0`, phải xem kỹ nguyên nhân. Dù không
có regression trên tập nhỏ, vẫn cần đánh giá held-out độc lập để
chứng minh tác động đối với từ đúng.

## Chạy trên Windows: 3 lệnh

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-paddle-vietocr-crop-tone-ab
& "F:\c1\capstone1-ocr-acceptance\backend\scripts\run_ocr_task11_paddle_ab.ps1"
```

Bản chạy sẽ tự kiểm thử 4 module Python, OCR đúng checkpoint, kiểm
tra strict baseline 34/1647 + 30/364, sau đó in hai chính sách.
Kết quả chỉ là aggregate JSON mới trong `F:\c1\ocr-private-eval`,
không gửi ảnh, ground truth, OCR token, `.env` hoặc đường dẫn riêng
tư lên GitHub.

Nếu các test lỗi, dừng và sửa code trước benchmark. Người dùng chỉ
cần gửi bảng `BASELINE` và hai bảng `POLICY` cùng thông tin số từ
sửa đúng/sửa sai. Các số liệu này vẫn là nghiên cứu trong tập; chưa phải
acceptance sản phẩm.
