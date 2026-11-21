# TASK 10: verify reference-blind Vietnamese tone hypotheses offline.
# No production, checkpoint, OCR box, source image, or database changes.
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
    throw "Missing required local file or directory"
  }
}

$tests = @(
    "test_ocr_tone_blind_policy.py",
    "test_ocr_tone_blind_policy_runner.py",
    "test_ocr_vietnamese_artifact_ab.py",
    "test_ocr_vietnamese_artifact_ab_runner.py"
)

foreach ($test in $tests) {
    Write-Host "Testing $test" -ForegroundColor Cyan
    & $PythonPath -m unittest discover -s $BackendPath -p $test -v
    if ($LASTEXITCODE -ne 0) {
        throw "TASK 10 TEST FAILED: $test"
    }
}
Write-Host "TASK 10 UNIT TESTS PASSED" -ForegroundColor Green

$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fffffff"
$out = Join-Path $PrivateRoot "aggregate-tone-blind-$stamp.json"
$runner = Join-Path $BackendPath "scripts\ocr_tone_blind_policy_runner.py"

& $PythonPath $runner (Join-Path $PrivateRoot "pages.jsonl") `
  --env-file $EnvFile `
  --min-pages 10 `
  --expected-profile "FLOW1_EXTERNAL_TRDG" `
  --expected-sha $ExpectedSha `
  --output $out

$exitCode = $LASTEXITCODE
if (-not (Test-Path -LiteralPath $out)) {
    throw "TASK 10 aggregate report not created"
}

$report = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
Write-Host "Runtime: $($report.successful_cases)/$($report.dataset_case_count)" -ForegroundColor Cyan

if ($exitCode -ne 0 -or $report.successful_cases -ne 10) {
    $report.failure_stage_counts | Format-List
    $report.contract_failure_codes | Format-List
    throw "TASK 10 BENCHMARK FAILED"
}

$baseline = $report.quality.baseline_strict
if ($baseline.character_edits -ne 34 -or $baseline.reference_characters -ne 1647 -or
    $baseline.word_edits -ne 30 -or $baseline.reference_words -ne 364) {
    throw "Baseline mismatch; do not compare the A/B hypotheses"
}

Write-Host "BASELINE:" -ForegroundColor Cyan
$baseline | Select-Object micro_cer, micro_wer, character_edits, word_edits | Format-List

foreach ($policy in @("line_majority_2", "vietocr_line_priority")) {
    $result = $report.quality.ground_truth_blind_rules.$policy
    Write-Host "$policy :" -ForegroundColor Cyan
    $result.quality | Select-Object micro_cer, micro_wer, character_edits, word_edits | Format-List
    $result | Select-Object flipped_words, corrected_words, regressed_words, other_changed_words, flips_without_positional_truth | Format-List
    Write-Host "WER page directions:"
    $result.wer_page_directions | Format-List
}

Write-Host "TASK 10 BLIND POLICY A/B COMPLETED (OFFLINE)" -ForegroundColor Green
