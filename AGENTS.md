# ViRead Codex — Minimal Rules

- Preserve dirty work; never reset/clean/discard it unless explicitly asked.
- Scope rules: before editing `backend/**`, read `backend/AGENTS.md`; before editing `frontend/**`, read `frontend/AGENTS.md`. Pure text/CSS/local presentational frontend edits do not require Next.js docs; framework/API/routing/rendering/data/config changes do.
- Known file/symbol → act or exact-search. Unknown flow → exact search first; query Graphify only when a fresh local graph exists. If Graphify is actually needed, then read `.codex/skills/graphify/SKILL.md`; never load that large guide for ordinary tasks. If no fresh graph exists, do not build one for a single lookup; build only for repeated/structural cross-file discovery and honor `.graphifyignore`. Graph outputs are local/generated state.
- Skills: use source/project docs first; single-domain ≤1 gateway, multi-domain only what is necessary. Open detailed `.agent-library/<skill>/SKILL.md` only for missing knowledge. Do not reread a loaded skill; after resume/compaction reload only what `NEXT` needs.
- Rare/non-code workflow with no gateway: try `.agent-library/<skill>/SKILL.md`; if unclear, exact-search `skills-lock.json` by name only. Never scan the whole library.
- New unrelated task skips `PROJECT_STATE.md`. Resume: checkpoint + `git status --short` + `git diff --name-only` + `git log -3 --oneline`; unchanged verified source/tests/Graphify/root-cause stay valid until relevant Git changes invalidate them.
- Milestones: update only `GOAL/ROOT/VERIFIED/NEXT/DO_NOT_REPEAT/BASE` from active knowledge; never rescan just to checkpoint.
- Subagents only for independent workstreams/isolated verification, not focused edits.
- Non-obvious debug → `.agent-library/systematic-debugging/SKILL.md`; completion → `.agent-library/viread-quality-gate/SKILL.md` + `.agent-library/verification-before-completion/SKILL.md`.
- Focused failure-only tests first. When agent configuration changes, run `python scripts/validate_agent_config.py`.
- Never expose secrets/JWT/signed tokens or weaken authorization/RLS.
