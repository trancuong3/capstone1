"""Read-only repository hygiene regression (no network or third-party packages).

Use with `python scripts/verify_repository_hygiene.py` after updating the
agent/skill configuration. This script intentionally never deletes files.
"""

from __future__ import annotations

from collections.abc import Iterable
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROTECTED_FILES = (
    "AGENTS.md",
    "backend/AGENTS.md",
    "frontend/AGENTS.md",
    ".agents/skills.json",
    ".codex/skills/graphify/SKILL.md",
    ".graphifyignore",
    ".gitignore",
    "skills-lock.json",
    "scripts/validate_agent_config.py",
    ".agent-library/viread-quality-gate/SKILL.md",
    ".agent-library/viread-skill-router/SKILL.md",
)
BINARY_EXTENSIONS = frozenset({
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".mp3",
    ".wav",
    ".ogg",
    ".wasm",
    ".pth",
    ".pt",
    ".onnx",
    ".zip",
    ".jar",
    ".apk",
    ".keystore",
    ".jks",
})
_KNOWN_TEXT_EXTENSIONS = frozenset({
    ".c",
    ".cjs",
    ".css",
    ".csv",
    ".dot",
    ".env",
    ".example",
    ".gradle",
    ".gs",
    ".h",
    ".html",
    ".ipynb",
    ".java",
    ".js",
    ".json",
    ".jsonl",
    ".kt",
    ".kts",
    ".lrc",
    ".md",
    ".mjs",
    ".pro",
    ".properties",
    ".ps1",
    ".py",
    ".sh",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".xsd",
    ".yaml",
    ".yml",
})
_BINARY_MAGIC_PREFIXES = (
    b"SQLite format 3\x00",
    b"\x89PNG\r\n\x1a\n",
    b"PK\x03\x04",
    b"\x7fELF",
    b"MZ",
)
_CONFLICT_CHEVRON_RE = re.compile(r"^(?:<{7,}|>{7,})(?:\s|$)")
_ILLEGAL_CONTROL_BYTE_RE = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _is_binary_file(path: Path, raw: bytes) -> bool:
    suffix = path.suffix.lower()
    if suffix in BINARY_EXTENSIONS:
        return True
    if b"\x00" not in raw:
        return False
    if raw.startswith(_BINARY_MAGIC_PREFIXES):
        return True
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return suffix not in _KNOWN_TEXT_EXTENSIONS


def scan_text_hygiene_violations(root: Path, rel_paths: Iterable[str]) -> list[str]:
    violations: list[str] = []
    for rel_path in rel_paths:
        if not rel_path:
            continue
        file_path = root / rel_path
        if file_path.suffix.lower() in BINARY_EXTENSIONS or not file_path.is_file():
            continue
        raw = file_path.read_bytes()
        if _is_binary_file(file_path, raw):
            continue

        for line_no, raw_line in enumerate(raw.splitlines(), start=1):
            ctrl_match = _ILLEGAL_CONTROL_BYTE_RE.search(raw_line)
            if ctrl_match is not None:
                bad_byte = ctrl_match.group(0)[0]
                violations.append(
                    f"{rel_path}:{line_no}: illegal ASCII control byte 0x{bad_byte:02X}"
                )

        text = raw.decode("utf-8", errors="replace")
        for line_no, line in enumerate(text.splitlines(), start=1):
            if _CONFLICT_CHEVRON_RE.match(line):
                violations.append(
                    f"{rel_path}:{line_no}: unresolved git conflict marker"
                )

    return violations


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout


def verify() -> None:
    # Git ignore only hides UNTRACKED files. Checking the index is mandatory.
    tracked_graphify = [
        path for path in git("ls-files", "--", "graphify-out/").splitlines()
        if path
    ]
    if tracked_graphify:
        raise AssertionError(
            f"{len(tracked_graphify)} generated Graphify cache files still tracked"
        )

    tracked = set(git("ls-files").splitlines())
    missing = [path for path in PROTECTED_FILES if path not in tracked]
    if missing:
        raise AssertionError(f"Critical agent/skill files not tracked: {missing}")

    for directory in (".agent-library/", ".agents/", ".codex/"):
        if not any(name.startswith(directory) for name in tracked):
            raise AssertionError(f"Agent configuration missing from Git: {directory}")

    for file in (".gitignore", ".graphifyignore"):
        patterns = (ROOT / file).read_text(encoding="utf-8").splitlines()
        if "graphify-out/" not in [x.strip() for x in patterns]:
            raise AssertionError(f"{file} must ignore Graphify outputs")

    # Unlike a text-only ignore assertion, this exercises Git's actual ignore
    # matching for a newly generated (untracked) cache artifact.
    result = subprocess.run(
        ["git", "check-ignore", "--quiet", "--",
         "graphify-out/cache/ast/future-source-cache.json"],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError("Graphify generated cache is not ignored by Git")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    if "repository đang ở chế độ private" in readme.lower():
        raise AssertionError("README still claims repository is private")
    if "convalidated = true" not in readme:
        raise AssertionError("README must distinguish validated Auth FK from old migration")
    if "LICENSE" not in readme:
        raise AssertionError("README must disclose licensing status")

    hygiene_violations = scan_text_hygiene_violations(ROOT, sorted(tracked))
    if hygiene_violations:
        preview = "; ".join(hygiene_violations[:10])
        raise AssertionError(
            f"Text hygiene violations in tracked files ({len(hygiene_violations)}): {preview}"
        )

    print(
        "Repository hygiene OK: generated Graphify tracked files=0; "
        f"critical tracked agent files={len(PROTECTED_FILES)}; "
        "text hygiene violations=0"
    )


if __name__ == "__main__":
    verify()
