# Offline generator for verified public catalog TTS MP3 cache (0 VND, VieNeu fp32 -> MP3 48-64kbps mono).
# STRICT PRIVACY BOUNDARY: ONLY processes public catalog books (visibility_scope='CATALOG') with VERIFIED pages.
# NEVER touches parent private books (visibility_scope='PARENT_PRIVATE' / viread-private-books).
param(
    [string]$VoiceRuntimeDir = "F:\c1\tools\voice-runtime",
    [string]$OutputDir = "F:\c1\tools\catalog-tts-cache",
    [string]$VoiceId = "local_north_truc_ly",
    [double]$Speed = 1.0,
    [ValidateRange(48, 64)]
    [int]$BitrateKbps = 56,
    [string]$BucketName = "viread-catalog-tts",
    [string]$InputJsonPath = "",
    [int]$MaxPages = 500,
    [switch]$Upload,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$voicePyExe = Join-Path $VoiceRuntimeDir ".venv\Scripts\python.exe"
$voiceWorkerScript = Join-Path $scriptDir "voice_worker.py"

if (-not (Test-Path $voicePyExe)) {
    [Console]::Error.WriteLine("Voice runtime Python not found at '$voicePyExe'. Run scripts\windows\Download-ViReadVoiceModels.ps1 first.")
    exit 2
}

if (-not (Test-Path $voiceWorkerScript)) {
    [Console]::Error.WriteLine("voice_worker.py not found at '$voiceWorkerScript'.")
    exit 2
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Resolve-EnvSetting([string]$key) {
    $val = [Environment]::GetEnvironmentVariable($key, "Process")
    if ($val -and $val.Trim()) { return $val.Trim() }
    $backendEnv = Join-Path $repoRoot "backend\.env"
    if (Test-Path -LiteralPath $backendEnv) {
        foreach ($line in [System.IO.File]::ReadAllLines($backendEnv, [System.Text.Encoding]::UTF8)) {
            if ($null -eq $line) { continue }
            $trimmed = $line.TrimStart([char]0xFEFF).Trim()
            if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
            if ($trimmed -match "^$([regex]::Escape($key))\s*=\s*(.*)$") {
                $parsed = $Matches[1].Trim()
                if (($parsed.StartsWith('"') -and $parsed.EndsWith('"')) -or ($parsed.StartsWith("'") -and $parsed.EndsWith("'"))) {
                    $parsed = $parsed.Substring(1, $parsed.Length - 2)
                }
                if ($parsed.Trim()) { return $parsed.Trim() }
            }
        }
    }
    return ""
}

$supabaseUrl = Resolve-EnvSetting "SUPABASE_URL"
$supabaseAdminKey = Resolve-EnvSetting "SUPABASE_SECRET_KEY"
if (-not $supabaseAdminKey) {
    $supabaseAdminKey = Resolve-EnvSetting "SUPABASE_SERVICE_ROLE_KEY"
}

if (-not $InputJsonPath -and (-not $supabaseUrl -or -not $supabaseAdminKey)) {
    [Console]::Error.WriteLine("Provide -InputJsonPath or configure SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY in environment or backend\.env.")
    exit 3
}

if ($Upload -and (-not $supabaseUrl -or -not $supabaseAdminKey)) {
    [Console]::Error.WriteLine("-Upload requires SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY.")
    exit 3
}

$pyCode = @'
import hashlib
import io
import json
import os
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

script_dir = Path(os.environ["VIREAD_SCRIPT_DIR"])
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

output_dir = Path(os.environ["VIREAD_TTS_CACHE_OUT_DIR"])
voice_id = os.environ["VIREAD_TTS_VOICE_ID"]
speed = max(0.7, min(1.3, float(os.environ["VIREAD_TTS_SPEED"])))
speed_slug = f"{speed:.1f}"
bitrate_bps = int(os.environ["VIREAD_TTS_BITRATE_KBPS"]) * 1000
bucket_name = os.environ["VIREAD_TTS_BUCKET"]
input_json = os.environ.get("VIREAD_TTS_INPUT_JSON", "").strip()
max_pages = max(1, int(os.environ["VIREAD_TTS_MAX_PAGES"]))
do_upload = os.environ.get("VIREAD_TTS_UPLOAD", "0") == "1"
dry_run = os.environ.get("VIREAD_TTS_DRY_RUN", "0") == "1"
supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
supabase_key = os.environ.get("SUPABASE_ADMIN_KEY", "").strip()


def normalize_nfc(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", str(text or "")).split()).strip()


def sha256_nfc(text: str) -> str:
    return hashlib.sha256(normalize_nfc(text).encode("utf-8")).hexdigest()


def rest_get(path_and_query: str):
    url = f"{supabase_url}/rest/v1/{path_and_query}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_verified_public_pages():
    if input_json:
        raw = json.loads(Path(input_json).read_text(encoding="utf-8"))
        items = []
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            if entry.get("is_public_catalog") is not True or entry.get("verification_status") != "VERIFIED":
                continue
            text = normalize_nfc(entry.get("text", ""))
            if text:
                items.append({
                    "book_id": str(entry.get("book_id") or ""),
                    "page_id": str(entry.get("page_id") or ""),
                    "page_revision_id": str(entry.get("page_revision_id") or ""),
                    "page_number": int(entry.get("page_number") or 0),
                    "text": text,
                })
        return items[:max_pages]

    # Query strictly public catalog active books only (NEVER PARENT_PRIVATE).
    books = rest_get(
        "books?select=id,title,visibility_scope,lifecyclestatus,is_deleted,deleted_at"
        "&visibility_scope=eq.CATALOG&lifecyclestatus=eq.ACTIVE&deleted_at=is.null"
    )
    public_book_ids = [
        b["id"]
        for b in books
        if b.get("visibility_scope") == "CATALOG"
        and b.get("lifecyclestatus") == "ACTIVE"
        and not b.get("is_deleted")
        and b.get("deleted_at") is None
    ]
    pages_out = []
    for book_id in public_book_ids:
        if len(pages_out) >= max_pages:
            break
        pages = rest_get(
            f"bookpages?select=id,bookid,pagenumber,currentverifiedrevisionid,lifecyclestatus"
            f"&bookid=eq.{urllib.parse.quote(str(book_id))}&lifecyclestatus=eq.ACTIVE"
            f"&currentverifiedrevisionid=not.is.null&order=pagenumber.asc"
        )
        for p in pages:
            if len(pages_out) >= max_pages:
                break
            rev_id = p.get("currentverifiedrevisionid")
            if not rev_id:
                continue
            revs = rest_get(
                f"pagerevisions?select=id,verificationstatus,verifiedtext"
                f"&id=eq.{urllib.parse.quote(str(rev_id))}&verificationstatus=eq.VERIFIED&limit=1"
            )
            if not revs:
                continue
            text = normalize_nfc(revs[0].get("verifiedtext", ""))
            if not text:
                continue
            pages_out.append({
                "book_id": str(book_id),
                "page_id": str(p["id"]),
                "page_revision_id": str(rev_id),
                "page_number": int(p.get("pagenumber") or 0),
                "text": text,
            })
    return pages_out


def encode_mp3_mono(pcm_wav_bytes: bytes, target_bitrate_bps: int) -> bytes:
    import av

    in_buf = io.BytesIO(pcm_wav_bytes)
    out_buf = io.BytesIO()
    with av.open(in_buf, mode="r") as inp:
        in_stream = inp.streams.audio[0]
        sample_rate = in_stream.rate or 24000
        with av.open(out_buf, mode="w", format="mp3") as out:
            out_stream = out.add_stream("mp3", rate=sample_rate, layout="mono")
            out_stream.bit_rate = target_bitrate_bps
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=sample_rate)
            for frame in inp.decode(in_stream):
                for resampled in resampler.resample(frame):
                    for packet in out_stream.encode(resampled):
                        out.mux(packet)
            for packet in out_stream.encode(None):
                out.mux(packet)
    return out_buf.getvalue()


def upload_public_mp3(object_path: str, mp3_bytes: bytes) -> str:
    url = (
        f"{supabase_url}/storage/v1/object/"
        f"{urllib.parse.quote(bucket_name, safe='')}/{urllib.parse.quote(object_path, safe='/')}"
    )
    req = urllib.request.Request(
        url,
        data=mp3_bytes,
        method="POST",
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "audio/mpeg",
            "x-upsert": "true",
            "cache-control": "public, max-age=31536000, immutable",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        resp.read()
    return (
        f"{supabase_url}/storage/v1/object/public/"
        f"{urllib.parse.quote(bucket_name, safe='')}/{urllib.parse.quote(object_path, safe='/')}"
    )


pages = load_verified_public_pages()
print(f"Found {len(pages)} verified public catalog pages eligible for TTS precompute.")

manifest = {
    "bucket": bucket_name,
    "voice_id": voice_id,
    "speed": speed_slug,
    "precision": "fp32",
    "bitrate_kbps": bitrate_bps // 1000,
    "items": [],
}

if dry_run:
    for item in pages:
        h = sha256_nfc(item["text"])
        obj_path = f"{voice_id}/{speed_slug}/{h}.mp3"
        manifest["items"].append({**item, "text_sha256": h, "object_path": obj_path, "status": "dry_run"})
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Dry run manifest written to {output_dir / 'manifest.json'}")
    sys.exit(0)

# Enforce fp32 precision to prevent int8 Vietnamese tone collapse on cached catalog audio.
os.environ["VIREAD_VOICE_TTS_PRECISION"] = "fp32"
os.environ["VIREAD_VOICE_HYBRID_WORD_FP32"] = "false"
import voice_worker
from vieneu import Vieneu

preset = voice_worker.resolve_strict_voice(voice_id)
tts_engine = Vieneu(
    mode="v3turbo",
    backend="onnx",
    precision="fp32",
    threads=4,
)
# Warm up once
_ = tts_engine.infer("Xin chào.", voice=preset.preset_name, temperature=0.25, top_k=15, apply_watermark=False)

generated = 0
skipped = 0
uploaded = 0
for item in pages:
    h = sha256_nfc(item["text"])
    obj_path = f"{voice_id}/{speed_slug}/{h}.mp3"
    local_file = output_dir / obj_path
    local_file.parent.mkdir(parents=True, exist_ok=True)
    if local_file.is_file() and local_file.stat().st_size > 256:
        mp3_bytes = local_file.read_bytes()
        skipped += 1
    else:
        wav_bytes, _duration_s = voice_worker.synthesize_single_utterance_sync(
            tts_engine,
            item["text"],
            preset,
            speed,
            word_sample=False,
            precision_override="fp32",
        )
        mp3_bytes = encode_mp3_mono(wav_bytes, bitrate_bps)
        local_file.write_bytes(mp3_bytes)
        generated += 1

    public_url = None
    if do_upload:
        public_url = upload_public_mp3(obj_path, mp3_bytes)
        uploaded += 1

    manifest["items"].append({
        "book_id": item["book_id"],
        "page_id": item["page_id"],
        "page_revision_id": item["page_revision_id"],
        "page_number": item["page_number"],
        "text_sha256": h,
        "object_path": obj_path,
        "bytes": len(mp3_bytes),
        "public_url": public_url,
    })

manifest_path = output_dir / "manifest.json"
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Catalog TTS cache complete: generated={generated}, reused={skipped}, uploaded={uploaded}, manifest={manifest_path}")
'@

$savedEnv = @{
    "VIREAD_SCRIPT_DIR"        = [Environment]::GetEnvironmentVariable("VIREAD_SCRIPT_DIR", "Process")
    "VIREAD_TTS_CACHE_OUT_DIR" = [Environment]::GetEnvironmentVariable("VIREAD_TTS_CACHE_OUT_DIR", "Process")
    "VIREAD_TTS_VOICE_ID"      = [Environment]::GetEnvironmentVariable("VIREAD_TTS_VOICE_ID", "Process")
    "VIREAD_TTS_SPEED"         = [Environment]::GetEnvironmentVariable("VIREAD_TTS_SPEED", "Process")
    "VIREAD_TTS_BITRATE_KBPS"  = [Environment]::GetEnvironmentVariable("VIREAD_TTS_BITRATE_KBPS", "Process")
    "VIREAD_TTS_BUCKET"        = [Environment]::GetEnvironmentVariable("VIREAD_TTS_BUCKET", "Process")
    "VIREAD_TTS_INPUT_JSON"    = [Environment]::GetEnvironmentVariable("VIREAD_TTS_INPUT_JSON", "Process")
    "VIREAD_TTS_MAX_PAGES"     = [Environment]::GetEnvironmentVariable("VIREAD_TTS_MAX_PAGES", "Process")
    "VIREAD_TTS_UPLOAD"        = [Environment]::GetEnvironmentVariable("VIREAD_TTS_UPLOAD", "Process")
    "VIREAD_TTS_DRY_RUN"       = [Environment]::GetEnvironmentVariable("VIREAD_TTS_DRY_RUN", "Process")
    "VIREAD_VOICE_RUNTIME_DIR" = [Environment]::GetEnvironmentVariable("VIREAD_VOICE_RUNTIME_DIR", "Process")
    "HF_HOME"                  = [Environment]::GetEnvironmentVariable("HF_HOME", "Process")
    "SUPABASE_URL"             = [Environment]::GetEnvironmentVariable("SUPABASE_URL", "Process")
    "SUPABASE_ADMIN_KEY"       = [Environment]::GetEnvironmentVariable("SUPABASE_ADMIN_KEY", "Process")
}

$tmpScript = Join-Path $OutputDir "_generate_catalog_tts.py"
try {
    Set-Content -Path $tmpScript -Value $pyCode -Encoding UTF8
    [Environment]::SetEnvironmentVariable("VIREAD_SCRIPT_DIR", $scriptDir, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_CACHE_OUT_DIR", $OutputDir, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_VOICE_ID", $VoiceId, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_SPEED", ([string]$Speed), "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_BITRATE_KBPS", ([string]$BitrateKbps), "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_BUCKET", $BucketName, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_INPUT_JSON", $InputJsonPath, "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_MAX_PAGES", ([string]$MaxPages), "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_UPLOAD", $(if ($Upload) { "1" } else { "0" }), "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_TTS_DRY_RUN", $(if ($DryRun) { "1" } else { "0" }), "Process")
    [Environment]::SetEnvironmentVariable("VIREAD_VOICE_RUNTIME_DIR", $VoiceRuntimeDir, "Process")
    [Environment]::SetEnvironmentVariable("HF_HOME", (Join-Path $VoiceRuntimeDir "hf-cache"), "Process")
    [Environment]::SetEnvironmentVariable("SUPABASE_URL", $supabaseUrl, "Process")
    [Environment]::SetEnvironmentVariable("SUPABASE_ADMIN_KEY", $supabaseAdminKey, "Process")

    & $voicePyExe $tmpScript
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    if (Test-Path $tmpScript) {
        Remove-Item -Force $tmpScript -ErrorAction SilentlyContinue
    }
    foreach ($kv in $savedEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }
}
exit 0
