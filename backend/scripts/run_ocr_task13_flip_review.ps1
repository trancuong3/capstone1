# TASK 13 — local, change-only gallery of Tesseract OCR word suggestions.
# Never upload index.html or crops; aggregate.json is counts only.
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
    $PythonPath, $BackendPath, $EnvFile,
    (Join-Path $PrivateRoot "pages.jsonl")
)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required private OCR file or interpreter is missing"
    }
}

$tests = @(
    "test_ocr_tesseract_flip_review.py",
    "test_ocr_tone_blind_policy.py",
    "test_ocr_tone_blind_policy_runner.py"
)
foreach ($test in $tests) {
    Write-Host "Testing $test" -ForegroundColor Cyan
    & $PythonPath -m unittest discover -s $BackendPath -p $test -v
    if ($LASTEXITCODE -ne 0) { throw "TASK 13 UNIT TEST FAILED: $test" }
}
Write-Host "TASK 13 UNIT TESTS PASSED" -ForegroundColor Green

$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fffffff"
$out = Join-Path $PrivateRoot "tesseract-flip-review-$stamp"
$runner = Join-Path $BackendPath "scripts\ocr_tesseract_flip_review.py"
& $PythonPath $runner (Join-Path $PrivateRoot "pages.jsonl") `
    --env-file $EnvFile `
    --min-pages 10 `
    --expected-profile "FLOW1_EXTERNAL_TRDG" `
    --expected-sha $ExpectedSha `
    --output-dir $out

$exitCode = $LASTEXITCODE
$summaryPath = Join-Path $out "aggregate.json"
if (-not (Test-Path -LiteralPath $summaryPath)) {
    throw "TASK 13 did not produce an aggregate report"
}
$summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
if ($exitCode -ne 0 -or -not $summary.complete -or
    $summary.successful_pages -ne 10) {
    $summary.failure_exception_types | Format-List
    throw "TASK 13 private review incomplete"
}
Write-Host "Only proposed token changes were collected for private review." -ForegroundColor Green
$summary.policy_flip_review_counts | Format-List
Start-Process -FilePath (Join-Path $out "index.html")
Write-Host "TASK 13 PRIVATE REVIEW GALLERY OPENED" -ForegroundColor Green
Write-Host "Do not upload the HTML or crops; share only aggregate.json counts." -ForegroundColor Yellow
