"""Build and verify a clean (< 1 MB) Hugging Face Docker Space bundle for ViRead 0-cost OCR.

Uses Python standard library only so it runs identically on Windows, macOS, Linux, and CI.
Default output directory is `.runtime/hf-ocr-space-bundle` (ignored by Git).
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BUNDLE_DIR = REPO_ROOT / ".runtime" / "hf-ocr-space-bundle"
MAX_BUNDLE_TOTAL_BYTES = 1_048_576  # Strict < 1 MiB guard
MAX_SINGLE_FILE_BYTES = 524_288     # No single file > 512 KiB
FORBIDDEN_SUFFIXES = frozenset({".wasm", ".pth", ".pt", ".onnx", ".pdparams", ".pdmodel", ".pem", ".key", ".crt"})

REQUIRED_RELATIVE_FILES: tuple[str, ...] = (
    "ocr_worker/__init__.py",
    "ocr_worker/requirements.txt",
    "ocr_worker/service.py",
    "ocr_worker/worker.py",
    "ocr_worker/configs/base.yml",
    "ocr_worker/configs/vgg-transformer.yml",
    "ai/vietocr_v2/original_artifact.json",
    "backend/app/services/ocr_engine.py",
    "backend/app/services/ocr_adjudication.py",
    "backend/app/services/ocr_punctuation.py",
    "backend/app/services/ocr_evidence.py",
    "backend/app/services/ocr_text_utils.py",
    "backend/app/services/word_box_geometry.py",
    "backend/app/services/viread_vietocr_v2_preprocessing.py",
)

HF_SPACE_README_TEMPLATE = """---
title: ViRead OCR Worker
emoji: 📚
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
startup_duration_timeout: 30m
pinned: false
---

# ViRead 24/7 Cloud OCR Worker (Hugging Face Spaces `cpu-basic` — 0 VND)

Standalone Vietnamese 3-engine OCR worker (**PaddleOCR 2.7.3** + **VietOCR 0.3.12 `FLOW1_EXTERNAL_TRDG`** + **Tesseract 5 `vie`**) for ViRead.

## Hardware & Runtime Guarantees
- **Hardware**: Hugging Face Spaces `cpu-basic` (`linux/amd64`, 2 vCPU, 16 GB RAM, 50 GB ephemeral disk) — **0 VND/month**, no credit card required.
- **Container Contract**: Runs as non-root `UID 1000` (`HOME=/home/user`) listening on `0.0.0.0:7860`.
- **Anti-Bottleneck Quiet Standby**: Enters **Quiet Standby (`0` HTTP requests/min to Render)** after a 90s idle window so Render Free (`750h/mo` & `NullPool`) is never saturated, and wakes in `<1s` on authenticated `POST /wakeup`.
- **Zero DB / Supabase Secrets**: Authenticates exclusively with `X-ViRead-Ocr-Worker-Token` and verifies all source images & VietOCR checkpoints via SHA-256.

## Required Space Secrets (Settings -> Variables and secrets -> New secret)
1. `VIREAD_OCR_BACKEND_URL` — e.g. `https://capstone1-ssd8.onrender.com`
2. `VIREAD_OCR_WORKER_TOKEN` — shared >= 32-char random token matching Render backend `VIREAD_OCR_WORKER_TOKEN`
"""

HF_SPACE_DOCKERFILE = """FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    OMP_NUM_THREADS=2 \\
    OPENBLAS_NUM_THREADS=2 \\
    MKL_NUM_THREADS=2 \\
    NUMEXPR_NUM_THREADS=2 \\
    VIREAD_OCR_CPU_THREADS=2 \\
    VIREAD_OCR_QUIET_STANDBY=true \\
    VIREAD_OCR_WAKE_BURST_SECONDS=90 \\
    VIREAD_OCR_BACKEND_TIMEOUT_SECONDS=75 \\
    HOME=/home/user \\
    PADDLEOCR_HOME=/home/user/.paddleocr \\
    VIREAD_OCR_MODEL_CACHE_DIR=/tmp/viread-models \\
    PORT=7860 \\
    PYTHONPATH=/app:/app/backend

RUN apt-get update && apt-get install -y --no-install-recommends \\
    tesseract-ocr \\
    tesseract-ocr-vie \\
    libgl1 \\
    libglib2.0-0 \\
    libgomp1 \\
    fonts-dejavu-core \\
    && rm -rf /var/lib/apt/lists/*

# Create Hugging Face Spaces mandatory UID 1000 user with writable $HOME and cache dirs.
RUN useradd -m -u 1000 user \\
    && mkdir -p /app /home/user/.paddleocr /home/user/.cache /tmp/viread-models \\
    && chown -R 1000:1000 /app /home/user /tmp/viread-models

WORKDIR /app

COPY --chown=1000:1000 ocr_worker/requirements.txt /app/ocr_worker/requirements.txt

# Pin setuptools<82 (pkg_resources required by paddle), CPU PyTorch wheels,
# --no-deps on vietocr/imgaug/paddleocr/gdown (prevents matplotlib & opencv-python),
# and enforce sole cv2 owner (opencv-python-headless==4.10.0.84).
RUN pip install --no-cache-dir setuptools==77.0.3 \\
    && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \\
        torch==2.14.1 torchvision==0.29.1 \\
    && grep -vE '^(setuptools|torch|torchvision|paddleocr|imgaug|vietocr|gdown|prefetch-generator)==' /app/ocr_worker/requirements.txt > /tmp/ocr-base-reqs.txt \\
    && pip install --no-cache-dir -r /tmp/ocr-base-reqs.txt \\
    && pip install --no-cache-dir --no-deps \\
        gdown==4.4.0 \\
        prefetch-generator==1.0.1 \\
        vietocr==0.3.12 \\
        imgaug==0.4.0 \\
        paddleocr==2.7.3 \\
    && pip uninstall -y opencv-python opencv-contrib-python || true \\
    && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless==4.10.0.84 \\
    && rm -f /tmp/ocr-base-reqs.txt \\
    && python -c "import setuptools, pkg_resources, cv2, numpy, google.protobuf, pytesseract, torch, paddle, paddleocr, vietocr; assert numpy.__version__ == '1.26.4'; assert google.protobuf.__version__ == '3.20.2'; assert cv2.__version__ == '4.10.0'"

COPY --chown=1000:1000 ocr_worker /app/ocr_worker
COPY --chown=1000:1000 ai/vietocr_v2/original_artifact.json /app/ai/vietocr_v2/original_artifact.json
COPY --chown=1000:1000 backend /app/backend

USER 1000

# Pre-warm PaddleOCR ~16.34 MB det/rec/cls weights into /home/user/.paddleocr under UID 1000.
RUN python -c "import torch, paddle; from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=False, lang='vi', det_algorithm='DB', show_log=False)"

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \\
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/health', timeout=3)"

CMD ["python", "-m", "ocr_worker.worker", "--host", "0.0.0.0", "--port", "7860"]
"""

HF_SPACE_DOCKERIGNORE = """__pycache__/
*.py[cod]
.git/
.env
.env.*
"""


def verify_hf_space_bundle(bundle_dir: Path) -> dict[str, Any]:
    """Fail closed if the generated HF Space bundle violates size, secret, or ABI rules."""
    if not bundle_dir.is_dir():
        raise AssertionError(f"Bundle directory does not exist: {bundle_dir}")

    for rel in ("README.md", "Dockerfile", ".dockerignore", *REQUIRED_RELATIVE_FILES):
        target = bundle_dir / rel
        if not target.is_file():
            raise AssertionError(f"Missing required bundle file: {rel}")

    total_bytes = 0
    file_entries: list[dict[str, Any]] = []
    for item in sorted(bundle_dir.rglob("*")):
        if not item.is_file():
            continue
        rel_posix = item.relative_to(bundle_dir).as_posix()
        if rel_posix.startswith(".git/"):
            continue
        size = item.stat().st_size
        total_bytes += size
        suffix = item.suffix.lower()
        if suffix in FORBIDDEN_SUFFIXES:
            raise AssertionError(f"Forbidden binary/secret file in bundle: {rel_posix}")
        if item.name.startswith(".env"):
            raise AssertionError(f"Environment file must never enter bundle: {rel_posix}")
        if size > MAX_SINGLE_FILE_BYTES:
            raise AssertionError(
                f"Single file {rel_posix} ({size} B) exceeds {MAX_SINGLE_FILE_BYTES} B limit"
            )
        digest = hashlib.sha256(item.read_bytes()).hexdigest()
        file_entries.append({"path": rel_posix, "bytes": size, "sha256": digest})

    if total_bytes >= MAX_BUNDLE_TOTAL_BYTES:
        raise AssertionError(
            f"Bundle size {total_bytes} B exceeds strict 1 MiB ({MAX_BUNDLE_TOTAL_BYTES} B) limit"
        )

    readme_text = (bundle_dir / "README.md").read_text(encoding="utf-8")
    for token in ("sdk: docker", "app_port: 7860"):
        if token not in readme_text:
            raise AssertionError(f"README.md missing HF Spaces metadata: {token}")

    dockerfile_text = (bundle_dir / "Dockerfile").read_text(encoding="utf-8")
    for required_token in (
        "FROM python:3.12-slim",
        "useradd -m -u 1000 user",
        "USER 1000",
        "EXPOSE 7860",
        "VIREAD_OCR_QUIET_STANDBY=true",
        "setuptools==77.0.3",
        "opencv-python-headless==4.10.0.84",
    ):
        if required_token not in dockerfile_text:
            raise AssertionError(f"Dockerfile missing required contract: {required_token}")

    reqs_text = (bundle_dir / "ocr_worker" / "requirements.txt").read_text(encoding="utf-8")
    for locked_pin in (
        "numpy==1.26.4",
        "protobuf==3.20.2",
        "opencv-python-headless==4.10.0.84",
        "pytesseract==0.3.13",
        "setuptools==77.0.3",
        "requests==2.32.5",
        "tqdm==4.70.1",
    ):
        if locked_pin not in reqs_text:
            raise AssertionError(f"requirements.txt missing locked pin: {locked_pin}")

    return {
        "bundle_dir": str(bundle_dir),
        "file_count": len(file_entries),
        "total_bytes": total_bytes,
        "files": file_entries,
    }


def build_hf_space_bundle(output_dir: Path = DEFAULT_BUNDLE_DIR) -> dict[str, Any]:
    """Generate a clean, ready-to-push Hugging Face Docker Space directory."""
    resolved_out = output_dir.resolve()
    if resolved_out == REPO_ROOT.resolve():
        raise ValueError("Refusing to overwrite repository root.")

    if resolved_out.exists():
        shutil.rmtree(resolved_out)
    resolved_out.mkdir(parents=True, exist_ok=True)

    (resolved_out / "README.md").write_text(
        HF_SPACE_README_TEMPLATE.lstrip(), encoding="utf-8", newline="\n"
    )
    (resolved_out / "Dockerfile").write_text(
        HF_SPACE_DOCKERFILE.lstrip(), encoding="utf-8", newline="\n"
    )
    (resolved_out / ".dockerignore").write_text(
        HF_SPACE_DOCKERIGNORE.lstrip(), encoding="utf-8", newline="\n"
    )

    # Create lightweight Python package markers for `/app/backend/app/services`.
    for pkg_init in (
        resolved_out / "backend" / "__init__.py",
        resolved_out / "backend" / "app" / "__init__.py",
        resolved_out / "backend" / "app" / "services" / "__init__.py",
    ):
        pkg_init.parent.mkdir(parents=True, exist_ok=True)
        pkg_init.write_text("", encoding="utf-8", newline="\n")

    for rel_path in REQUIRED_RELATIVE_FILES:
        src = REPO_ROOT / rel_path
        if not src.is_file():
            raise FileNotFoundError(f"Required source file missing: {src}")
        dst = resolved_out / rel_path
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    return verify_hf_space_bundle(resolved_out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build and verify the standalone Hugging Face Space bundle for ViRead OCR."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_BUNDLE_DIR,
        help="Destination directory for the generated HF Space bundle.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print verification summary as JSON.",
    )
    args = parser.parse_args(argv)
    summary = build_hf_space_bundle(args.output_dir)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(
            f"HF Space bundle ready at {summary['bundle_dir']} "
            f"({summary['file_count']} files, {summary['total_bytes']:,} bytes < 1 MiB)."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
