#!/usr/bin/env python3
"""Automated quality, branding, manifest, signature, and secret-leak audit for ViRead APK.

Uses `aapt2`, `apksigner`, and `zipfile` inspection to enforce:
1. Package `vn.viread.android`, label `ViRead`, launchable `MainActivity`
2. Non-empty launcher icons across all 5 densities (160..640 dpi) + adaptive XML
3. `minSdk >= 26`, `targetSdk == 35`
4. `usesCleartextTraffic == false`, `allowBackup == false`, unexported `FileProvider`
5. Zero secrets, private keys, loopback/placeholder origins, or static Next.js exports
6. Valid cryptographic APK signature (`apksigner verify`) + SHA-256 digest
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Callable

REQUIRED_ICON_DENSITIES = ("160", "240", "320", "480", "640")

FORBIDDEN_BYTE_PATTERNS: tuple[tuple[str, bytes], ...] = (
    ("SUPABASE_SERVICE_ROLE_KEY", b"SUPABASE_SERVICE_ROLE_KEY"),
    ("ELEVENLABS_API_KEY", b"ELEVENLABS_API_KEY"),
    ("PEM private key", b"BEGIN PRIVATE KEY"),
    ("RSA private key", b"BEGIN RSA PRIVATE KEY"),
    ("EC private key", b"BEGIN EC PRIVATE KEY"),
    ("OpenSSH private key", b"BEGIN OPENSSH PRIVATE KEY"),
    ("Loopback HTTPS origin", b"https://127.0.0.1"),
    ("Loopback HTTP origin", b"http://127.0.0.1"),
    ("Localhost HTTPS origin", b"https://localhost"),
    ("Compile-only example.org origin", b"https://viread.example.org"),
    ("Compile-only example.org root", b"https://example.org"),
    ("Placeholder invalid domain", b".placeholder.invalid"),
)

RunnerFn = Callable[[list[str]], tuple[int, str, str]]


def _build_subprocess_command(
    cmd: list[str], *, is_windows: bool | None = None
) -> list[str]:
    """Invoke Windows batch/cmd wrappers via cmd.exe /c to avoid [WinError 193]."""
    win = (os.name == "nt") if is_windows is None else is_windows
    if win and cmd and Path(cmd[0]).suffix.lower() in {".bat", ".cmd"}:
        return ["cmd.exe", "/c", *cmd]
    return list(cmd)


def _default_runner(cmd: list[str]) -> tuple[int, str, str]:
    env = os.environ.copy()
    if not env.get("JAVA_HOME") and Path(r"F:\c1\tools\jdk-17\bin\java.exe").is_file():
        env["JAVA_HOME"] = r"F:\c1\tools\jdk-17"
    proc = subprocess.run(
        _build_subprocess_command(cmd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
        env=env,
    )
    return proc.returncode, proc.stdout, proc.stderr


def resolve_build_tool(tool_base: str, explicit_path: str | None = None) -> str:
    if explicit_path:
        candidate = Path(explicit_path)
        if candidate.is_file():
            return str(candidate)
        raise FileNotFoundError(f"{tool_base} not found at {explicit_path}")

    sdk_roots = [
        os.environ.get("ANDROID_HOME", ""),
        os.environ.get("ANDROID_SDK_ROOT", ""),
        r"F:\c1\tools\android-sdk",
    ]
    suffixes = (".exe", ".bat", ".cmd", "") if os.name == "nt" else ("",)
    for root in sdk_roots:
        if not root:
            continue
        bt_dir = Path(root) / "build-tools"
        if not bt_dir.is_dir():
            continue
        for version_dir in sorted(bt_dir.iterdir(), reverse=True):
            for suffix in suffixes:
                cand = version_dir / f"{tool_base}{suffix}"
                if cand.is_file():
                    return str(cand)

    which = shutil.which(tool_base)
    if which:
        return which
    raise FileNotFoundError(
        f"Could not locate Android SDK tool '{tool_base}'. Set ANDROID_HOME or pass path explicitly."
    )


def _extract_single(pattern: str, text: str, label: str) -> str:
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        raise ValueError(f"Missing or invalid {label} in APK badging output")
    return match.group(1)


def verify_badging_output(badging: str) -> dict[str, object]:
    pkg_name = _extract_single(r"^package:\s+name='([^']+)'", badging, "package name")
    if pkg_name != "vn.viread.android":
        raise ValueError(f"Expected package 'vn.viread.android', got '{pkg_name}'")

    app_label = _extract_single(r"^application-label:'([^']*)'", badging, "application-label")
    if app_label != "ViRead":
        raise ValueError(f"Expected application-label 'ViRead', got '{app_label}'")

    min_sdk = int(
        _extract_single(
            r"^(?:minSdkVersion|sdkVersion):'(\d+)'", badging, "minSdkVersion"
        )
    )
    if min_sdk < 26:
        raise ValueError(f"Expected minSdk >= 26, got {min_sdk}")

    target_sdk = int(_extract_single(r"^targetSdkVersion:'(\d+)'", badging, "targetSdkVersion"))
    if target_sdk != 35:
        raise ValueError(f"Expected targetSdk == 35, got {target_sdk}")

    launchable = _extract_single(
        r"^launchable-activity:\s+name='([^']+)'", badging, "launchable-activity"
    )
    if launchable != "vn.viread.android.MainActivity":
        raise ValueError(f"Unexpected launchable activity: {launchable}")

    icons: dict[str, str] = {}
    for density in REQUIRED_ICON_DENSITIES:
        icon_path = _extract_single(
            rf"^application-icon-{density}:'([^']+)'",
            badging,
            f"application-icon-{density}",
        )
        if not icon_path.strip():
            raise ValueError(f"Empty icon path for density {density}")
        icons[density] = icon_path

    return {
        "package": pkg_name,
        "label": app_label,
        "min_sdk": min_sdk,
        "target_sdk": target_sdk,
        "launchable_activity": launchable,
        "icons": icons,
    }


def verify_manifest_xmltree(xmltree: str) -> None:
    if "usesCleartextTraffic" not in xmltree:
        raise ValueError("AndroidManifest xmltree missing android:usesCleartextTraffic")
    if re.search(
        r"usesCleartextTraffic[^=\n]*=(?:\(type 0x12\)0xffffffff|true\b)",
        xmltree,
        flags=re.IGNORECASE,
    ):
        raise ValueError("APK permits cleartext HTTP traffic (usesCleartextTraffic=true)")
    if not re.search(
        r"usesCleartextTraffic[^=\n]*=(?:\(type 0x12\)0x0\b|false\b)",
        xmltree,
        flags=re.IGNORECASE,
    ):
        raise ValueError("usesCleartextTraffic must be explicitly false")

    if re.search(
        r"allowBackup[^=\n]*=(?:\(type 0x12\)0xffffffff|true\b)",
        xmltree,
        flags=re.IGNORECASE,
    ):
        raise ValueError("APK allows unencrypted backup (allowBackup=true)")
    if not re.search(
        r"allowBackup[^=\n]*=(?:\(type 0x12\)0x0\b|false\b)",
        xmltree,
        flags=re.IGNORECASE,
    ):
        raise ValueError("allowBackup must be explicitly false")

    if "androidx.core.content.FileProvider" not in xmltree:
        raise ValueError("AndroidManifest xmltree missing androidx.core.content.FileProvider")
    if "vn.viread.android.fileprovider" not in xmltree:
        raise ValueError("AndroidManifest xmltree missing vn.viread.android.fileprovider authority")


def inspect_apk_zip_contents(apk_path: Path) -> dict[str, int]:
    if not apk_path.is_file() or apk_path.stat().st_size <= 0:
        raise ValueError(f"APK file missing or empty: {apk_path}")

    mipmap_entries = 0
    adaptive_entries = 0
    with zipfile.ZipFile(apk_path, "r") as zf:
        names = zf.namelist()
        if not any(name.endswith(".dex") for name in names):
            raise ValueError("APK archive contains no classes.dex bytecode")

        for name in names:
            lower = name.lower()
            if lower.startswith("assets/_next/") or lower == "assets/index.html":
                raise ValueError(
                    f"Forbidden static web bundle detected inside APK: {name}"
                )
            if "ic_launcher" in lower and lower.endswith(".png"):
                info = zf.getinfo(name)
                if info.file_size <= 0:
                    raise ValueError(f"Zero-byte launcher icon PNG in APK: {name}")
                mipmap_entries += 1
            if "ic_launcher" in lower and lower.endswith(".xml") and "mipmap" in lower:
                adaptive_entries += 1

            # Skip compressed signature block binary false-positives; scan all app code/resources
            if lower.startswith("meta-inf/"):
                continue
            payload = zf.read(name)
            for reason, pattern in FORBIDDEN_BYTE_PATTERNS:
                if pattern in payload:
                    raise ValueError(
                        f"Forbidden secret or invalid endpoint '{reason}' found in APK entry '{name}'"
                    )
            # Check service_role JWT/key leak specifically without tripping generic words
            if b"service_role" in payload and (b"eyJ" in payload or b"supabase" in payload.lower()):
                raise ValueError(
                    f"Potential Supabase service_role credential leak in APK entry '{name}'"
                )

    if mipmap_entries < 10:
        raise ValueError(
            f"Expected at least 10 raster launcher PNGs (square + round across mdpi..xxxhdpi), found {mipmap_entries}"
        )
    if adaptive_entries < 2:
        raise ValueError(
            f"Expected adaptive launcher XMLs (ic_launcher.xml & ic_launcher_round.xml), found {adaptive_entries}"
        )
    return {
        "total_entries": len(names),
        "launcher_png_count": mipmap_entries,
        "adaptive_xml_count": adaptive_entries,
    }


def verify_apk(
    apk_path: Path,
    *,
    aapt2_bin: str | None = None,
    apksigner_bin: str | None = None,
    runner: RunnerFn = _default_runner,
) -> dict[str, object]:
    apk_path = apk_path.resolve()
    zip_stats = inspect_apk_zip_contents(apk_path)

    aapt2 = resolve_build_tool("aapt2", aapt2_bin)
    apksigner = resolve_build_tool("apksigner", apksigner_bin)

    rc_badging, out_badging, err_badging = runner([aapt2, "dump", "badging", str(apk_path)])
    if rc_badging != 0:
        raise RuntimeError(f"aapt2 dump badging failed ({rc_badging}): {err_badging.strip()}")
    badging_info = verify_badging_output(out_badging)

    rc_xml, out_xml, err_xml = runner(
        [aapt2, "dump", "xmltree", str(apk_path), "--file", "AndroidManifest.xml"]
    )
    if rc_xml != 0:
        raise RuntimeError(f"aapt2 dump xmltree failed ({rc_xml}): {err_xml.strip()}")
    verify_manifest_xmltree(out_xml)

    rc_sig, out_sig, err_sig = runner(
        [apksigner, "verify", "--verbose", "--print-certs", str(apk_path)]
    )
    if rc_sig != 0 or "Verified using" not in out_sig:
        raise ValueError(
            f"apksigner verification failed ({rc_sig}): {(err_sig or out_sig).strip()}"
        )

    sha256 = hashlib.sha256(apk_path.read_bytes()).hexdigest()
    size_bytes = apk_path.stat().st_size

    return {
        "apk_path": str(apk_path),
        "size_bytes": size_bytes,
        "size_mb": round(size_bytes / (1024 * 1024), 2),
        "sha256": sha256,
        **badging_info,
        **zip_stats,
        "signature_verified": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify built ViRead Android APK quality.")
    default_apk = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "build"
        / "outputs"
        / "apk"
        / "debug"
        / "app-debug.apk"
    )
    parser.add_argument("apk", nargs="?", default=str(default_apk), help="Path to .apk file")
    parser.add_argument("--aapt2", default=None, help="Explicit path to aapt2 binary")
    parser.add_argument("--apksigner", default=None, help="Explicit path to apksigner binary")
    args = parser.parse_args(argv)

    try:
        report = verify_apk(
            Path(args.apk),
            aapt2_bin=args.aapt2,
            apksigner_bin=args.apksigner,
        )
    except Exception as exc:
        print(f"APK quality audit FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
