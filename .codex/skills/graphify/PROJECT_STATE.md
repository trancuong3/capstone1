# ACTIVE STATE

STATUS:
COMMITTED_MAIN

GOAL:
- Minimize Codex token/context overhead while preserving project intelligence and safety.

DONE:
- T0/T1/T2/T3 minimum-context policy defined.
- Graphify escalation starts at 300 tokens.
- 81 detailed skills identified as excessive auto-discovery overhead.
- Gateway architecture designed: only small ViRead gateways auto-discover; detailed skills remain preserved in .agent-library/.
- Resume/checkpoint flow avoids rediscovery.

CHANGED:
- AGENTS.md
- .agents/skills/*
- .agent-library/*
- .codex/skills/graphify/PROJECT_STATE.md

VERIFIED:
- Baseline auto-discovered detailed skills: 81.
- Baseline skill name+description metadata: ~23,514 chars (~5,879 rough tokens).
- Baseline AGENTS.md: 4,222 chars (~1,056 rough tokens).
- Baseline PROJECT_STATE.md: 4,585 chars (~1,147 rough tokens).

ISSUES:
- Local application code not pushed to GitHub cannot be recovered by pulling main.

NEXT:
1. For any new prompt, classify T0/T1/T2/T3 automatically.
2. Use only the smallest relevant gateway.
3. Open detailed .agent-library skill only if the gateway requires it.
4. Resume from this file without rediscovering completed work.
5. Before meaningful source commit/merge, update Graphify once and run focused final verification.

DO NOT REDO:
- Do not restore all detailed skills to auto-discovery.
- Do not re-expand AGENTS.md into domain manuals.
- Do not turn this checkpoint into a changelog.

BASE:
- main
- Git is source of truth.
