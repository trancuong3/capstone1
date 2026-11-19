# ViRead Codex — Minimal Rules

- Preserve dirty work; never reset/clean/discard local changes unless explicitly asked.
- Known file/symbol: act or exact-search. Unknown flow: Graphify 300→600→1000; broad scan last. Read only needed ranges.
- Skills: single-domain = max 1 gateway; multi-domain = only necessary gateways. Open only the detailed `.agent-library/<skill>/SKILL.md` actually needed.
- New unrelated tasks skip `PROJECT_STATE.md`. Resume unfinished work from checkpoint + `git status --short` + `git diff --name-only` + `git log -3 --oneline`.
- On resume, verified unchanged source is not reread; unaffected passed tests are not rerun; known Graphify facts/root causes are not rediscovered unless relevant Git changes invalidate them.
- At meaningful milestones, update checkpoint from current knowledge only: `GOAL / ROOT / VERIFIED / NEXT / DO_NOT_REPEAT / BASE`. Never rescan just to write it.
- Non-obvious debug: `.agent-library/systematic-debugging/SKILL.md`. Near completion: `viread-quality-gate` + `verification-before-completion`.
- Focused, concise/failure-only tests first. Run `graphify update .` only before meaningful source commit/merge or when a stale graph is needed.
- FastAPI entrypoint is `backend/app/sever.py`; never rename it.
- Never expose secrets/JWT/signed tokens or weaken authorization/RLS.
