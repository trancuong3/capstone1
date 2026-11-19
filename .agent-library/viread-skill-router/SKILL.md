---
name: viread-skill-router
description: "Legacy compatibility only; current ViRead routing is defined by root AGENTS.md and the six auto-discovered viread-* domain gateways."
---

# ViRead Legacy Router Compatibility

Do not use this skill for normal task routing. It remains only so historical/external workflows that explicitly request `viread-skill-router` fail safely.

Current canonical routing:
- backend → `viread-backend`
- frontend logic → `viread-frontend`
- Supabase/Postgres/auth/storage → `viread-data`
- child reading/speech/OCR → `viread-ai-reading`
- Figma/UI/visual design → `viread-ui`
- Android/APK/Expo/React Native → `viread-mobile`

Use source/project/version-local docs first. A single-domain task should normally use at most one gateway; add another only when the change genuinely crosses domains. Do not load generic detailed skills by default.

For unknown code relationships, exact-search first. If a fresh local graph already exists and exact search is insufficient, query Graphify at budget 300, then 600→1000 only as needed. Do not rebuild Graphify for a single lookup.

Completion uses `viread-quality-gate` as the canonical ViRead fresh final verification gate. Root `AGENTS.md` overrides this compatibility file.
