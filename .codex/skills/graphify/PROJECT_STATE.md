# ACTIVE STATE

STATUS: COMMITTED_MAIN

GOAL:
- Minimum Codex context/token overhead with safe project intelligence.

DONE:
- 81 detailed skills preserved in `.agent-library/`.
- 9 gateway skills auto-discovered in `.agents/skills/`; Graphify stays in `.codex/skills/`.
- T0/T1/T2/T3 routing + Graphify 300→600→1000→1500 escalation.
- Rare skills lazy-load via `skills-lock.json` + `.agent-library/`.
- Resume uses this checkpoint + cheap Git state; no rediscovery.

VERIFIED:
- Detailed skills preserved: 81/81 exact tree SHA.
- Auto-discovered total: 82 → 10.
- Skill metadata incl. Graphify: 23,875 → 1,391 chars (~5,969 → 348 rough tokens).
- AGENTS.md: 4,222 → 1,381 chars (~1,056 → 346 rough tokens).
- Routing scenarios: T0 text/README; T1 symbol; T2 Supabase/speech; Figma; mobile; resume all map to minimal paths.

NEXT:
1. Classify prompt T0/T1/T2/T3.
2. Use smallest gateway; open detailed skill only if needed.
3. Known file/symbol first; Graphify only for unknown flow.
4. Focused test first; quality gateway near completion.
5. Update checkpoint only at meaningful handoff/commit.

DO NOT REDO:
- No bulk skill auto-discovery.
- No domain manuals in AGENTS.
- No changelog here.
- Never discard dirty local work.

BASE:
- main
- gateway: b0e5d73
- lazy fallback: 5a1ce5f
- Git is source of truth.
