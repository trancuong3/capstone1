# TASK 09: one-command local offline OCR hypothesis validation.
# Does not modify production OCR, checkpoint, images or annotations.
[CmdletBinding()]
param(
  [string]$PythonPath = "F:\c1\capstone1\.venv\Scripts\python.exe",
  [string]$BackendPath = "F:\c1\capstone1-ocr-acceptance\backend",
  [string]$PrivateRoot = "F:\c1\ocr-private-eval",
  [string]$EnvFile = "F:\c1\capstone1\backend\.env",
  [string]$ExpectedProfile = "FLOW1_EXTERNAL_TRDG",
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
    throw "Required local file or folder is missing."
  }
}

$tests = @(
  "test_ocr_vietnamese_artifact_ab.py",
  "test_ocr_vietnamese_artifact_ab_runner.py",
  "test_ocr_real_photo_benchmark.py",
  "test_ocr_word_error_diagnostics.py"
)

foreach ($test in $tests) {
  Write-Host "Running $test" -ForegroundColor Cyan
  & $PythonPath -m unittest discover -s $BackendPath -p $test -v
  if ($LASTEXITCODE -ne 0) {
    throw "TASK 09 TEST FAILED: $test"
  }
}
Write-Host "TASK 09 TARGETED TESTS PASSED" -ForegroundColor Green

$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fffffff"
$out = Join-Path $PrivateRoot "aggregate-artifact-ab-$stamp.json"
$runner = Join-Path $BackendPath "scripts\ocr_vietnamese_artifact_ab_runner.py"

& $PythonPath $runner (Join-Path $PrivateRoot "pages.jsonl") `
  --env-file $EnvFile `
  --min-pages 10 `
  --expected-profile $ExpectedProfile `
  --expected-sha $ExpectedSha `
  --output $out
if ($LASTEXITCODE -ne 0) {
  throw "TASK 09 A/B BENCHMARK FAILED"
}

$report = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
if (-not $report.runtime_all_cases_verified -or $report.failed_cases -ne 0) {
  throw "OCR runtime evidence incomplete; cannot accept A/B metrics"
}
Write-Host "BASELINE:" -ForegroundColor Cyan
$report.quality.baseline_strict | Format-List
Write-Host "OFFLINE TAIL HYPOTHESIS:" -ForegroundColor Cyan
$report.quality.isolated_tail_hypothesis_strict | Format-List
Write-Host "TONE ENGINE ALTERNATIVES:" -ForegroundColor Cyan
$report.quality.diacritic_evidence | Format-List
Write-Host "WER PAGE DIRECTIONS:" -ForegroundColor Cyan
$report.quality.wer_page_directions | Format-List
Write-Host "TASK 09 A/B COMPLETED" -ForegroundColor Green
