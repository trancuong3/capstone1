# Provision isolated ViRead Local Voice Runtime & verify pinned model SHA-256 checksums.
# Keeps all voice dependencies strictly separate from the backend OCR environment.
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$BasePython = "python",
    [string]$TtsPrecision = "fp32"
)

$ErrorActionPreference = "Stop"

$venvDir = Join-Path $VoiceRuntimeDir ".venv"
$hfCache = Join-Path $VoiceRuntimeDir "hf-cache"
$pipCache = Join-Path $VoiceRuntimeDir "pip-cache"
$modelsDir = Join-Path $VoiceRuntimeDir "models"
$sherpaDir = Join-Path $modelsDir "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09"

New-Item -ItemType Directory -Force -Path $VoiceRuntimeDir, $hfCache, $pipCache, $modelsDir | Out-Null

if (-not (Test-Path (Join-Path $venvDir "Scripts\python.exe"))) {
    Write-Host "[1/4] Creating isolated Python virtual environment at $venvDir..."
    & $BasePython -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to create voice venv at $venvDir" }
}

$pyExe = Join-Path $venvDir "Scripts\python.exe"
$env:PIP_CACHE_DIR = $pipCache
$env:HF_HOME = $hfCache
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

Write-Host "[2/4] Ensuring pinned voice runtime packages..."
& $pyExe -m pip install --upgrade `
    "vieneu==3.8.5" `
    "sherpa-onnx==2.0.2" `
    "onnxruntime==1.32.0" `
    "sea-g2p==0.10.0" `
    "librosa==1.0.1" `
    "soundfile>=0.12.1" `
    "av>=14.0.0" `
    "fastapi>=0.115.0" `
    "uvicorn>=0.32.0" `
    "python-multipart>=0.0.12"
if ($LASTEXITCODE -ne 0) { throw "Failed to install pinned voice packages." }

$expectedHashes = @{
    "encoder.int8.onnx" = "8EF5286DD427EB108055C2DDC1982AA31E544706072D5EA228729292DACADE68"
    "decoder.onnx"      = "CF2AA385B82C9D5D40CD29C3188AF52D0249B3B78F0D4B7EB84AD502D50C7E7F"
    "joiner.int8.onnx"  = "7311D2E17B810ECEA515D79C71CC4668AF8759256A06FA01D27047772320C821"
    "tokens.txt"        = "CA8171F8BBD516C050B627582F2125C8F5F1F6ED967AB41B0FA9AAE2CF61B492"
    "bpe.model"         = "002894E7A82D80FFA5E25008EC8C5496159DB804005E2103DE96B01B4C13D445"
}

$needSherpaDownload = $false
foreach ($fileName in $expectedHashes.Keys) {
    $filePath = Join-Path $sherpaDir $fileName
    if (-not (Test-Path $filePath)) {
        $needSherpaDownload = $true
        break
    }
}

if ($needSherpaDownload) {
    Write-Host "[3/4] Downloading pinned Sherpa-ONNX Vietnamese Zipformer model..."
    $archiveUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2"
    $archivePath = Join-Path $modelsDir "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
    tar -xjf $archivePath -C $modelsDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract Sherpa-ONNX archive." }
    Remove-Item -Force $archivePath -ErrorAction SilentlyContinue
} else {
    Write-Host "[3/4] Sherpa-ONNX model files present; verifying SHA-256..."
}

foreach ($kv in $expectedHashes.GetEnumerator()) {
    $filePath = Join-Path $sherpaDir $kv.Key
    $actual = (Get-FileHash -Path $filePath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actual -ne $kv.Value) {
        throw "SHA-256 mismatch for $($kv.Key): expected $($kv.Value), got $actual"
    }
}
Write-Host "  Verified 5/5 Sherpa-ONNX SHA-256 checksums."

$bpeModelPath = Join-Path $sherpaDir "bpe.model"
$bpeVocabPath = Join-Path $sherpaDir "bpe.vocab"
if ((Test-Path $bpeModelPath) -and (-not (Test-Path $bpeVocabPath))) {
    Write-Host "  Checking sentencepiece availability to export bpe.vocab..."
    @'
import os, sys
from pathlib import Path
bpe_model = Path(sys.argv[1])
bpe_vocab = Path(sys.argv[2])
try:
    import sentencepiece as spm
except ImportError:
    print("  sentencepiece not installed; skipping bpe.vocab export (worker will fallback).")
    sys.exit(0)
sp = spm.SentencePieceProcessor()
sp.load(str(bpe_model))
lines = [f"{sp.id_to_piece(i)}\t{sp.get_score(i)}\n" for i in range(sp.get_piece_size())]
bpe_vocab.write_text("".join(lines), encoding="utf-8")
print(f"  Exported bpe.vocab ({len(lines)} pieces) from bpe.model.")
'@ | & $pyExe - $bpeModelPath $bpeVocabPath
    if ($LASTEXITCODE -ne 0) { throw "Failed while exporting bpe.vocab from bpe.model." }
}

Write-Host "[4/4] Pre-caching VieNeu-TTS v3 Turbo ($TtsPrecision) ONNX weights..."
@'
import os, sys
from vieneu import Vieneu
prec = sys.argv[1]
tts = Vieneu(mode="v3turbo", backend="onnx", precision=prec, threads=4)
_ = tts.infer("Xin chào.", voice="Trúc Ly", temperature=0.22, top_k=15, apply_watermark=False)
print("VieNeu-TTS v3 Turbo ready:", len(tts.list_preset_voices()), "presets")
'@ | & $pyExe - $TtsPrecision
if ($LASTEXITCODE -ne 0) { throw "Failed to verify VieNeu-TTS v3 Turbo." }

Write-Host "ViRead Local Voice Runtime is provisioned and verified at $VoiceRuntimeDir."
exit 0
