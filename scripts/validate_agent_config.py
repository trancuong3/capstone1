from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_GATEWAYS = {
    "viread-ai-reading",
    "viread-backend",
    "viread-data",
    "viread-frontend",
    "viread-mobile",
    "viread-ui",
}
REQUIRED_LIBRARY_SKILLS = {
    "fastapi",
    "supabase",
    "systematic-debugging",
    "verification-before-completion",
    "viread-quality-gate",
    "viread-reading-assessment",
    "viread-ocr-vietnamese",
    "figma-design-to-code",
    "viread-android-apk",
}

errors: list[str] = []

skill_root = ROOT / ".agents" / "skills"
actual = {p.parent.name for p in skill_root.glob("*/SKILL.md")}
if actual != EXPECTED_GATEWAYS:
    errors.append(f"gateway set mismatch: expected={sorted(EXPECTED_GATEWAYS)} actual={sorted(actual)}")

for manifest in skill_root.glob("*/SKILL.md"):
    text = manifest.read_text(encoding="utf-8")
    name = re.search(r"^name:\s*[\"']?([^\"'\n]+)", text, re.M)
    desc = re.search(r"^description:\s*[\"']([^\n]+?)[\"']\s*$", text, re.M)
    if not name or name.group(1).strip() != manifest.parent.name:
        errors.append(f"invalid skill name: {manifest.relative_to(ROOT)}")
    if not desc or not desc.group(1).strip().lower().startswith("use for viread"):
        errors.append(f"description must be a precise 'Use for ViRead ...' trigger: {manifest.relative_to(ROOT)}")

cfg = json.loads((ROOT / ".agents" / "skills.json").read_text(encoding="utf-8"))
paths = [entry.get("path") for entry in cfg.get("entries", [])]
if paths != [".agents/skills"]:
    errors.append(f".agents/skills.json must expose only .agents/skills, got {paths}")

for name in REQUIRED_LIBRARY_SKILLS:
    if not (ROOT / ".agent-library" / name / "SKILL.md").is_file():
        errors.append(f"missing required lazy skill: .agent-library/{name}/SKILL.md")

root_agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
for token in ("backend/**", "backend/AGENTS.md", "frontend/**", "frontend/AGENTS.md"):
    if token not in root_agents:
        errors.append(f"root AGENTS missing scoped-rule trigger: {token}")
for token in ("graphify query", "--budget 300", "query-only", "build/update/export/diagnose"):
    if token not in root_agents:
        errors.append(f"root AGENTS missing Graphify fast-path rule: {token}")

backend_agents = (ROOT / "backend" / "AGENTS.md").read_text(encoding="utf-8")
for token in ("app/sever.py", "BACKEND_FLOW_STANDARD.md", "numpy==1.26.4", "protobuf==3.20.2"):
    if token not in backend_agents:
        errors.append(f"backend AGENTS missing invariant: {token}")

ignore = (ROOT / ".graphifyignore").read_text(encoding="utf-8")
for token in (".agent-library/", ".agents/", ".codex/", "graphify-out/"):
    if token not in ignore:
        errors.append(f".graphifyignore missing: {token}")

hooks = ROOT / ".codex" / "hooks.json"
if hooks.exists() and "graphify hook-check" in hooks.read_text(encoding="utf-8"):
    errors.append("obsolete graphify PreToolUse hook is still enabled")

try:
    tracked = subprocess.run(
        ["git", "ls-files", "graphify-out"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if tracked:
        errors.append("generated graphify-out files are tracked by Git")
except (OSError, subprocess.CalledProcessError):
    pass

if errors:
    print("Agent config validation FAILED:")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

print("Agent config validation OK")
