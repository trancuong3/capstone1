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
PROJECT_LOCAL_SKILLS = {
    "viread-android-apk",
    "viread-android-build",
    "viread-architecture",
    "viread-figma-parity",
    "viread-ocr-vietnamese",
    "viread-quality-gate",
    "viread-reading-assessment",
    "viread-skill-router",
    "viread-vietnamese-ocr",
}
EXPECTED_GATEWAY_TARGETS = {
    "viread-ai-reading": {"viread-reading-assessment", "viread-ocr-vietnamese", "viread-vietnamese-ocr"},
    "viread-backend": {"fastapi", "fastapi-expert"},
    "viread-data": {
        "supabase", "supabase-postgres-best-practices", "postgresql-table-design",
        "sqlalchemy-alembic-expert-best-practices-code-review",
        "auth-implementation-patterns", "secure-code-guardian", "owasp-top-10",
    },
    "viread-frontend": {"nextjs-app-router-patterns", "zod-4", "react-hook-form"},
    "viread-mobile": {"viread-android-build", "viread-android-apk", "vercel-react-native-skills"},
    "viread-ui": {"figma-design-to-code", "viread-figma-parity", "frontend-design", "ui-ux-pro-max"},
}

errors: list[str] = []


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def skill_name(text: str) -> str | None:
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    if len(parts) < 3:
        return None
    match = re.search(r'^name:\s*["\']?([^"\'\n]+)["\']?\s*$', parts[1], re.M)
    return match.group(1).strip() if match else None


def has_description(text: str) -> bool:
    if not text.startswith("---"):
        return False
    parts = text.split("---", 2)
    return len(parts) >= 3 and re.search(r"^description:\s*.*$", parts[1], re.M) is not None


skill_root = ROOT / ".agents" / "skills"
gateway_files = sorted(skill_root.glob("*/SKILL.md"))
gateway_names = {p.parent.name for p in gateway_files}
if gateway_names != EXPECTED_GATEWAYS:
    errors.append(f"gateway set mismatch: expected={sorted(EXPECTED_GATEWAYS)} actual={sorted(gateway_names)}")

library_root = ROOT / ".agent-library"
library_files = sorted(library_root.glob("*/SKILL.md"))
library_names: set[str] = set()
library_casefold: dict[str, str] = {}
for manifest in library_files:
    text = manifest.read_text(encoding="utf-8")
    folder = manifest.parent.name
    name = skill_name(text)
    if name != folder:
        errors.append(f"lazy skill name mismatch: {manifest.relative_to(ROOT)} name={name!r}")
    if not has_description(text):
        errors.append(f"lazy skill missing description: {manifest.relative_to(ROOT)}")
    if name:
        folded = name.casefold()
        if folded in library_casefold and library_casefold[folded] != name:
            errors.append(f"case-insensitive lazy skill collision: {library_casefold[folded]!r} vs {name!r}")
        library_casefold[folded] = name
        library_names.add(name)

for manifest in gateway_files:
    text = manifest.read_text(encoding="utf-8")
    folder = manifest.parent.name
    name = skill_name(text)
    if name != folder:
        errors.append(f"invalid gateway name: {manifest.relative_to(ROOT)} name={name!r}")
    front = text.split("---", 2)[1] if text.startswith("---") else ""
    desc = re.search(r'^description:\s*["\']([^\n]+?)["\']\s*$', front, re.M)
    if not desc or not desc.group(1).strip().lower().startswith("use for viread"):
        errors.append(f"gateway description must be a precise 'Use for ViRead ...' trigger: {manifest.relative_to(ROOT)}")
    expected = EXPECTED_GATEWAY_TARGETS.get(folder, set())
    for target in expected:
        if target not in text:
            errors.append(f"{folder} missing routing target text: {target}")
        if target not in library_names:
            errors.append(f"{folder} targets missing lazy skill: {target}")

lock = json.loads(read("skills-lock.json"))
if lock.get("version") != 2 or not isinstance(lock.get("skills"), dict):
    errors.append("skills-lock.json must be version 2 with a skills object")
else:
    locked = set(lock["skills"])
    expected_locked = library_names - PROJECT_LOCAL_SKILLS
    if locked != expected_locked:
        errors.append(
            "skills-lock/library drift: "
            f"missing_from_lock={sorted(expected_locked - locked)} "
            f"missing_from_library={sorted(locked - expected_locked)}"
        )

cfg = json.loads(read(".agents/skills.json"))
paths = [entry.get("path") for entry in cfg.get("entries", [])]
if paths != [".agents/skills"]:
    errors.append(f".agents/skills.json must expose only .agents/skills, got {paths}")

root_agents = read("AGENTS.md")
for token in ("backend/**", "backend/AGENTS.md", "frontend/**", "frontend/AGENTS.md"):
    if token not in root_agents:
        errors.append(f"root AGENTS missing scoped-rule trigger: {token}")
for token in ("graphify query", "--budget 300", "query-only", "build/update/export/diagnose"):
    if token not in root_agents:
        errors.append(f"root AGENTS missing Graphify fast-path rule: {token}")
for token in (".agent-library/viread-quality-gate/SKILL.md", "fresh final gate"):
    if token not in root_agents:
        errors.append(f"root AGENTS missing completion-gate rule: {token}")
if "+ `.agent-library/verification-before-completion/SKILL.md`" in root_agents:
    errors.append("root AGENTS still loads generic verification skill by default")

for text_path in ["AGENTS.md", *[str(p.relative_to(ROOT)) for p in gateway_files]]:
    text = read(text_path)
    for target in re.findall(r"\.agent-library/([^/`]+?)/SKILL\.md", text):
        if target not in library_names:
            errors.append(f"broken lazy-skill path in {text_path}: {target}")

backend_agents = read("backend/AGENTS.md")
for token in ("app/sever.py", "BACKEND_FLOW_STANDARD.md", "numpy==1.26.4", "protobuf==3.20.2", "Do not widen a focused fix"):
    if token not in backend_agents:
        errors.append(f"backend AGENTS missing invariant: {token}")

frontend_agents = read("frontend/AGENTS.md")
if "Pure text/CSS/local presentational edits do not require a Next.js docs read." not in frontend_agents:
    errors.append("frontend AGENTS missing presentational-edit docs exception")

package = json.loads(read("frontend/package.json"))
zod_version = str(package.get("dependencies", {}).get("zod", "")).lstrip("^~")
try:
    zod_major = int(zod_version.split(".", 1)[0])
except ValueError:
    zod_major = 0
frontend_gateway = read(".agents/skills/viread-frontend/SKILL.md")
if zod_major >= 4:
    if "zod-4" not in frontend_gateway or "never load both" not in frontend_gateway:
        errors.append("frontend gateway must route Zod 4 to zod-4 without loading both Zod skills")
for token in ("installed version", "installed package"):
    if token not in frontend_gateway:
        errors.append(f"frontend gateway missing version-local precedence: {token}")

mobile_gateway = read(".agents/skills/viread-mobile/SKILL.md")
for token in ("viread-android-build", "viread-android-apk", "Load both only"):
    if token not in mobile_gateway:
        errors.append(f"mobile gateway missing APK/build decision rule: {token}")

quality_gate = read(".agent-library/viread-quality-gate/SKILL.md")
if "Graphify freshness is not a completion criterion" not in quality_gate:
    errors.append("quality gate must not require Graphify freshness for completion")
if "If source code changed and `graphify-out/graph.json` exists" in quality_gate:
    errors.append("quality gate still contains obsolete unconditional Graphify update")

architecture = read(".agent-library/viread-architecture/SKILL.md")
for stale in ("--budget 1200", "Query Graphify first", "update the AST graph incrementally"):
    if stale in architecture:
        errors.append(f"viread-architecture still contains stale policy: {stale}")

router = read(".agent-library/viread-skill-router/SKILL.md")
if "Legacy compatibility" not in router or "viread-backend" not in router or "--budget 300" not in router:
    errors.append("legacy viread-skill-router is not aligned with current routing")

ignore = read(".graphifyignore")
for token in (".agent-library/", ".agents/", ".codex/", "graphify-out/"):
    if token not in ignore:
        errors.append(f".graphifyignore missing: {token}")

gitignore_patterns = {
    line.strip()
    for line in read(".gitignore").splitlines()
    if line.strip() and not line.lstrip().startswith("#")
}
for bad in {"tests/", "/tests/", "**/tests/", "tests/**", "**/tests/**"}:
    if bad in gitignore_patterns:
        errors.append(f".gitignore must not hide source tests: {bad}")

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
except (OSError, subprocess.CalledProcessError) as exc:
    errors.append(f"unable to verify tracked graphify-out state: {exc}")

if errors:
    print("Agent config validation FAILED:")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

print(
    "Agent config validation OK "
    f"(gateways={len(gateway_names)}, lazy_skills={len(library_names)}, locked_skills={len(lock.get('skills', {}))})"
)
