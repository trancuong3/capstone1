"""Build-time SHA-256 verified VietOCR checkpoint pre-baker for zero-egress cold starts."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import urllib.request


def fetch_and_verify(
    url: str,
    *,
    expected_sha256: str,
    dst_path: Path,
    timeout_seconds: float = 180.0,
) -> Path:
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dst_path.with_suffix(dst_path.suffix + ".prebake.tmp")
    digest = hashlib.sha256()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ViRead-OCR-Prebake/1.0"})
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp, tmp_path.open("wb") as fh:
            while True:
                chunk = resp.read(262144)
                if not chunk:
                    break
                digest.update(chunk)
                fh.write(chunk)
        actual_sha = digest.hexdigest()
        if expected_sha256 and actual_sha != expected_sha256.lower():
            tmp_path.unlink(missing_ok=True)
            raise ValueError(
                f"Pre-bake SHA-256 mismatch for {dst_path.name}: {actual_sha} != {expected_sha256.lower()}"
            )
        os.replace(tmp_path, dst_path)
        return dst_path
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def main() -> int:
    dst_dir = Path(
        (os.getenv("VIREAD_OCR_PREBAKED_MODEL_DIR") or "/home/user/viread-models").strip()
    )
    pth_url = (os.getenv("PREBAKE_CHECKPOINT_URL") or "").strip()
    pth_sha = (os.getenv("PREBAKE_CHECKPOINT_SHA256") or "").strip().lower()
    yml_url = (os.getenv("PREBAKE_CONFIG_URL") or "").strip()
    yml_sha = (os.getenv("PREBAKE_CONFIG_SHA256") or "").strip().lower()

    if not pth_url:
        return 0
    if len(pth_sha) != 64:
        raise ValueError("PREBAKE_CHECKPOINT_SHA256 must be a 64-character hex digest.")

    pth_out = fetch_and_verify(
        pth_url,
        expected_sha256=pth_sha,
        dst_path=dst_dir / f"viread-vietocr-v2-{pth_sha}.pth",
    )
    print(f"Pre-baked verified checkpoint: {pth_out} ({pth_out.stat().st_size:,} bytes)")

    if yml_url:
        yml_out = fetch_and_verify(
            yml_url,
            expected_sha256=yml_sha,
            dst_path=dst_dir / f"viread-vietocr-v2-{pth_sha}.yml",
        )
        print(f"Pre-baked verified config: {yml_out} ({yml_out.stat().st_size:,} bytes)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
