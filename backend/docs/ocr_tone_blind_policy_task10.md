# TASK 10 — Kiểm tra chọn dấu tiếng Việt KHÔNG nhìn đáp án

## Bằng chứng đầu vào (người dùng đã chạy TASK 09)

- Bộ 10 ảnh riêng tư: **10/10 PASS**, `FLOW1_EXTERNAL_TRDG`, cùng SHA.
- Baseline strict: CER **34/1647=0.020644**; WER **30/364=0.082418**.
- Giả thuyết loại token cuối lạc vùng (chỉ offline): CER **28/1647=0.017001**;
  WER **27/364=0.074176**.
- Có **239 từ** với cách đọc dấu khác nhau trong engine evidence; **15/15**
  lỗi dấu đã quan sát có ít nhất một cách đọc đúng xuất hiện ở đâu đó trong
  bằng chứng engine. Đây là **oracle coverage**, không phải độ chính xác của
  một thuật toán chọn dấu.

## Mục tiêu nghiên cứu

Không được dùng ground truth của `pages.jsonl` để chọn cách đọc dấu.
Thử 2 chính sách **định nghĩa cố định**, không tune trên 10 ảnh:

1. `line_majority_2`: chỉ thay nếu có ít nhất 2 **engine khác nhau**
   trong PaddleOCR/VietOCR/Tesseract trả về cùng dạng từ với dấu,
   cùng chữ nền với token hiện tại, và số phiếu đó thắng tuyệt đối
   các candidate khác. Chỉ đọc output dòng `engine_outputs`;
   các crop của cùng engine không được coi là phiếu độc lập.
2. `vietocr_line_priority`: phép đối chứng ưu tiên cách đọc từ VietOCR
   line khi nó khác dấu, vẫn cùng chữ nền. Đây là baseline mang
   tính thử nghiệm, **không được coi là an toàn để triển khai**.

Với cả hai, chỉ dùng engine `status=success`, không đổi chữ nền, giữ dấu
câu và kiểu chữ hoa/thường. Nếu `output.text` và danh sách
`output.words` không khớp token/box, **abstain**; không đoán vị trí.

Các chính sách chỉ tạo **đề xuất văn bản trong RAM**, không thay đổi OCR
sản phẩm, word bbox, checkpoint, mẫu ảnh, Supabase hay màu đọc.

## Cách chấm

Sau khi tạo đề xuất độc lập với ground truth, mới dùng reference text
để đo strict CER/WER. Ghi rõ:
- số từ đổi, số từ đổi từ **sai thành đúng**, **đúng thành sai**,
  số từ đổi nhưng vẫn sai;
- số lần thay không thể đánh giá đúng/sai theo vị trí nếu số token
  reference và prediction khác nhau; không bịa số;
- số trang CER/WER tốt lên/xấu đi/không đổi;
- baseline vs hai policy theo từng điều kiện.

Không chọn policy tốt nhất vì chấm trên chính bộ 10 ảnh. Để đánh giá
hiệu quả thật, cần thêm ảnh giữ lại từ người khác, có tham chiếu đã được
kiểm tra độc lập; cần đảm bảo không mất từ đúng.

## Cách nhanh nhất: một script trên Windows

Sau khi `git fetch` và chuyển sang nhánh TASK 10, chạy:

```powershell
& "F:\\c1\\capstone1-ocr-acceptance\\backend\\scripts\\run_ocr_task10_blind_ab.ps1"
```

Script tự chạy 4 bộ unit tests, đo benchmark 10 ảnh với checkpoint
đã xác minh, kiểm tra baseline **34/1647, 30/364** và in số từ sửa đúng
so với số từ sửa sai của từng chính sách. Nếu có lỗi, script dừng; dữ liệu
đối chứng chỉ nằm trong thư mục private.

## Chạy PowerShell trên máy Windows

```powershell
git -C "F:\c1\capstone1" fetch origin
if ($LASTEXITCODE -ne 0) { throw "FETCH FAILED" }

git -C "F:\c1\capstone1-ocr-acceptance" status --short
git -C "F:\c1\capstone1-ocr-acceptance" switch --detach origin/test/ocr-tone-blind-policy-ab
if ($LASTEXITCODE -ne 0) { throw "SWITCH FAILED" }

$py = "F:\c1\capstone1\.venv\Scripts\python.exe"
$backend = "F:\c1\capstone1-ocr-acceptance\backend"
cd $backend

$tests = @(
    "test_ocr_tone_blind_policy.py",
    "test_ocr_tone_blind_policy_runner.py",
    "test_ocr_vietnamese_artifact_ab.py",
    "test_ocr_vietnamese_artifact_ab_runner.py"
)

foreach ($test in $tests) {
    & $py -m unittest discover -s $backend -p $test -v
    if ($LASTEXITCODE -ne 0) { throw "TEST FAILED: $test" }
}

$private = "F:\c1\ocr-private-eval"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fffffff"
$out = "$private\aggregate-tone-blind-$stamp.json"

& $py scripts\ocr_tone_blind_policy_runner.py `
  "$private\pages.jsonl" `
  --env-file "F:\c1\capstone1\backend\.env" `
  --min-pages 10 `
  --expected-profile FLOW1_EXTERNAL_TRDG `
  --expected-sha 200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6 `
  --output $out

$exitCode = $LASTEXITCODE
if (-not (Test-Path $out)) { throw "MISSING PRIVATE REPORT" }
$report = Get-Content $out -Raw | ConvertFrom-Json

"SUCCESS / FAILURE COUNTS"; $report |
  Select-Object successful_cases, failed_cases, failure_stage_counts

if ($exitCode -ne 0 -or $report.successful_cases -ne 10) {
  throw "TASK 10 BENCHMARK FAILED - inspect failure_stage_counts"
}

"BASELINE"; $report.quality.baseline_strict | Format-List
"MAJORITY POLICY"; $report.quality.ground_truth_blind_rules.line_majority_2 | Format-List
"VIETOCR PRIORITY POLICY"; $report.quality.ground_truth_blind_rules.vietocr_line_priority | Format-List
"Tone policy A/B complete (offline)" | Write-Host -ForegroundColor Green
```

Chỉ gửi số liệu aggregate hoặc phần output trên; **không gửi**
`pages.jsonl`, ảnh, dự đoán từng từ hoặc nội dung `.env`.

## Sau kết quả thực tế 10/10 PASS nhưng 0 đề xuất

Người dùng đã chạy TASK 10 với baseline **34/1647 CER, 30/364 WER**.
Cả `line_majority_2` và `vietocr_line_priority` đều cho
`flipped_words=0`, `no_proposal=10` và giữ nguyên CER/WER.

Điều này **không phủ định** kết quả TASK 09 có 239 vị trí chứa
cách đọc dấu khác biệt và 15/15 lỗi dấu có câu trả lời đúng trong bằng
chứng OCR. TASK 09 kiểm tra cả `ocr_evidence.engine_outputs` lẫn
`crop_evidence.*_candidate`; TASK 10 chỉ cho các chính sách dùng
`engine_outputs` của các engine có trạng thái `success` với quy tắc
riêng (đồng thuận hai engine, hoặc ưu tiên đọc dòng VietOCR).
Đây là **giả thuyết nguyên nhân**, chưa có thống kê từ ảnh thật để xác định
phương án đúng nằm ở nguồn nào.

Để phân biệt các khả năng, code TASK 10 hiện xuất thêm:

- `evidence_source_audit`: tổng vị trí có phương án dấu khác biệt;
  phương án nằm trong kết quả **line** bất kể status, line **đã xác minh
  status**, **crop**, chỉ crop, raw line bị loại do status, hoặc riêng
  VietOCR line đủ điều kiện
- `tone_error_source_audit`: trong các lỗi dấu của reference, số vị trí
  có đáp án đúng từ raw line, verified line, crop, chỉ crop, hoặc không có
  đáp án đúng nào; đây là **oracle diagnostic**, không dùng để chọn dấu

Các nhóm **có thể giao nhau** (ví dụ một phương án đúng xuất hiện cả ở
line và crop), không cộng các nhóm thành tổng 239 hoặc 15. Tệp JSON chỉ
chứa **số liệu aggregate**, không có từ OCR, nhãn, ảnh hay private paths.
Hai chính sách A/B và nguyên tắc không nhìn đáp án **không thay đổi**.

Sau khi fetch và chuyển sang nhánh PR #184 mới nhất, chạy lại chính
script `run_ocr_task10_blind_ab.ps1`: script sẽ tự thực thi test, OCR
10 ảnh và in cả hai phần audit mới. Nếu chỉ cần gửi kết quả cho người
đánh giá, gửi `evidence_source_audit`, `tone_error_source_audit` và
tổng CER/WER; không gửi `pages.jsonl` hoặc token riêng tư.

## Tiêu chí quyết định

- Dừng nếu chạy không đủ 10 ảnh, checkpoint/profile sai hoặc baseline
  không khớp 34/1647 và 30/364.
- Ngay cả nếu một policy có CER/WER thấp hơn: **không deploy** khi
  có `regressed_words>0` mà chưa được điều tra, và không deploy chỉ vì
  kết quả 10 ảnh nghiên cứu; dữ liệu held-out vẫn bắt buộc.
- Chính sách `vietocr_line_priority` chỉ làm đối chứng rủi ro.
- Thí nghiệm không đo accuracy IoU hộp từ hay màu đánh giá đọc cho trẻ.
