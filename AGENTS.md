# ViRead Codex — Minimal Rules

- Preserve dirty work; never reset/clean/discard local changes unless explicitly asked.
- Known file/symbol: act or exact-search directly. Unknown flow: Graphify 300→600→1000; broad scan last. Read only needed ranges.
- Skills: single-domain = max 1 gateway; multi-domain = only necessary gateways. Open detailed `.agent-library/<skill>/SKILL.md` only when a gateway points to it. Rare task: inspect exact library names; never read all skills or `skills-lock.json`.
- Resume only for unfinished/continue work: read `.codex/skills/graphify/PROJECT_STATE.md`, then `git status --short`, `git diff --name-only`, `git log -3 --oneline`. New tasks skip checkpoint.
- Non-obvious debugging: read `.agent-library/systematic-debugging/SKILL.md`. Near completion: read `.agent-library/viread-quality-gate/SKILL.md` and `.agent-library/verification-before-completion/SKILL.md`.
- Focused tests first; concise/failure-only output. Run `graphify update .` only before meaningful source commit/merge or when a stale graph is needed.
- FastAPI entrypoint is `backend/app/sever.py`; never rename it.
- Never expose Supabase/service-role secrets, JWTs, signed URL tokens, or weaken authorization/RLS.
