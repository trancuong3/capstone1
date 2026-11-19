# ViRead Codex — Token-Minimal Rules

- Preserve dirty work. Never reset/clean/discard local changes unless explicitly asked.
- Classify every task: **T0** tiny known edit = 0 skill/0 Graphify; **T1** focused = max 1 gateway; **T2** multi-layer = router + max 3 gateways; **T3** cross-cutting = max 5 only when necessary.
- Use minimum sufficient context. Never load skills, files, logs, tests, or architecture "just in case".
- Search escalation: known file → exact symbol → Graphify `--budget 300` → 600 → targeted reads → 1000+ only if evidence is insufficient.
- If checkpoint already names the next file/action, skip Graphify and continue directly.
- Resume from `.codex/skills/graphify/PROJECT_STATE.md` + `git status --short` + `git diff --name-only` + `git log -3 --oneline`; never rediscover completed work.
- Detailed skills live in `.agent-library/`; auto-discovered `.agents/skills/` contains only small gateways. Open only the referenced detailed skill actually needed.
- Run the smallest relevant test first. Load `viread-quality` only near completion.
- Run `graphify update .` only before meaningful source commit/merge, major architecture milestones, or when a stale graph is needed.
- FastAPI entrypoint is `backend/app/sever.py`; never rename it.
- Never expose Supabase/service-role secrets, JWTs, signed URL tokens, or weaken authorization/RLS to save effort.
