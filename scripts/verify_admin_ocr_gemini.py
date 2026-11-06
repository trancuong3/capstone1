#!/usr/bin/env python3
"""Run the isolated Admin OCR lifecycle and Gemini verification suite."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
LOG_DIR = Path(tempfile.gettempdir()) / "capstone1-admin-ocr-verification"


def is_test_database(url: str | None) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return (
        host in {"localhost", "127.0.0.1", "::1", "postgres"}
        and parsed.username == "test"
        and parsed.password == "test"
        and parsed.path.strip("/") == "test"
    )


def run_check(name: str, command: list[str], cwd: Path, env: dict[str, str]) -> bool:
    print(f"\n=== {name} ===", flush=True)
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    except OSError as exc:
        print(f"FAIL: could not start command: {exc}", flush=True)
        return False

    output = result.stdout or ""
    if result.returncode == 0:
        lines = output.rstrip().splitlines()
        print("\n".join(lines[-30:]) if lines else "(no output)", flush=True)
        print(f"PASS: {name}", flush=True)
        return True

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_name = "".join(character if character.isalnum() else "_" for character in name)
    log_path = LOG_DIR / f"{log_name}.log"
    log_path.write_text(output, encoding="utf-8")
    print(output.rstrip(), flush=True)
    print(f"FAIL: {name} (exit {result.returncode}); full log: {log_path}", flush=True)
    return False


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    if not (BACKEND / "app").is_dir() or not (FRONTEND / "package.json").is_file():
        print("FAIL: run this script from a complete capstone1 checkout.")
        return 2
    npm = shutil.which("npm")
    if not npm:
        print("FAIL: npm is required for frontend checks.")
        return 2

    env = os.environ.copy()
    env.pop("GEMINI_API_KEY", None)
    env.pop("GOOGLE_API_KEY", None)
    env.update(
        {
            "APP_ENVIRONMENT": "test",
            "DATABASE_URL": "postgresql+asyncpg://test:test@127.0.0.1:1/test",
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_KEY": "isolated-test-key",
            "NEXT_PUBLIC_SUPABASE_URL": "https://example.supabase.co",
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
            "NEXT_PUBLIC_API_URL": "http://127.0.0.1:8000",
        }
    )
    admin_database = env.get("ADMIN_OCR_TEST_DATABASE_URL")
    if not is_test_database(admin_database):
        env.pop("ADMIN_OCR_TEST_DATABASE_URL", None)
        print(
            "SKIP: PostgreSQL integration needs ADMIN_OCR_TEST_DATABASE_URL "
            "pointing to localhost, 127.0.0.1, ::1, or the local postgres CI service."
        )
        database_available = False
    else:
        database_available = True
    if not is_test_database(env.get("READING_REPORT_TEST_DATABASE_URL")):
        env.pop("READING_REPORT_TEST_DATABASE_URL", None)

    checks: list[tuple[str, list[str], Path]] = [
        (
            "Backend unit, API, and regression suite",
            [sys.executable, "-X", "utf8", "-m", "unittest", "discover", "-v"],
            BACKEND,
        ),
        ("Frontend formatting", [npm, "run", "format:check"], FRONTEND),
        ("Frontend lint", [npm, "run", "lint"], FRONTEND),
        ("Frontend TypeScript", [npm, "run", "typecheck"], FRONTEND),
        ("Frontend unit tests", [npm, "test"], FRONTEND),
        ("Frontend production build", [npm, "run", "build"], FRONTEND),
        (
            "Admin OCR browser E2E",
            [
                npm,
                "exec",
                "--",
                "playwright",
                "test",
                "--config=playwright.real-data.config.ts",
                "--grep",
                "Admin OCR draft",
            ],
            FRONTEND,
        ),
    ]
    results: list[tuple[str, bool]] = []
    for name, command, cwd in checks:
        results.append((name, run_check(name, command, cwd, env)))

    print("\n=== Verification summary ===")
    for name, passed in results:
        print(f"{'PASS' if passed else 'FAIL'}  {name}")
    print(
        "PASS  Local disposable PostgreSQL configured"
        if database_available
        else "FAIL  Local disposable PostgreSQL configured (integration coverage skipped)"
    )
    if not database_available or not all(passed for _, passed in results):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
