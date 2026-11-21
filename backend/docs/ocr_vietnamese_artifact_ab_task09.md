# TASK 09 — A/B ngoại tuyến cho lỗi dấu tiếng Việt và từ OCR thừa

## Vấn đề đã quan sát

Trong lần OCR thành công trên 10 trang riêng tư:
- Baseline CER **34/1647 = 0.020644**; WER **30/364 = 0.082418**.
- 15 chỉnh sửa từ được phân loại `diacritic_or_d_stroke`.
- 11 `punctuation_only`, 3 `extra_token`, 1 `other_substitution`.
- Trang `low_light` thêm ba token `I I V` sau phần nội dung. Ba hộp
  nằm phía dưới vùng chữ chính; đây là dấu hiệu cần xem lại, nhưng chưa
  đủ chứng minh chúng hoàn toàn không có trên ảnh gốc.
- Chỉ **một ảnh mỗi điều kiện**, không có threshold chất lượng được
  định nghĩa trước; không khẳng định mức cải thiện có thể tổng quát.

Không chỉnh checkpoint, model, `ocr_engine.py`, API hoặc màu đánh giá đọc.

## Thử nghiệm A/B có giới hạn

### Nhánh A — baseline bất biến

Gọi `extract_text_and_boxes()` thật, kiểm tra tất cả ba engine ở trạng thái
`success`, `FLOW1_EXTERNAL_TRDG` và SHA, chấm `micro_cer` cùng
`micro_wer` nghiêm ngặt so với text tham chiếu.

### Nhánh B — giả thuyết từ rời bất thường ở cuối ảnh

Chạy *trên bản sao trong RAM* của kết quả từ nhánh A. Thuật toán có
quy tắc cố định, **không truy cập ground_truth khi đề xuất**:

- Text trang và chuỗi `words[]` phải có cùng số token và cùng từng token;
  mọi bbox phải hợp lệ, nếu không bỏ qua giả thuyết.
- Thử tối đa 3 token cuối là **một ký tự chữ hoa** mỗi token.
- Phải có ít nhất 12 từ phía trước; cụm token cuối cần cách nội dung
  chính ít nhất **3 lần** chiều cao hộp trung vị và mỗi hộp cao ít nhất
  **1,6 lần** chiều cao trung vị.
- Nếu đủ điều kiện, đề xuất loại cụm cuối khỏi *bản text giả định* rồi
  chấm lại CER/WER; không xóa box, không thay văn bản OCR cho sản phẩm.
- Có thể nhận nhầm chữ La Mã thật, số trang hoặc đề mục cuối trang.
  Bộ unit tests chứa đối chứng cố tình làm WER xấu đi.

Báo cáo đếm số trang được đề xuất, tổng token giả định loại bỏ,
những trang cải thiện/xấu đi/không đổi theo CER và WER, cùng aggregate
strict baseline so với giả thuyết. Không tự chọn phương án tốt nhất dựa
trên đáp án; không tìm hệ số tối ưu trên tập 10 ảnh này.

### Khảo sát dấu tiếng Việt (không tự sửa)

Đối với mỗi token OCR, lấy **các cách đọc đã tồn tại** trong
`ocr_evidence.engine_outputs` hoặc `crop_evidence`. Chỉ xem cách đọc
có cùng chữ cái nền sau bỏ dấu/đ→d, nhưng dấu khác nhau. Dữ liệu tham
chiếu chỉ được dùng để báo cáo **oracle upper bound**: trong các lỗi dấu,
bao nhiêu lỗi có cách đọc đúng xuất hiện ở một engine khác.

Không dùng `ground_truth` để chọn từ trong sản phẩm; không dùng từ
điển thêm từ mới; không tự xác nhận engine nào đúng.

## Chạy ngắn gọn bằng một script

Nếu đã lấy nhánh TASK 09 về worktree OCR, chỉ cần:

```powershell
& "F:\\c1\\capstone1-ocr-acceptance\\backend\\scripts\\run_ocr_task09_ab.ps1"
```

Script tự chạy 4 bộ unit tests, dừng ngay nếu có lỗi, sau đó benchmark
10 trang, lưu aggregate dưới thư mục riêng tư với tên theo timestamp và
in kết quả A/B. Nếu PowerShell chặn file chưa ký, thiết lập
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned` theo
quy định máy trước khi chạy; không đổi policy toàn hệ thống.

## Lệnh Windows

```powershell
git -C "F:\c1\capstone1" fetch origin
git -C "F:\c1\capstone1-ocr-acceptance" status --short
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-vietnamese-false-token-ab-diagnostics

$py = "F:\c1\capstone1\.venv\Scripts\python.exe"
$backend = "F:\c1\capstone1-ocr-acceptance\backend"

$tests = @(
  "test_ocr_vietnamese_artifact_ab.py",
  "test_ocr_vietnamese_artifact_ab_runner.py",
  "test_ocr_real_photo_benchmark.py",
  "test_ocr_word_error_diagnostics.py"
)
foreach ($test in $tests) {
  & $py -m unittest discover -s $backend -p $test -v
  if ($LASTEXITCODE -ne 0) { throw "TEST FAILED: $test" }
}

cd $backend
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-ffff"
$private = "F:\c1\ocr-private-eval"

& $py scripts\ocr_vietnamese_artifact_ab_runner.py `
  "$private\pages.jsonl" `
  --env-file "F:\c1\capstone1\backend\.env" `
  --min-pages 10 `
  --expected-profile FLOW1_EXTERNAL_TRDG `
  --expected-sha 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6 `
  --output "$private\aggregate-artifact-ab-$stamp.json"

if ($LASTEXITCODE -ne 0) { throw "TASK 09 BENCHMARK FAILED" }

$report = Get-Content "$private\aggregate-artifact-ab-$stamp.json" -Raw |
  ConvertFrom-Json
"BASELINE"; $report.quality.baseline_strict
"TAIL HYPOTHESIS"; $report.quality.isolated_tail_hypothesis_strict
"PROPOSAL COUNTS"; $report.quality.tail_proposal_statuses
"PAGE REGRESSIONS"; $report.quality.wer_page_directions
"TONE ALTERNATIVE COVERAGE"; $report.quality.diacritic_evidence
```

**Đầu ra duy nhất là aggregate JSON** với số đếm và thống kê, không
in nội dung ảnh, OCR, nhãn, đường dẫn hay secret. Giữ tất cả ảnh/nhãn,
`.env` và dữ liệu gốc ngoài GitHub, chỉ chia sẻ aggregate.

## Nguyên tắc quyết định sau A/B

1. Kiểm tra baseline không đổi: **34/1647 CER, 30/364 WER**.
2. Kiểm tra `failed_cases=0` và đúng SHA/profile cho cả 10 trang.
3. Nếu một ứng viên A/B làm WER/CER tốt lên trên tập nhỏ này, vẫn
   **không tự bật trong production**. Cần thêm ảnh riêng biệt và
   đối chứng người dùng xem các token đề xuất loại bỏ.
4. Nếu engine khác chứa cách đọc đúng dấu, đó là trần lý thuyết cho
   việc nghiên cứu cơ chế quyết định engine, **không phải** một
   thuật toán sửa dấu đã được chứng minh.
5. Chỉ thay pipeline OCR trong PR tiếp theo với kiểm thử chống hồi quy,
   không mất từ đúng và số đo trên tập giữ lại. Không tự merge/deploy.
