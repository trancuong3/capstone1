"""Upload a verified VietOCR checkpoint (.pth + optional .yml) to a free Hugging Face Model Repo.

Why this exists:
- Hugging Face Hub Model Repositories (`type: "model"`) are 100% free (0 VND, no PRO plan,
  no credit card) and provide high-speed LFS/Xet CDN downloads.
- Hosting `viread-vietocr-v2-<sha256>.pth` (151.8 MB) on a free HF Model Repo (or GitHub Release)
  keeps Supabase Storage Free Tier egress at 0 MB on cold starts.

Security invariants:
- Reads `HF_TOKEN` strictly from environment variables — never CLI flags, never logged,
  and never embedded in git remote URLs.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

EXPECTED_FLOW1_TRDG_SHA256 = (
    "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6"
)


def _redact_secrets(text: str, *secrets: str) -> str:
    cleaned = text or ""
    for secret in secrets:
        if secret and len(secret) >= 6:
            cleaned = cleaned.replace(secret, "***REDACTED***")
    return cleaned.strip()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def find_default_local_checkpoint() -> Path | None:
    filename = f"viread-vietocr-v2-{EXPECTED_FLOW1_TRDG_SHA256}.pth"
    candidates = [
        Path(tempfile.gettempdir()) / filename,
        Path(os.getenv("VIREAD_OCR_MODEL_CACHE_DIR") or "") / filename
        if (os.getenv("VIREAD_OCR_MODEL_CACHE_DIR") or "").strip()
        else None,
        Path("F:/c1/tools") / filename,
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    return None


def ensure_hf_model_repo(*, repo_id: str, hf_token: str, public: bool = False) -> None:
    if "/" not in repo_id or len(repo_id.split("/")) != 2 or not all(repo_id.split("/")):
        raise ValueError("--repo-id must be formatted as '<owner>/<model-repo-name>'.")
    owner, name = repo_id.split("/", 1)
    status_code, _ = _hf_api_request(
        "GET",
        f"https://huggingface.co/api/models/{owner}/{name}",
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
    user_payload: dict[str, object] = {
        "type": "model",
        "name": name,
        "visibility": visibility,
    }
    org_payload: dict[str, object] = {
        **user_payload,
        "organization": owner,
    }
    candidates = (
        [user_payload, org_payload] if is_personal_owner else [org_payload, user_payload]
    )
    create_status = 0
    create_body: dict[str, object] = {}
    for payload in candidates:
        create_status, create_body = _hf_api_request(
            "POST",
            "https://huggingface.co/api/repos/create",
            hf_token=hf_token,
            payload=payload,
        )
        if create_status in (200, 201, 409):
            return
    err_msg = _redact_secrets(str(create_body.get("error", "unknown")), hf_token)
    raise RuntimeError(
        f"Failed creating Hugging Face Model Repo (HTTP {create_status}): {err_msg}"
    )


def push_checkpoint_via_git_lfs(
    *,
    repo_id: str,
    hf_token: str,
    checkpoint_path: Path,
    checkpoint_sha256: str,
    config_path: Path | None,
) -> str:
    if shutil.which("git") is None:
        raise RuntimeError("git is required to push checkpoints to Hugging Face Hub.")
    basic = base64.b64encode(f"user:{hf_token}".encode("utf-8")).decode("ascii")
    git_env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GCM_INTERACTIVE": "never",
    }
    canonical_pth_name = f"viread-vietocr-v2-{checkpoint_sha256}.pth"
    canonical_yml_name = f"viread-vietocr-v2-{checkpoint_sha256}.yml"

    with tempfile.TemporaryDirectory(prefix="viread-hf-model-") as tmp_str:
        work_dir = Path(tmp_str) / "model"
        work_dir.mkdir(parents=True, exist_ok=True)

        (work_dir / ".gitattributes").write_text(
            "*.pth filter=lfs diff=lfs merge=lfs -text\n",
            encoding="utf-8",
            newline="\n",
        )
        (work_dir / "README.md").write_text(
            f"---\nlibrary_name: vietocr\ntags:\n  - ocr\n  - vietnamese\n---\n\n"
            f"# ViRead VietOCR Checkpoint Store\n\n"
            f"- File: `{canonical_pth_name}`\n"
            f"- SHA-256: `{checkpoint_sha256}`\n",
            encoding="utf-8",
            newline="\n",
        )
        shutil.copy2(checkpoint_path, work_dir / canonical_pth_name)
        if config_path is not None and config_path.is_file():
            shutil.copy2(config_path, work_dir / canonical_yml_name)

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
                safe_err = _redact_secrets(
                    proc.stderr or proc.stdout or "", hf_token, basic
                )[:300]
                raise RuntimeError(
                    f"git {step_name} failed (exit {proc.returncode}): {safe_err}"
                )

        _git("init", "init", "-b", "main")
        _git("lfs-install", "lfs", "install", "--local")
        _git("config-name", "config", "user.name", "ViRead Release Bot")
        _git("config-email", "config", "user.email", "noreply@viread.local")
        _git("add", "add", "-A")
        _git(
            "commit",
            "commit",
            "-m",
            f"chore(ocr-model): upload verified checkpoint {checkpoint_sha256[:12]}",
        )
        _git(
            "push",
            "-c",
            "credential.helper=",
            "-c",
            f"http.https://huggingface.co/.extraheader=AUTHORIZATION: Basic {basic}",
            "push",
            "--force",
            f"https://huggingface.co/{repo_id}",
            "HEAD:main",
        )

    return f"https://huggingface.co/{repo_id}/resolve/main/{canonical_pth_name}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Upload SHA-256 verified VietOCR checkpoint to a free Hugging Face Model Repo."
    )
    parser.add_argument(
        "--repo-id",
        default=os.getenv("HF_MODEL_REPO_ID", "").strip(),
        required=not bool(os.getenv("HF_MODEL_REPO_ID", "").strip()),
        help="Target Hugging Face Model Repo ID: '<owner>/<model-repo-name>' (e.g. cuonghhhdd3/viread-ocr-models).",
    )
    parser.add_argument(
        "--checkpoint-path",
        type=Path,
        default=None,
        help="Path to local .pth checkpoint (auto-detects FLOW1_EXTERNAL_TRDG in %%TEMP%% if omitted).",
    )
    parser.add_argument(
        "--config-path",
        type=Path,
        default=None,
        help="Optional sibling .yml config path (auto-detected alongside .pth if present).",
    )
    parser.add_argument(
        "--expected-sha256",
        default="",
        help="Optional expected 64-hex SHA-256 (inferred from filename if present).",
    )
    parser.add_argument(
        "--public",
        action="store_true",
        help="Create Model Repo as public (recommended if omitting VIREAD_HF_MODEL_TOKEN).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Verify local checkpoint SHA-256 and print target CDN URL without network calls.",
    )
    args = parser.parse_args(argv)

    if "/" not in args.repo_id or len(args.repo_id.split("/")) != 2 or not all(args.repo_id.split("/")):
        print("ERROR: --repo-id must be formatted as '<owner>/<model-repo-name>'.", file=sys.stderr)
        return 2

    pth_path = args.checkpoint_path or find_default_local_checkpoint()
    if pth_path is None or not pth_path.is_file():
        print(
            "ERROR: Could not find local VietOCR .pth checkpoint; pass --checkpoint-path explicitly.",
            file=sys.stderr,
        )
        return 2

    actual_sha = _sha256_file(pth_path)
    expected_sha = args.expected_sha256.strip().lower()
    if not expected_sha:
        m = re.search(r"([0-9a-f]{64})", pth_path.name.lower())
        if m:
            expected_sha = m.group(1)
    if expected_sha and actual_sha != expected_sha:
        print(
            f"ERROR: Checkpoint SHA-256 mismatch ({actual_sha} != {expected_sha}).",
            file=sys.stderr,
        )
        return 2

    cfg_path = args.config_path
    if cfg_path is None:
        sibling = pth_path.with_suffix(".yml")
        if sibling.is_file():
            cfg_path = sibling

    cdn_url = f"https://huggingface.co/{args.repo_id}/resolve/main/viread-vietocr-v2-{actual_sha}.pth"
    if args.dry_run:
        print(
            f"[DRY-RUN] Verified checkpoint {pth_path.name} "
            f"({pth_path.stat().st_size:,} bytes, sha256={actual_sha})."
        )
        print(f"[DRY-RUN] Target VIREAD_OCR_CHECKPOINT_CDN_URL={cdn_url}")
        return 0

    hf_token = (os.getenv("HF_TOKEN") or "").strip()
    if not hf_token:
        print("ERROR: Set HF_TOKEN (Hugging Face write token) in environment.", file=sys.stderr)
        return 2

    ensure_hf_model_repo(repo_id=args.repo_id, hf_token=hf_token, public=args.public)
    uploaded_url = push_checkpoint_via_git_lfs(
        repo_id=args.repo_id,
        hf_token=hf_token,
        checkpoint_path=pth_path,
        checkpoint_sha256=actual_sha,
        config_path=cfg_path,
    )
    print(f"Uploaded verified VietOCR checkpoint to: https://huggingface.co/{args.repo_id}")
    print(f"VIREAD_OCR_CHECKPOINT_CDN_URL={uploaded_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
