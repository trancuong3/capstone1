# ACTIVE STATE

STATUS: COMMITTED_MAIN
GOAL: stable quality-first, token-minimal Codex harness; no active application task.
ROOT: main structural bugs were scoped AGENTS not auto-loading from repo-root CWD and a stale committed Graphify graph indexing the old skill layout.
VERIFIED: root now explicitly loads backend/frontend scoped rules by path; Graphify generated state is local-only and agent/config trees are excluded; native/custom skill discovery exposes only 6 gateways; obsolete Graphify Bash hook removed; config validator added.
NEXT: when a long task starts, overwrite with GOAL/ROOT/VERIFIED/NEXT/DO_NOT_REPEAT/BASE.
DO_NOT_REPEAT: do not re-audit unchanged agent architecture; run `python scripts/validate_agent_config.py` after agent-config changes.
BASE: no active application task; record exact Git SHA when task work begins.
