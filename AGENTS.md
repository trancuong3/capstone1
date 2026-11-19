# ViRead Codex — Minimal Rules

- Preserve dirty work; never reset/clean/discard it unless explicitly asked.
- Known file/symbol → act or exact-search. Unknown flow → Graphify 300→600→1000. Broad scans last; read only needed ranges.
- Skills: use source/project docs first; single-domain ≤1 gateway, multi-domain only what is necessary. Open detailed `.agent-library/<skill>/SKILL.md` only for missing knowledge. Do not reread a loaded skill; after resume/compaction reload only what `NEXT` needs.
- New unrelated task skips `PROJECT_STATE.md`. Resume: checkpoint + `git status --short` + `git diff --name-only` + `git log -3 --oneline`; unchanged verified source/tests/Graphify/root-cause stay valid until relevant Git changes invalidate them.
- Milestones: update only `GOAL/ROOT/VERIFIED/NEXT/DO_NOT_REPEAT/BASE` from active knowledge; never rescan to checkpoint.
- Subagents only for independent workstreams/isolated verification, not focused edits.
- Non-obvious debug → `.agent-library/systematic-debugging/SKILL.md`; completion → `viread-quality-gate` + `verification-before-completion`.
- Focused failure-only tests first. `graphify update .` only for meaningful source commit/merge or a needed stale graph.
- Never expose secrets/JWT/signed tokens or weaken authorization/RLS.
