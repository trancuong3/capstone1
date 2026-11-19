# ViRead Codex — Minimal Rules

- Preserve dirty work; never reset/clean/discard local changes unless explicitly asked.
- Known file/symbol: act or exact-search. Unknown flow: Graphify 300→600→1000; broad scan last. Read only needed ranges.
- Skills: single-domain = max 1 gateway; multi-domain = only necessary gateways. Use source/project docs first; open a detailed `.agent-library/<skill>/SKILL.md` only when it adds knowledge missing from source/docs.
- Same task: do not reread an already loaded detailed skill. After resume/compaction, reload only the skill needed for `NEXT`.
- New unrelated tasks skip `PROJECT_STATE.md`. Resume unfinished work from checkpoint + `git status --short` + `git diff --name-only` + `git log -3 --oneline`.
- On resume, verified unchanged source is not reread; unaffected passed tests are not rerun; known Graphify facts/root causes are not rediscovered unless relevant Git changes invalidate them.
- At meaningful milestones, update checkpoint from current knowledge only: `GOAL / ROOT / VERIFIED / NEXT / DO_NOT_REPEAT / BASE`. Never rescan just to write it.
- Use subagents only for independent workstreams/isolated verification; not for single-file or focused edits.
- Non-obvious debug: `.agent-library/systematic-debugging/SKILL.md`. Near completion: `.agent-library/viread-quality-gate/SKILL.md` + `.agent-library/verification-before-completion/SKILL.md`.
- Focused, concise/failure-only tests first. Run `graphify update .` only before meaningful source commit/merge or when a stale graph is needed.
- Never expose secrets/JWT/signed tokens or weaken authorization/RLS.
