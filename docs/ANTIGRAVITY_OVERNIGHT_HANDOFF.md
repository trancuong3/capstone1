# ViRead Overnight Development — Handoff Document

## Current State (Last Updated)

| Item | Status |
|---|---|
| Branch | `feature/antigravity-figma-overnight-20261117` |
| PR | [#124](https://github.com/trancuong3/capstone1/pull/124) |
| Tests | ✅ 1,893 passed (115 files) |
| TypeScript | ✅ 0 errors |
| Lint | ✅ 0 errors |
| Format | ✅ Clean |
| Working tree | Clean (all committed and pushed) |

## What Was Done

### P0 — UI/Figma Alignment → 42/44 MATCHED
All screens now use the design token system from `globals.css`. Only 1 PARTIAL remains (`/admin/viread-training`, minor polish only). See `docs/ANTIGRAVITY_FIGMA_MATRIX.md` for full details.

### P1 — Reading Retry Bug Fix → COMPLETE
- `hasHighConfidenceKeytermResult` gate accepts keyterm STT results with logprob ≥ −0.5 without browser corroboration
- 7 regression tests + 2 test mock data fixes

### P2 — Karaoke Scoring → IMPLEMENTED
- Browser Web Speech API-based lyrics accuracy scoring
- Opt-in toggle, score card with stars, per-line breakdown
- 15 new tests
- Zero backend changes, zero cost

## What Was NOT Done
- P3 — Android APK
- P4 — Performance/accessibility improvements
- Pixel-perfect visual comparison (no Figma MCP access)
- Backend tests (no DB/backend in this environment)

## Review Checklist for PR Merge
1. [ ] Review `docs/ANTIGRAVITY_FIGMA_MATRIX.md` — updated with 42 MATCHED screens
2. [ ] Review `docs/ANTIGRAVITY_FINAL_REPORT.md` — comprehensive session report
3. [ ] Test karaoke scoring in browser with headphones (Chrome/Edge recommended)
4. [ ] Verify reading retry fix with a real Vietnamese word
5. [ ] Run backend tests locally before merging
6. [ ] Check UI changes on mobile viewport (390px)

## Files to Pay Attention To
- `frontend/lib/karaoke/singing-score.ts` — New scoring engine
- `frontend/hooks/use-karaoke-scoring.ts` — New speech recognition hook
- `frontend/components/karaoke/karaoke-stage.tsx` — Scoring integration
- `frontend/lib/reading/recognition-evidence.ts` — P1 fix (hasHighConfidenceKeytermResult)
- `frontend/components/reading/reading-screen.tsx` — P1 integration
