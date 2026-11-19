# ViRead Codex — Minimal Rules

- Preserve dirty work; never reset/clean/discard it unless explicitly asked.
- Scope rules: before editing `backend/**` or `frontend/**`, ensure that subtree's `AGENTS.md` is in context; if CWD already auto-injected it, do not reread it. Pure text/CSS/local presentational frontend edits do not require Next.js docs; framework/API/routing/rendering/data/config changes do.
- Known file/symbol → act or exact-search. Unknown flow → exact search first. If a fresh local graph exists, query it directly with `graphify query "<question>" --budget 300`, escalating only to 600→1000 when evidence is insufficient; do not read the full Graphify guide for query-only work. Read `.codex/skills/graphify/SKILL.md` only to build/update/export/diagnose Graphify. If no fresh graph exists, do not build one for a single lookup; build only for repeated/structural cross-file discovery and honor `.graphifyignore`. Graph outputs are local/generated state.
- Skills: use source/project docs first; single-domain ≤1 gateway, multi-domain only what is necessary. Open detailed `.agent-library/<skill>/SKILL.md` only for missing knowledge. Do not reread a loaded skill; after resume/compaction reload only what `NEXT` needs.
- Rare/non-code workflow with no gateway: try `.agent-library/<skill>/SKILL.md`; if unclear, exact-search `skills-lock.json` by name only. Never scan the whole library.
- New unrelated task skips `PROJECT_STATE.md`. Resume: checkpoint + `git status --short` + `git diff --name-only` + `git log -3 --oneline`; unchanged verified source/tests/Graphify/root-cause stay valid until relevant Git changes invalidate them.
- Milestones: update only `GOAL/ROOT/VERIFIED/NEXT/DO_NOT_REPEAT/BASE` from active knowledge; never rescan just to checkpoint.
- Subagents only for independent workstreams/isolated verification, not focused edits.
- Non-obvious debug → `.agent-library/systematic-debugging/SKILL.md`; completion → `.agent-library/viread-quality-gate/SKILL.md` + `.agent-library/verification-before-completion/SKILL.md`.
- Focused failure-only tests first. When agent configuration changes, run `python scripts/validate_agent_config.py`.
- Never expose secrets/JWT/signed tokens or weaken authorization/RLS.
