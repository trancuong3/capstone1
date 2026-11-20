"""Read-only repository hygiene regression (no network or third-party packages).

Use with `python scripts/verify_repository_hygiene.py` after updating the
agent/skill configuration. This script intentionally never deletes files.
"""

from __future__ import annotations

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

    print(
        "Repository hygiene OK: generated Graphify tracked files=0; "
        f"critical tracked agent files={len(PROTECTED_FILES)}"
    )


if __name__ == "__main__":
    verify()
