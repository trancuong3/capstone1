---
name: viread-router
description: "Use only for ambiguous or cross-domain ViRead tasks (T2/T3) to select the fewest gateway/domain skills and minimum context."
---
# Token-minimal router
Classify first:
- T0 known tiny edit: 0 skills, 0 Graphify.
- T1 focused: one gateway max; Graphify only if location/flow unknown.
- T2 complex: router + up to 3 gateways/domain skills.
- T3 cross-cutting: up to 5 only when necessary.

Search escalation: known file → exact symbol → Graphify 300 → 600 → targeted reads → 1000+ only if required.
Resume from `.codex/skills/graphify/PROJECT_STATE.md`; never rediscover known work.
