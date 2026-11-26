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


def _redact_secrets(text: str, *secrets: str) -> str:
    cleaned = text or ""
    for secret in secrets:
        if secret and len(secret) >= 6:
            cleaned = cleaned.replace(secret, "***REDACTED***")
    return cleaned.strip()


def ensure_private_docker_space(*, space_id: str, hf_token: str, public: bool = False) -> None:
    if "/" not in space_id or len(space_id.split("/")) != 2:
        raise ValueError("--space-id must be formatted as '<owner>/<space-name>'.")
    owner, name = space_id.split("/", 1)
    if not owner or not name:
        raise ValueError("--space-id must be formatted as '<owner>/<space-name>'.")
    status_code, _ = _hf_api_request(
        "GET",
        f"https://huggingface.co/api/spaces/{owner}/{name}",
        hf_token=hf_token,
    )
    if status_code == 200:
        return

    visibility = "public" if public else "private"
    whoami_status, whoami_body = _hf_api_request(
        "GET",
        "https://huggingface.co/api/whoami-v2",
        hf_token=hf_token,
    )
    is_personal_owner = (
        whoami_status == 200
        and isinstance(whoami_body.get("name"), str)
        and str(whoami_body["name"]).lower() == owner.lower()
    )

    candidate_payloads: list[dict[str, object]] = []
    user_payload: dict[str, object] = {
        "type": "space",
        "name": name,
        "visibility": visibility,
        "sdk": "docker",
        "hardware": "cpu-basic",
    }
    org_payload: dict[str, object] = {
        **user_payload,
        "organization": owner,
    }
    if is_personal_owner:
        candidate_payloads.extend([user_payload, org_payload])
    else:
        candidate_payloads.extend([org_payload, user_payload])

    create_status = 0
    create_body: dict[str, object] = {}
    for payload in candidate_payloads:
        create_status, create_body = _hf_api_request(
            "POST",
            "https://huggingface.co/api/repos/create",
            hf_token=hf_token,
            payload=payload,
        )
        if create_status in (200, 201, 409):
            return
        if create_status == 402:
            break

    err_msg = _redact_secrets(str(create_body.get("error", "unknown")), hf_token)
    if create_status in (402, 403):
        raise RuntimeError(
            f"Failed creating Hugging Face Space (HTTP {create_status}: {err_msg}). "
            "Note: Hugging Face Hub now requires a PRO/Team plan (HTTP 402) to create new Docker Spaces; "
            "see docs/AZURE_STUDENTS_ZERO_COST_OCR_DEPLOYMENT.md (0 VND Azure for Students, no card) "
            "or docs/HF_SPACES_ZERO_COST_OCR_DEPLOYMENT.md for 0 VND Google Cloud Run Always Free / Modal deployment."
        )
    raise RuntimeError(
        f"Failed creating Hugging Face Space (HTTP {create_status}): {err_msg}"
    )


def upsert_space_secret(*, space_id: str, hf_token: str, key: str, value: str) -> None:
    status_code, err_body = _hf_api_request(
        "POST",
        f"https://huggingface.co/api/spaces/{space_id}/secrets",
        hf_token=hf_token,
        payload={"key": key, "value": value},
    )
    if status_code not in (200, 201):
        detail = _redact_secrets(str(err_body.get("error", "unknown")), hf_token, value)
        raise RuntimeError(f"Failed setting Space secret {key} (HTTP {status_code}: {detail}).")


def push_bundle_over_git(*, bundle_dir: Path, space_id: str, hf_token: str) -> None:
    """Push bundle to HF Space using HTTP extraheader so HF_TOKEN never enters remote URLs."""
    basic = base64.b64encode(f"user:{hf_token}".encode("utf-8")).decode("ascii")
    git_env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GCM_INTERACTIVE": "never",
    }
    with tempfile.TemporaryDirectory(prefix="viread-hf-git-") as tmp_git_str:
        work_dir = Path(tmp_git_str) / "space"
        from shutil import copytree

        copytree(bundle_dir, work_dir)

        def _git(step_name: str, *args: str) -> None:
            proc = subprocess.run(
                ["git", *args],
                cwd=str(work_dir),
                env=git_env,
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 0:
                safe_err = _redact_secrets(proc.stderr or proc.stdout or "", hf_token, basic)[:300]
                raise RuntimeError(
                    f"git {step_name} failed (exit {proc.returncode}): {safe_err}"
                )

        _git("init", "init", "-b", "main")
        _git("config-name", "config", "user.name", "ViRead Release Bot")
        _git("config-email", "config", "user.email", "noreply@viread.local")
        _git("add", "add", "-A")
        _git("commit", "commit", "-m", "chore(ocr-worker): sync ViRead 0-cost HF Space bundle")
        _git(
            "push",
            "-c",
            "credential.helper=",
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
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and verify the <1 MiB HF Space bundle and validate --space-id without network calls.",
    )
    args = parser.parse_args(argv)

    if "/" not in args.space_id or len(args.space_id.split("/")) != 2 or not all(args.space_id.split("/")):
        print("ERROR: --space-id must be formatted as '<owner>/<space-name>'.", file=sys.stderr)
        return 2

    owner, name = args.space_id.split("/", 1)
    subdomain = f"{owner}-{name}".lower().replace("_", "-").replace(".", "-")

    if args.dry_run:
        with tempfile.TemporaryDirectory(prefix="viread-hf-bundle-") as tmp_dir:
            bundle_path = Path(tmp_dir) / "bundle"
            summary = build_hf_space_bundle(bundle_path)
            print(
                f"[DRY-RUN] Verified HF Space bundle ({summary['file_count']} files, {summary['total_bytes']:,} bytes < 1 MiB)."
            )
            print(f"[DRY-RUN] Target Space: https://huggingface.co/spaces/{args.space_id}")
            print(f"[DRY-RUN] Direct Space URL: https://{subdomain}.hf.space")
        return 0

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

    print(f"Successfully pushed Space: https://huggingface.co/spaces/{args.space_id}")
    print(f"Direct Space runtime URL:  https://{subdomain}.hf.space")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
