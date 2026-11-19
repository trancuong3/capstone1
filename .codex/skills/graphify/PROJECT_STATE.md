# ACTIVE STATE

STATUS: COMMITTED_MAIN
GOAL: minimum useful Codex context with reliable ViRead routing.

DONE:
- 81 detailed skills preserved in `.agent-library/`.
- Auto-discovery: 9 → 6 concise domain gateways; router/debug/quality layers removed.
- AGENTS compressed; new tasks skip checkpoint.
- Raw search ignores `graphify-out/` and `.agent-library/`.
- Graphify trigger narrowed to unknown location/dependency/flow.

MEASURED:
- Gateway metadata: 258 → 82 rough tokens.
- AGENTS: 346 → 305 rough tokens.
- Checkpoint: 328 → ~155 rough tokens.
- Possible fixed repo context incl. Graphify metadata: ~695 → ~416 rough tokens.

NEXT:
- Known file/symbol first; Graphify only for unknown flow.
- One gateway per domain; detailed skills only on demand.
- Focused/failure-only tests; keep handoff compact.

BASE: main @ 64afaaad; Git is source of truth.
