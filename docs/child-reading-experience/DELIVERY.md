# Delivery status

Working branch: `feature/linh-child-reading-experience-20261110`.
Inherited HEAD: `f3375dfa029bf9de5aa9eedc992bdeb576eea115`.
PR base: not selected. `CONTRIBUTING.md` specifies `develop`, but the read-only remote check found no `develop` ref; default remote branch is `main`. No base branch or integration policy was silently changed.
Local `main` and the locally recorded `origin/main` point to the inherited commit. A read-only remote check on 2026-11-11 found actual `origin/main` at `7c9d3334d10095b11822687dc347c0c616bd6715`, two commits ahead. Original local refs/index/HEAD were not changed. Remote history was inspected in a separate bare review repository, without checkout, merge or rebase.

Phase 8 delivery includes the complete inherited change set, incremental regression fixes, an API/database impact review, validation evidence, a real-audio limitations report and a reviewable PR draft. The user subsequently authorized committing and pushing this feature branch on 2026-11-11, explicitly without merging. This supersedes the earlier decision to keep the work uncommitted. No upstream merge or rebase is included in that authorization.

Subsequent manual testing identified a dark-background box defect. The [box geometry correction](BOX_GEOMETRY_FIX.md) fixes polarity handling and adds content-bound overlay eligibility; legacy geometry uses text fallback. No existing page/revision was rewritten. After restarting the corrected application, the user reported that the result was satisfactory and requested shutdown. Frontend/backend were stopped and ports 3000, 3106 and 8000 were verified free. This is user-reported acceptance of the visible box behavior, not a new quantitative audio or OCR evaluation.

| Delivery item               | Status                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Architecture/root causes    | [README](README.md)                                                                               |
| Source and regression tests | Included in the feature-branch publication; see Git history for the containing commit             |
| Files vs inherited HEAD     | 90 existing files modified, 46 files added, none removed; includes final acceptance documentation |
| Source verification         | Pre-publication audit compares source hashes with the completed geometry validation manifest      |
| Test and UI evidence        | [Validation report](VALIDATION.md) and local evidence bundle                                      |
| Real-audio report           | [Report](REAL_AUDIO_REPORT.md); metrics explicitly unmeasured                                     |
| New migration/dependency    | None                                                                                              |
| Commit SHA                  | Obtain from `git log -1 --format=%H -- docs/child-reading-experience/FINAL_ACCEPTANCE.md`         |
| Push / remote CI            | Push authorized; actual remote SHA is verified separately after push / CI status not inferred     |
| PR URL                      | Not created; [local PR draft](PR_DRAFT.md)                                                        |
| Merge                       | Not performed                                                                                     |

The earlier no-publication decision is retained as history only. The current user request is to complete delivery, commit and push, and **not merge**. Production acceptance remains limited as recorded in [the final acceptance report](FINAL_ACCEPTANCE.md). Publishing a feature branch does not resolve the catalog failure, real-world acceptance items or upstream compatibility risk.

Historical evidence directories `viread-phase7-8-completion-20261111-a1` and `viread-box-fix-20261111-a1` beside the repository contain incremental/full patches, source hash manifests, raw reports and screenshots. `viread-publication-20261111-a1` retains the final publication audit and Git receipt locally. Logs, sanitized build copies, generated screenshots and patches are not included in the source commit. The scale regression exception makes an existing, previously ignored test visible to Git; its contents were preserved. The completion run added eight PostgreSQL/API tests, five input/storage-boundary tests and four opt-in PostgreSQL browser scenarios, plus an XSS scenario and stronger zoom/dialog assertions. Earlier inherited tests remain in place.

## Upstream compatibility risk

The two new upstream commits introduce OCR geometry/text separation, punctuation reconciliation and per-engine metrics. Five files overlap the current uncommitted changes: `backend/app/schemas/book.py`, `backend/app/services/admin_ocr_service.py`, `backend/app/services/ocr_engine.py`, `frontend/components/admin/admin-ocr-review-screen.tsx` and `frontend/types/admin.ts`.

The overlap is verified, but no merge was attempted, so this is not a claim of computed merge conflicts. A fresh read-only remote check before publication still found `main` at `7c9d3334d10095b11822687dc347c0c616bd6715`, no `develop`, and no existing remote ref for this feature branch. The test results cover the feature source based on `f3375df`, not a combination with the newer remote main. Integration and regression checks against that main remain pending a separate decision; commit/push alone does not integrate it. Do not overwrite either side's OCR/revision changes when integrating. See `upstream-overlap.json` and `upstream-overlap.patch` in the historical completion evidence directory.

## Acceptance and deployment

Deploy backend/frontend contract changes together. Preserve existing comparison reports, retry events, image object references and historical revisions. No test database/schema or provider adapter belongs in the deployed application.

Software checks on a disposable PostgreSQL instance are recorded separately from fixture-only checks. The new integration tests refuse URLs other than the dedicated loopback database and create/remove their own random schemas. They do not use application credentials or perform application migrations.

Before production acceptance, retain the remaining limits in the validation/audio reports: live storage/provider behavior, the unavailable OCR-engine gate, hardware/browser/screen-reader checks and speech accuracy. Local load results are measurements of the documented lab setup, not a production throughput claim.
