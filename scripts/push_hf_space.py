"""One-command push helper to deploy ViRead's 0-cost Private Docker Space to Hugging Face.

Security invariants:
- Reads `HF_TOKEN` (and optional `VIREAD_OCR_BACKEND_URL` / `VIREAD_OCR_WORKER_TOKEN`) strictly
  from environment variables — never CLI flags, never logged, and never embedded in git URLs.
- Creates the Space as **Private** (`private=true`, `sdk="docker"`, `hardware="cpu-basic"`) by default.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.build_hf_space_bundle import build_hf_space_bundle  # noqa: E402


def _hf_api_request(
    method: str,
    url: str,
    *,
    hf_token: str,
    payload: dict[str, object] | None = None,
) -> tuple[int, dict[str, object]]:
    body_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body_bytes, method=method)
    req.add_header("Authorization", f"Bearer {hf_token}")
    req.add_header("Accept", "application/json")
    if body_bytes is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw_err = exc.read().decode("utf-8", errors="replace")
        try:
            parsed_err = json.loads(raw_err)
        except Exception:
            parsed_err = {"error": f"HTTP {exc.code}"}
        return exc.code, parsed_err


def ensure_private_docker_space(*, space_id: str, hf_token: str, public: bool = False) -> None:
    if "/" not in space_id or len(space_id.split("/")) != 2:
        raise ValueError("--space-id must be formatted as '<owner>/<space-name>'.")
    owner, name = space_id.split("/", 1)
    status_code, _ = _hf_api_request(
        "GET",
        f"https://huggingface.co/api/spaces/{owner}/{name}",
        hf_token=hf_token,
    )
    if status_code == 200:
        return
    create_status, create_body = _hf_api_request(
        "POST",
        "https://huggingface.co/api/repos/create",
        hf_token=hf_token,
        payload={
            "type": "space",
            "organization": owner,
            "name": name,
            "private": not public,
            "sdk": "docker",
            "hardware": "cpu-basic",
        },
    )
    if create_status not in (200, 201, 409):
        # Retry without `organization` when `owner` is the personal user account.
        create_status, create_body = _hf_api_request(
            "POST",
            "https://huggingface.co/api/repos/create",
            hf_token=hf_token,
            payload={
                "type": "space",
                "name": name,
                "private": not public,
                "sdk": "docker",
                "hardware": "cpu-basic",
            },
        )
    if create_status not in (200, 201, 409):
        raise RuntimeError(
            f"Failed creating Hugging Face Space (HTTP {create_status}): {create_body.get('error', 'unknown')}"
        )


def upsert_space_secret(*, space_id: str, hf_token: str, key: str, value: str) -> None:
    status_code, _ = _hf_api_request(
        "POST",
        f"https://huggingface.co/api/spaces/{space_id}/secrets",
        hf_token=hf_token,
        payload={"key": key, "value": value},
    )
    if status_code not in (200, 201):
        raise RuntimeError(f"Failed setting Space secret {key} (HTTP {status_code}).")


def push_bundle_over_git(*, bundle_dir: Path, space_id: str, hf_token: str) -> None:
    """Push bundle to HF Space using HTTP extraheader so HF_TOKEN never enters remote URLs."""
    basic = base64.b64encode(f"user:{hf_token}".encode("utf-8")).decode("ascii")
    with tempfile.TemporaryDirectory(prefix="viread-hf-git-") as tmp_git_str:
        work_dir = Path(tmp_git_str) / "space"
        from shutil import copytree

        copytree(bundle_dir, work_dir)

        def _git(*args: str) -> None:
            proc = subprocess.run(
                ["git", *args],
                cwd=str(work_dir),
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"git {args[0]} failed (exit {proc.returncode}).")

        _git("init", "-b", "main")
        _git("config", "user.name", "ViRead Release Bot")
        _git("config", "user.email", "noreply@viread.local")
        _git("add", "-A")
        _git("commit", "-m", "chore(ocr-worker): sync ViRead 0-cost HF Space bundle")
        _git(
            "-c",
            f"http.https://huggingface.co/.extraheader=AUTHORIZATION: Basic {basic}",
            "push",
            "--force",
            f"https://huggingface.co/spaces/{space_id}",
            "HEAD:main",
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build and push ViRead's Private Docker OCR Space to Hugging Face."
    )
    parser.add_argument(
        "--space-id",
        default=os.getenv("HF_SPACE_ID", "").strip(),
        required=not bool(os.getenv("HF_SPACE_ID", "").strip()),
        help="Target Hugging Face Space ID: '<owner>/<space-name>'.",
    )
    parser.add_argument(
        "--public",
        action="store_true",
        help="Create Space as public instead of Private (default is Private).",
    )
    parser.add_argument(
        "--sync-secrets",
        action="store_true",
        help="Also upload VIREAD_OCR_BACKEND_URL and VIREAD_OCR_WORKER_TOKEN from env if set.",
    )
    args = parser.parse_args(argv)

    hf_token = (os.getenv("HF_TOKEN") or "").strip()
    if not hf_token:
        print(
            "ERROR: Set HF_TOKEN (Hugging Face write token) in your environment before pushing.",
            file=sys.stderr,
        )
        return 2

    with tempfile.TemporaryDirectory(prefix="viread-hf-bundle-") as tmp_dir:
        bundle_path = Path(tmp_dir) / "bundle"
        summary = build_hf_space_bundle(bundle_path)
        print(
            f"Verified HF Space bundle ({summary['file_count']} files, {summary['total_bytes']:,} bytes)."
        )
        ensure_private_docker_space(
            space_id=args.space_id,
            hf_token=hf_token,
            public=args.public,
        )
        if args.sync_secrets:
            backend_url = (os.getenv("VIREAD_OCR_BACKEND_URL") or "").strip()
            worker_token = (os.getenv("VIREAD_OCR_WORKER_TOKEN") or "").strip()
            if backend_url:
                upsert_space_secret(
                    space_id=args.space_id,
                    hf_token=hf_token,
                    key="VIREAD_OCR_BACKEND_URL",
                    value=backend_url,
                )
            if len(worker_token) >= 32:
                upsert_space_secret(
                    space_id=args.space_id,
                    hf_token=hf_token,
                    key="VIREAD_OCR_WORKER_TOKEN",
                    value=worker_token,
                )
        push_bundle_over_git(
            bundle_dir=bundle_path,
            space_id=args.space_id,
            hf_token=hf_token,
        )

    owner, name = args.space_id.split("/", 1)
    subdomain = f"{owner}-{name}".lower().replace("_", "-").replace(".", "-")
    print(f"Successfully pushed Space: https://huggingface.co/spaces/{args.space_id}")
    print(f"Direct Space runtime URL:  https://{subdomain}.hf.space")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
