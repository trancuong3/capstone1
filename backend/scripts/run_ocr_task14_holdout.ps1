# TASK 14 - Verify NEW, independently labeled, disjoint photos with frozen OCR.
# This NEVER creates data or treats the previous 10-page set as held-out.
# Output contains counts only. Do not commit private manifests or images.
[CmdletBinding()]
param(
    [string]$PythonPath = "F:\c1\capstone1\.venv\Scripts\python.exe",
    [string]$BackendPath = "F:\c1\capstone1-ocr-acceptance\backend",
    [string]$PrivateRoot = "F:\c1\ocr-private-eval",
    [string]$EnvFile = "F:\c1\capstone1\backend\.env",
    [string]$ExpectedSha = "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6",
    [int]$MinHeldoutPages = 20,
    [switch]$TestsOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

foreach ($path in @($PythonPath, $BackendPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing Python/Backend" }
}
# Unit gates require no photos or secrets and can run immediately.
foreach ($test in @(
    "test_ocr_tesseract_holdout_audit.py",
    "test_ocr_tesseract_alignment.py",
    "test_ocr_tesseract_review_risk.py",
    "test_ocr_tone_blind_policy.py"
)) {
    Write-Host "Testing $test" -ForegroundColor Cyan
    & $PythonPath -m unittest discover -s $BackendPath -p $test -v
    if ($LASTEXITCODE -ne 0) { throw "TASK 14 UNIT TEST FAILED" }
}
Write-Host "TASK 14 PURE UNIT TESTS PASSED" -ForegroundColor Green
if ($TestsOnly) {
    Write-Host "TESTS-ONLY: no private held-out OCR benchmark was performed." -ForegroundColor Yellow
    Write-Host "Independent held-out acceptance: NOT VERIFIED" -ForegroundColor Yellow
    Write-Host "Production deployment: BLOCKED" -ForegroundColor Yellow
    return
}

$development = Join-Path $PrivateRoot "pages.jsonl"
$heldoutDir = Join-Path $PrivateRoot "heldout"
$heldout = Join-Path $heldoutDir "pages.jsonl"
if (-not (Test-Path -LiteralPath $development) -or
    -not (Test-Path -LiteralPath $heldout) -or
    -not (Test-Path -LiteralPath $EnvFile)) {
    Write-Host "No independent held-out dataset is configured yet." -ForegroundColor Yellow
    Write-Host "Provide at least $MinHeldoutPages NEW manually labeled photos in a separate PRIVATE heldout/pages.jsonl." -ForegroundColor Yellow
    Write-Host "Never reuse the original 10 photos or copy their reference sentences." -ForegroundColor Yellow
    Write-Host "TASK 14 HELD-OUT BENCHMARK NOT RUN - NOT ACCEPTED" -ForegroundColor Yellow
    throw "TASK 14 requires an independently collected held-out dataset"
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fffffff"
$out = Join-Path $heldoutDir "aggregate-heldout-$stamp.json"
$runner = Join-Path $BackendPath "scripts\ocr_tesseract_holdout_runner.py"
& $PythonPath $runner `
    --development-manifest $development `
    --heldout-manifest $heldout `
    --env-file $EnvFile `
    --expected-profile "FLOW1_EXTERNAL_TRDG" `
    --expected-sha $ExpectedSha `
    --min-heldout-pages $MinHeldoutPages `
    --output $out
if ($LASTEXITCODE -ne 0) { throw "TASK 14 HELD-OUT EVALUATION FAILED" }
$report = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
if (-not $report.runtime_all_cases_verified -or
    $report.production_deployment_allowed) {
    throw "TASK 14 safety gates rejected the report"
}
Write-Host "NEW HELD-OUT RESEARCH COMPLETED (OFFLINE ONLY)" -ForegroundColor Green
Write-Host "Exact photo/text disjointness checked; near-duplicates and independent labeling still need human audit." -ForegroundColor Yellow
Write-Host "Production deployment: BLOCKED" -ForegroundColor Yellow
