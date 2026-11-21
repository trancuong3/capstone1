# TASK 11 — blind PaddleOCR vs independently confirmed VietOCR crop.
# Research only. No OCR production/box/checkpoint/child-feedback change.
[CmdletBinding()]
param(
    [string]$PythonPath = "F:\c1\capstone1\.venv\Scripts\python.exe",
    [string]$BackendPath = "F:\c1\capstone1-ocr-acceptance\backend",
    [string]$PrivateRoot = "F:\c1\ocr-private-eval",
    [string]$EnvFile = "F:\c1\capstone1\backend\.env",
    [string]$ExpectedSha = "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

foreach ($path in @(
    $PythonPath,
    $BackendPath,
    $EnvFile,
    (Join-Path $PrivateRoot "pages.jsonl")
)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing local input needed for TASK 11"
    }
}

$tests = @(
    "test_ocr_tone_blind_policy.py",
    "test_ocr_tone_blind_policy_runner.py",
    "test_ocr_vietnamese_artifact_ab.py",
    "test_ocr_vietnamese_artifact_ab_runner.py"
)

foreach ($test in $tests) {
    Write-Host "Checking $test" -ForegroundColor Cyan
    & $PythonPath -m unittest discover -s $BackendPath -p $test -v
    if ($LASTEXITCODE -ne 0) { throw "TASK 11 UNIT TEST FAILED: $test" }
}
Write-Host "TASK 11 UNIT TESTS PASSED" -ForegroundColor Green

$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fffffff"
$out = Join-Path $PrivateRoot "aggregate-paddle-vietocr-crop-ab-$stamp.json"
$runner = Join-Path $BackendPath "scripts\ocr_tone_blind_policy_runner.py"

& $PythonPath $runner (Join-Path $PrivateRoot "pages.jsonl") `
    --env-file $EnvFile `
    --min-pages 10 `
    --expected-profile "FLOW1_EXTERNAL_TRDG" `
    --expected-sha $ExpectedSha `
    --output $out

$exitCode = $LASTEXITCODE
if (-not (Test-Path -LiteralPath $out)) {
    throw "TASK 11 aggregate report was not created"
}
$report = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
Write-Host "Verified pages: $($report.successful_cases)/$($report.dataset_case_count)" -ForegroundColor Cyan
if ($exitCode -ne 0 -or -not $report.runtime_all_cases_verified) {
    Write-Host "FAILURE STAGES" -ForegroundColor Yellow
    $report.failure_stage_counts | Format-List
    $report.contract_failure_codes | Format-List
    throw "TASK 11 BENCHMARK FAILED"
}
$baseline = $report.quality.baseline_strict
if ($baseline.character_edits -ne 34 -or
    $baseline.reference_characters -ne 1647 -or
    $baseline.word_edits -ne 30 -or
    $baseline.reference_words -ne 364) {
    throw "TASK 11 BASELINE MISMATCH: do not interpret proposals"
}

Write-Host "BASELINE" -ForegroundColor Cyan
$baseline | Select-Object character_edits, reference_characters, micro_cer, word_edits, reference_words, micro_wer | Format-List
foreach ($policy in @(
    "paddleocr_line_priority",
    "paddle_line_vietocr_crop_agreement"
)) {
    $row = $report.quality.ground_truth_blind_rules.$policy
    if ($null -eq $row) { throw "Missing policy result: $policy" }
    Write-Host "POLICY $policy" -ForegroundColor Cyan
    $row.quality | Select-Object character_edits, micro_cer, word_edits, micro_wer | Format-List
    $row | Select-Object flipped_words, corrected_words, regressed_words, other_changed_words, flips_without_positional_truth | Format-List
    $row.wer_page_directions | Format-List
}

Write-Host "TASK 11 BLIND POLICY BENCHMARK PASSED (OFFLINE ONLY)" -ForegroundColor Green
