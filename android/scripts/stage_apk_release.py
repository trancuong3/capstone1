#!/usr/bin/env python3
"""Stage a verified ViRead Android APK with SHA256SUMS.txt and structured release notes.

Runs `verify_apk_quality.verify_apk` first (fail-closed on badging, manifest security,
launcher icons, secret-leak, or cryptographic signature checks), then stages the APK,
writes GNU coreutils-compatible `SHA256SUMS.txt`, and renders `RELEASE_NOTES.md` from
`docs/android/APK_RELEASE_NOTES_TEMPLATE.md`. Never auto-publishes unapproved releases.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from verify_apk_quality import RunnerFn, _default_runner, verify_apk  # noqa: E402

REPO_ROOT = SCRIPT_DIR.parents[1]
DEFAULT_TEMPLATE_PATH = REPO_ROOT / "docs" / "android" / "APK_RELEASE_NOTES_TEMPLATE.md"
BUILD_GRADLE_PATH = REPO_ROOT / "android" / "app" / "build.gradle"


def _detect_gradle_version_defaults(build_gradle: Path = BUILD_GRADLE_PATH) -> tuple[str, int]:
    version_name = "0.2.0"
    version_code = 2
    if not build_gradle.is_file():
        return version_name, version_code
    text = build_gradle.read_text(encoding="utf-8", errors="replace")
    name_match = re.search(r"versionName\s+['\"]([^'\"]+)['\"]", text)
    code_match = re.search(r"versionCode\s+(\d+)", text)
    if name_match:
        version_name = name_match.group(1).strip()
    if code_match:
        version_code = int(code_match.group(1))
    return version_name, version_code


def _detect_git_short_sha(repo_root: Path = REPO_ROOT) -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=5,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    except Exception:
        pass
    return "unknown"


def render_release_notes(template_text: str, replacements: dict[str, str]) -> str:
    rendered = template_text
    for key, value in replacements.items():
        rendered = rendered.replace(f"{{{{{key}}}}}", value)
    unresolved = re.findall(r"\{\{[A-Z0-9_]+\}\}", rendered)
    if unresolved:
        raise ValueError(f"Unresolved release note placeholders: {sorted(set(unresolved))}")
    return rendered


def stage_apk_release(
    apk_path: Path,
    output_dir: Path,
    *,
    channel: str = "debug",
    frontend_url: str | None = None,
    version_name: str | None = None,
    version_code: int | None = None,
    git_sha: str | None = None,
    staged_filename: str | None = None,
    template_path: Path = DEFAULT_TEMPLATE_PATH,
    aapt2_bin: str | None = None,
    apksigner_bin: str | None = None,
    runner: RunnerFn = _default_runner,
) -> dict[str, object]:
    normalized_channel = (channel or "").strip().lower()
    if normalized_channel not in {"debug", "rc", "release"}:
        raise ValueError("channel must be one of: debug, rc, release")

    if not template_path.is_file():
        raise FileNotFoundError(f"Release notes template not found: {template_path}")

    # Fail closed BEFORE creating or touching staging artifacts if APK audit fails.
    audit_report = verify_apk(
        apk_path,
        aapt2_bin=aapt2_bin,
        apksigner_bin=apksigner_bin,
        runner=runner,
    )

    default_ver_name, default_ver_code = _detect_gradle_version_defaults()
    resolved_ver_name = (version_name or default_ver_name).strip()
    resolved_ver_code = default_ver_code if version_code is None else int(version_code)
    resolved_sha = (git_sha or _detect_git_short_sha()).strip()
    resolved_frontend = (frontend_url or "https://<configured-at-build-time>").strip()

    resolved_apk = apk_path.resolve()
    resolved_out = output_dir.resolve()
    resolved_out.mkdir(parents=True, exist_ok=True)

    target_name = (staged_filename or resolved_apk.name).strip()
    if not target_name.endswith(".apk") or "/" in target_name or "\\" in target_name:
        raise ValueError(f"Invalid staged APK filename: {target_name}")

    staged_apk = resolved_out / target_name
    if resolved_apk != staged_apk:
        shutil.copy2(resolved_apk, staged_apk)

    sha256_hex = hashlib.sha256(staged_apk.read_bytes()).hexdigest()
    if sha256_hex != audit_report["sha256"]:
        raise RuntimeError("Staged APK SHA-256 mismatch after copy")

    sha256sums_path = resolved_out / "SHA256SUMS.txt"
    sha256sums_path.write_text(f"{sha256_hex}  {staged_apk.name}\n", encoding="utf-8", newline="\n")

    template_text = template_path.read_text(encoding="utf-8")
    notes_text = render_release_notes(
        template_text,
        {
            "APP_LABEL": str(audit_report["label"]),
            "PACKAGE_NAME": str(audit_report["package"]),
            "VERSION_NAME": resolved_ver_name,
            "VERSION_CODE": str(resolved_ver_code),
            "CHANNEL": normalized_channel,
            "GIT_SHA": resolved_sha,
            "MIN_SDK": str(audit_report["min_sdk"]),
            "TARGET_SDK": str(audit_report["target_sdk"]),
            "FRONTEND_URL": resolved_frontend,
            "APK_FILENAME": staged_apk.name,
            "APK_SIZE_BYTES": str(audit_report["size_bytes"]),
            "APK_SIZE_MB": str(audit_report["size_mb"]),
            "SHA256": sha256_hex,
            "LAUNCHER_PNG_COUNT": str(audit_report["launcher_png_count"]),
            "ADAPTIVE_XML_COUNT": str(audit_report["adaptive_xml_count"]),
        },
    )
    release_notes_path = resolved_out / "RELEASE_NOTES.md"
    release_notes_path.write_text(notes_text, encoding="utf-8", newline="\n")

    return {
        "staged_apk": str(staged_apk),
        "apk_filename": staged_apk.name,
        "sha256": sha256_hex,
        "sha256sums_path": str(sha256sums_path),
        "release_notes_path": str(release_notes_path),
        "channel": normalized_channel,
        "version_name": resolved_ver_name,
        "version_code": resolved_ver_code,
        "git_sha": resolved_sha,
        "audit": audit_report,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit a built ViRead APK and stage SHA256SUMS.txt + RELEASE_NOTES.md."
    )
    default_apk = (
        SCRIPT_DIR.parent
        / "app"
        / "build"
        / "outputs"
        / "apk"
        / "debug"
        / "app-debug.apk"
    )
    parser.add_argument("apk", nargs="?", default=str(default_apk), help="Path to built .apk file")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPO_ROOT / ".runtime" / "apk-release-staging",
        help="Staging output directory for APK, SHA256SUMS.txt, and RELEASE_NOTES.md",
    )
    parser.add_argument("--channel", default="debug", choices=("debug", "rc", "release"))
    parser.add_argument("--frontend-url", default=None, help="Verified HTTPS frontend URL")
    parser.add_argument("--version-name", default=None, help="Override versionName")
    parser.add_argument("--version-code", type=int, default=None, help="Override versionCode")
    parser.add_argument("--git-sha", default=None, help="Override Git commit SHA")
    parser.add_argument("--staged-filename", default=None, help="Optional output APK filename")
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE_PATH)
    parser.add_argument("--aapt2", default=None, help="Explicit path to aapt2 binary")
    parser.add_argument("--apksigner", default=None, help="Explicit path to apksigner binary")
    args = parser.parse_args([] if argv is None else argv)

    try:
        summary = stage_apk_release(
            Path(args.apk),
            args.output_dir,
            channel=args.channel,
            frontend_url=args.frontend_url,
            version_name=args.version_name,
            version_code=args.version_code,
            git_sha=args.git_sha,
            staged_filename=args.staged_filename,
            template_path=args.template,
            aapt2_bin=args.aapt2,
            apksigner_bin=args.apksigner,
        )
    except Exception as exc:
        print(f"APK release staging FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
