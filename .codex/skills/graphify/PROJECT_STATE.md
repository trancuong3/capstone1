# ACTIVE STATE

STATUS:
COMMITTED_MAIN

GOAL:
- Keep Codex context/token overhead minimal without losing project intelligence or safety.

DONE:
- 81 detailed skills moved intact to `.agent-library/`.
- 9 tiny gateway skills remain auto-discovered in `.agents/skills/`.
- Graphify remains available from `.codex/skills/graphify`.
- T0/T1/T2/T3 routing and 300→600→1000→1500 Graphify escalation installed.
- Rare skills remain available lazily through `skills-lock.json` + `.agent-library/`.
- AGENTS and resume checkpoint compressed.

VERIFIED:
- Detailed skills preserved exactly: 81/81 tree SHA unchanged.
- Auto-discovered project skills: 81 → 9 (plus Graphify: total 82 → 10).
- Skill metadata: ~23,875 chars incl. Graphify → ~1,391 chars (~5,969 → ~348 rough tokens).
- AGENTS.md: 4,222 → 1,381 chars (~1,056 → ~346 rough tokens).
- PROJECT_STATE.md: 4,585 → ~1,500 chars (~1,147 → ~375 rough tokens).
- Eight routing scenarios conform by rule: T0 text/README; T1 known symbol; T2 Supabase/speech; T2/T3 Figma; mobile gateway; resume without rediscovery.

ISSUES:
- Local uncommitted application code cannot be recovered from GitHub main.

NEXT:
1. Classify each prompt T0/T1/T2/T3 automatically.
2. Use the smallest matching gateway; open detailed library skill only when needed.
3. Known file/symbol first; Graphify only when ownership/flow is unknown.
4. Focused tests first; quality gateway near completion.
5. Update this checkpoint only at meaningful handoff/commit points.

DO NOT REDO:
- Do not restore detailed skills to auto-discovery.
- Do not expand AGENTS into domain manuals.
- Do not turn this file into a changelog.
- Do not discard dirty local work.

BASE:
- main
- gateway migration commit: b0e5d73ecb6213e86f41a94d9736d4a5556be9fa
- lazy fallback commit: 5a1ce5ffa61cc07f17c0d3b004bba7fa5a9522e5
- Git is source of truth.
