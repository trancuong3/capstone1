# ViRead Figma alignment audit

Date: 2026-11-17

> The sections below record successive passes. Their older validation counts are historical, not the status of the latest working tree. The fresh Figma inspection and validation in the final section supersede earlier access, layout, and test claims.

## Safe starting point

- Repository: `F:\c1\capstone1` (`trancuong3/capstone1`).
- Latest fetched `origin/main` was already current at `8e7c9e93` (`Merge pull request #122 ...`).
- Work is isolated on `feature/figma-alignment-20261117`, created from that commit.
- The only pre-existing untracked path is `supabase/.temp/`; it is preserved and excluded from this UI work.
- No backend, database, service contract, API route, or environment-secret changes are in scope.

## Figma material reviewed

File: [ReadAlong Vision · Bạn nhỏ cùng đọc](https://www.figma.com/design/gfqkWdrUEBr63jpJUS27eP/ReadAlong-Vision-%C2%B7-B%E1%BA%A1n-nh%E1%BB%8F-c%C3%B9ng-%C4%91%E1%BB%8Dc?node-id=2-6).

The browser session can view and comment on the file but cannot edit it. Its pages include the Web & Mobile screens, design system, component library, implementation guide, and named component/illustration sheets. The parent-management frames are part of the Web & Mobile page.

Verified from the Figma inspector and visible frames:

- `Web · Danh sách phụ huynh` is a 1440px-wide frame with a 1000px minimum height. Its canvas token is `#F6FAF8`.
- The parent-detail design uses a centered 1280px content region inside the desktop frame, a named parent heading, the actions “Sửa hồ sơ” and “Danh sách phụ huynh”, a “Thông tin Parent” group, and centered child-profile cards with initial avatars.
- The shared Admin header is a horizontal desktop navigation with the ViRead mark, Admin badge, section links, and sign-out action. The Admin footer is a shared component.
- The board includes mobile references for account, parent/report, reading session, book library, and book/page selection. The app is intended to reflow one shared route implementation.

The repository’s Figma design-system notes and exported Figma SVG assets provide the remaining base tokens: Nunito Variable; primary `#147D87` / hover `#0E6D76`; ink `#213C42`; muted `#526970`; cream `#FFF8EB`; sky `#DDF3F5`; border `#D5E3DE`; 4px spacing steps; 16px controls; 24px cards. Reading-state colors stay semantic.

## Findings against the starting implementation

- The prior redesign audit said Figma was unavailable and selected an inferred warm-paper palette (`#176C68`, `#F7F7F3`, `#F4F0E6`) with smaller typography and tighter card radii. That direction does not match the actual Figma tokens.
- The Admin shell used a left vertical sidebar at desktop widths; Figma shows a horizontal top header.
- The parent-detail screen used different action names and labels, displayed children as left-aligned generic icon rows, and omitted the centered initial avatars visible in Figma.
- The existing reading, scanner, and permission flows are domain-sensitive. Keep their service calls, selected-child checks, camera/microphone trigger points, word-state meanings, OCR behavior, and route protection intact while changing presentation.
- The current source has 46 `page.tsx` routes plus `/auth/callback`. This exceeds the 38-route inventory in the older redesign audit, so that old runtime coverage claim must not be reused for this branch without rerunning checks.

## Direction

Product: help Vietnamese families build a steady, enjoyable reading habit together.

Character: warm, patient, capable, and reassuring for both adults and children.

World: a bright mint reading space with tactile paper, real book art, Nunito typography, and ViRead’s teal mark.

Moments: choosing a child and book, giving explicit device permission, reading one word at a time, and understanding progress without overstating evidence.

Signature: pale aqua navigation and controls with a clear teal active state; an amber outline marks only the current reading word while success/error states retain their existing meanings.

## Route inventory at the starting point

- Public/auth: `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/admin/login`.
- Parent/account: `/dashboard`, `/profile`, `/settings`, `/help-support`, `/device-permissions`, `/children`, `/children/new`, `/children/:childId`, `/entertainment`, `/entertainment/picture-description`, `/entertainment/sentence-shooter`, `/karaoke`, `/karaoke/:songId`.
- Books: `/books`, `/books/:bookId`, `/book-scanner`, `/book-reports`.
- Reading: `/reading-preparation`, `/reading/:sessionId`.
- History/reports: `/sessions`, `/sessions/:sessionId`, `/sessions/:sessionId/report`, `/reports`, `/reports/difficult-words`, `/reading-management`.
- Admin: `/admin`, `/admin/parents`, `/admin/parents/:parentId`, `/admin/books`, `/admin/books/new`, `/admin/books/:bookId`, `/admin/books/:bookId/edit`, `/admin/books/:bookId/pages/:pageId`, `/admin/audit-logs`, `/admin/health`, `/admin/metadata-quality`, `/admin/viread-training`, `/admin/karaoke`, `/admin/karaoke/new`, `/admin/karaoke/:songId/edit`.
- Route handler: `/auth/callback`.

The route list is source-level inventory only. Runtime and responsive coverage will be reported only after the corresponding checks run on this branch.

## Implemented Figma alignment

- Replaced the earlier inferred palette with the verified Figma colors and typography, including Nunito Variable, teal actions, mint navigation, cream surfaces, and the specified border and card treatments.
- Reworked the desktop Admin shell into Figma's horizontal header and centered content layout. Tablet and mobile layouts retain the same destinations with an accessible, horizontally scrollable navigation row.
- Brought the Admin parent detail view closer to the reference with the Figma action labels, Parent information group, centered child cards, and initials avatars.
- Applied the shared visual language to parent navigation, dashboard, book filters, scanner empty state, report cards, form controls, buttons, and page headings. Used the existing Figma owl art on the dashboard.
- Kept authentication and authorization, selected-child context, API calls, book/OCR behavior, reading state and speech logic, and explicit camera/microphone permission triggers intact. No backend, database, or API contract changes were made.

## Verification on `feature/figma-alignment-20261117`

- PASS — `npm run format:check`.
- PASS — `npm run lint`: zero errors; 13 warnings remain in existing files outside this redesign.
- PASS — `npm run typecheck`.
- PASS — `npm run build` with Next.js 16.3.4; 38 static pages generated.
- PASS — unit tests: 113 files, 1,869 tests.
- PASS — full Playwright E2E: 127 passed, 13 skipped, 0 failed. Eight PostgreSQL-backed cases were skipped because the test environment lacks the required PostgreSQL configuration. Five mobile-project cases are intentionally skipped by the Playwright project/viewport matrix; the desktop route matrix covers the requested widths.
- PASS — all 46 page routes traversed at 390, 768, 1024, and 1440px in the desktop responsive route matrix, with no route-matrix assertion failures.
- PASS — focused visual/interaction checks at the requested widths, including explicit camera and microphone permission trigger behavior. Desktop and mobile screenshots for the redesigned dashboard, library/scanner/preparation, Admin shell, and parent detail were reviewed.
- PASS — `git diff --check` (final whitespace check).

The E2E server used a separate `.next-e2e` build directory so it would not take over the existing development server's `.next` directory. The existing untracked `supabase/.temp/` directory was preserved. No commit, push, or merge was performed.

## Follow-up from user screenshot review

The first pass changed shared tokens, shell, parent detail, dashboard and selected parent-facing components, but left several data-heavy Admin and reading-management page bodies visually close to their starting point. The user's screenshots correctly identified that gap; the earlier completion summary overstated the extent of the redesign.

Follow-up refinements now extend the same Figma system into:

- Admin book catalog: live summary cards, clearer book identity hierarchy, and separated per-book page/OCR counts.
- Admin audit log: localized section heading, grouped filter panel, event hierarchy, timestamp chip, and readable safe-metadata groups.
- Reading management: wider Figma-aligned content region, stronger page-title hierarchy, more visible child context, and more distinct summary/section cards.

Follow-up verification: PASS — TypeScript typecheck, ESLint (0 errors, the same 13 existing warnings), and `git diff --check`. The original full E2E run predates these follow-up presentation-only changes; it has not been rerun for them.

## System-wide Figma pass

The user clarified that the requested scope is the full system, with Parent screens as a priority. The original Figma file remains the visual source of truth. Exact frame-specific structure is applied where a corresponding frame exists; other routes use its verified tokens and shared components rather than inventing additional Figma screens.

- Parent shell and page content now align to a 1280px desktop content region, with responsive navigation and reflow.
- Parent dashboard, child cards, book library/detail, scanner, reading preparation, progress/report/history, and reading-management screens share the Figma typography, colors, spacing, controls, and card language.
- Auth screens use the supplied Figma reading illustration and owl artwork in a responsive two-column composition.
- Admin shell, parent list/detail, book catalog, audit events, health, OCR and other Admin pages inherit the horizontal shell and common Figma controls/cards; the books and audit content views now have clearer data hierarchy.
- Legacy `border-line` / `bg-surface` utilities that were outside the Figma token set were replaced with `border-border` / `bg-canvas`. Reading, device permission triggers, selected-child checks, APIs and business behavior remain unchanged.

Latest verification after this pass:

- PASS — `npm run verify`: format, lint (0 errors; 13 existing warnings), typecheck, and unit suite (113 files / 1,869 tests).
- PASS — production build using isolated `NEXT_DIST_DIR=.next-figma-build`; Next.js 16.3.4 generated all 38 static pages and listed the full app route set.
- PASS — Playwright responsive route matrix: all 46 page routes at 390, 768, 1024, and 1440px; 0 failures. Focused book/scanner/preparation visual QA also passed at all requested sizes.
- PASS — screenshots reviewed for auth at 1440px and Admin parent detail at 1440px and 390px.
- PASS — `git diff --check`.

The earlier 127-pass / 13-skip full E2E result is retained as the last full behavioral suite run; it predates this presentation-only pass. The current responsive matrix rerun is clean. No commit, push, or merge was performed.

## Fresh Figma inspection and dialog correction — 2026-11-17

Figma access initially failed in this continuation. After the user's Editor-access response, the file session succeeded (`c2b79947-8af6-4c7b-9367-b19965561ca7`). The page inventory was read from `2:6`, and high-fidelity design context with screenshots was retrieved for these 33 frames:

| Group                   | Inspected node IDs                                                          |
| ----------------------- | --------------------------------------------------------------------------- |
| Auth                    | `22:28`, `78:447`, `82:474`, `79:459`                                       |
| Parent                  | `21:2`, `23:117`, `23:216`, `233:3100`, `234:2840`, `234:2926`, `35:304`    |
| Reading management      | `234:2628`, `318:7716`, `318:7856`, `318:7996`, `275:4418`                  |
| Books, scanner, reading | `13:122`, `13:289`, `236:3265`, `13:339`, `11:41`                           |
| Reports                 | `23:147`, `237:3233`, `23:185`, `23:84`                                     |
| Admin                   | `49:495`, `25:2`, `49:526`, `49:561`, `238:3608`, `25:53`, `25:84`, `26:80` |

The source frame inspection corrected earlier assumptions: most Parent content is 1120px wide, Dashboard content is 744px, account forms are 560px, scanner/preparation are 960px, and the library content is 1130px. Admin content remains 1280px. Figma's ordinary body text is 16px. The earlier two-column illustrated Auth composition was not present in the inspected Auth frames and has been removed.

### Latest changes

- Auth now uses the centered account card, public account links and footer, and fields with labels inside the outlined control.
- Dashboard follows the narrower composition, API-supplied parent greeting, two-column child cards, and the exact 96×96 book asset downloaded from the Dashboard design context. Card avatars are 88px; the selected label sits with the card content.
- An unnecessary same-URL Dashboard replacement after child selection was removed; query cleanup is retained when needed. Selected-child validation and ownership checks are retained.
- Reading management now groups plans/goals and saved books/reminders in two columns, with compact numeric summaries and explicit actions that open the existing forms. All original fields and mutation handlers are retained. Form presentation is adapted to accessible dialogs rather than adding new backend routes.
- The user's screenshot exposed inherited four-column spans inside the new two-column reminder dialog. Those spans were corrected, fields now have `min-width: 0` and full available width, and weekday/email groups span the full row. Plan, goal and reminder dialogs have responsive QA covering 390/768/1024/1440px, Escape, and focus return.
- Karaoke is reachable from Entertainment. Dashboard's Hát vui action opens Entertainment and retains its selected-child gate; the Entertainment nav remains active throughout `/karaoke`.
- Book routes now use the child header without a duplicate Parent navigation/footer; catalog search is full-width and the desktop catalog has three columns. Parent profile, children, scanner/preparation, support and report content widths now follow the inspected frames.
- Admin Parent cards use two columns at desktop widths. Existing actions and account data are retained, including deactivation rather than changing its business meaning to a destructive delete.

### Scope and verification limits

The 46-page route inventory is distinct from inspecting every Figma state. Only the 33 frame contexts above were freshly retrieved. Runtime route traversal also distinguishes access gates from the authenticated content behind them: full page reloads intentionally clear selected-child context. The dedicated book/scanner/preparation and karaoke flows exercise those selected-child screens through navigation. No pixel-difference score or exhaustive state-by-state Figma equivalence is claimed.

The original 1,218-line attachment is not present in this local workspace, and the referenced ChatGPT conversation was not readable through the Codex-thread reader. The available task instructions, project docs, Figma file, existing audit and repository are the reviewable sources for this continuation.

Latest validation is being recorded after the current run. The earlier full E2E run ended with 122 passed, 5 failed and 13 skipped; two assertions expected old copy, two route matrices exhausted their six-minute total budget, and one mobile Dashboard navigation did not finish in its assertion window. The copy and Dashboard replacement were corrected, route warmup was extended, and the responsive matrix now loads each route once before checking all four viewport sizes. These earlier failures must not be described as a clean current full run.

The subsequent full E2E run completed in 21.1 minutes with 124 passed, 11 skipped and one failure. That failure was a visual-flow assertion still expecting the old Dashboard title; the displayed API-derived greeting was correct. The mobile Dashboard navigation and prior missing-child assertion both passed. The route matrix passed all 46 paths at all four requested sizes, and the three management dialogs passed width/focus checks. The old-title assertion has been updated and is included in the final focused UI rerun.

Final typography QA also found a global `font: inherit` shorthand overriding utility font weights on controls. It now inherits only the font family so the specified control weight/size applies. Public account navigation now uses full-width mobile columns and non-wrapping desktop labels; the Dashboard's desktop book illustration is hidden at mobile widths to follow its mobile frame.

Format check, lint (0 errors, 13 existing warnings), and typecheck passed after these refinements. The isolated full unit run with two workers passed all 114 files. An earlier run concurrent with browser compilation had three asynchronous query timeouts; those results are superseded by the isolated full run, not silently counted as PASS.

### Final results for the latest working tree

- PASS — final focused Playwright run: 5/5, including the corrected book/scanner/preparation flow, management dialogs, 200% reading zoom, image-overlay geometry, and the 46-path matrix at 1440/1024/768/390px. The matrix completed in 4.0 minutes; the full focused command took 7.5 minutes including route warmup.
- PASS — production webpack build with isolated `.next-figma-build`, Next.js 16.3.4, 38 generated static pages, complete app route output, exit code 0.
- PASS — `git diff --check` and final branch verification. No tracked backend or Supabase changes. `HEAD`, `main`, and `origin/main` remain at `8e7c9e9346e8b927d49d812c966b0def80365f37`.
- FAIL (historical full run, explicitly retained) — 124 passed / 1 failed / 11 skipped. The sole failed assertion was corrected and passed in the final focused run; no new clean full-suite result is claimed after the typography refinements.
- NOT RUN — eight PostgreSQL-backed integration cases and physical camera/microphone or live paid AI service verification. Three duplicate mobile-project viewport cases are intentionally skipped.
- NOT RUN — exhaustive pixel comparison of every Figma frame/state. Only the 33 listed contexts were freshly retrieved.

The final QA output contains 99 PNGs. Representative final screenshots reviewed include Auth mobile, reading-management desktop, reminder dialogs desktop/mobile, Entertainment desktop/mobile, and Admin parent detail/karaoke from the earlier pass. The user-facing delivery folder contains the detailed report, current representative images, and the final QA archive. No commit, push or merge was performed.

## Corrective screen-by-screen pass after the latest Figma review

This section supersedes earlier statements that a shared palette or management dialogs completed the Figma implementation. The user correctly identified remaining structural differences. The latest pass reads the actual frame screenshots and adjusts composition, rather than treating route traversal as visual equivalence.

Additional high-fidelity contexts inspected in this continuation: `233:3186`, `318:8134`, `318:8268`, `108:156`, `233:3036`, `238:3680`, `26:150`, `27:291`, `275:4976`, `275:4095`, `275:4792`, `245:4784`, `245:4874`, `30:1146`, `30:1208`. Together with the 33 previously listed unique frames, this is 48 unique contexts. The full page metadata was read again to locate these frames. Screens without a corresponding frame, including Entertainment, Karaoke, and training dashboards, use the verified design foundations; they are not claimed to have a dedicated matching Figma frame.

Corrections implemented:

- Parent profile view follows the identity card, outlined information fields and linked-child cards. Editing has a separate 744px view with the existing unified profile save/cancel behavior. Mobile identity stacks vertically.
- Settings, password editing, Help/FAQ and feedback follow their individual frames. Password and feedback are separate editor views. Validation, recovery and submission services are retained.
- Reading-management plan/goal/reminder actions now open full-page editor views as shown in Figma. The earlier dialog adaptation is superseded. The weekday/timezone/email fields reflow, and saved books use the designed table. Existing insights and all mutation actions remain accessible.
- Auth uses centered forms. The Admin login was corrected to the left-aligned shield/card composition. Auth error/recovery behavior is retained.
- Book covers use cream illustration areas, artwork above title, and a separate book title below. Library grade filters wrap into two rows on mobile. Book detail keeps the cover card on mobile and places the reading action before range controls. The duplicate selected-child panel is replaced by the header's existing context and Dashboard selection destination.
- Reading controls are below the page viewer. The desk surface uses the actual Figma fill. OCR word geometry, highlights and reading callbacks are retained.
- History and difficult-word cards use the vertical composition. Report information fields, metrics and chart alignment follow the source. Additional assessment data and actions remain available.
- Admin inventory uses title-first cards, direct filters, a quiet count line and aligned actions. Audit events use outlined actor/request fields and a safe metadata section. Book creation/editing uses the 960px form layout. Page cards, health and metadata quality share the inspected hierarchy. Admin account dialogs keep the modal presentation shown in their actual frames, with white panels and stacked actions.
- Header spacing, mobile navigation and the compact footer are aligned across shared shells. Entertainment removes decorative glows/gradients and keeps all three activity destinations, including Karaoke.

Safety and validation notes:

- The working branch remains `feature/figma-alignment-20261117`. No reset, commit, push or merge was used. Existing local edits and `supabase/.temp/` were preserved.
- The current work has no tracked backend/database changes. API request shapes, permission triggers and authorization checks remain in place.
- The first unit run in this pass had 3 failures from old presentation queries (audit resource row, separate OCR stat elements, child heading). Their functional assertions were retained and updated for the rendered structure; the focused 45-test rerun passed.
- The first browser rerun exposed old Escape/dialog expectations and an ambiguous alert query including Next's route announcer. These tests now exercise Back/Cancel in the separate editor views and scope the application alert. A route traversal timed out during a development refresh; this result is retained as a failed attempt, not a passing visual audit.
- Final command results and screenshots are recorded in the delivery report after verification. Prior pass counts above are historical, not current claims.

## User-requested publish checkpoint

The user explicitly stopped the UI work and requested committing all local source changes, pushing the feature branch and merging into main. Further redesign and verification were stopped at that point.

- Latest completed format, lint and typecheck commands passed; lint retains 13 existing unused-variable warnings.
- Latest completed full unit run: 112 files passed, 2 failed; 1,868 tests passed and 2 failed. One failure was an old child-label assertion (updated afterward); the other reached the five-second test budget. A follow-up full run was interrupted at the user's request and is NOT a completed PASS.
- Latest completed browser run: 8 passed, 1 failed. All 46 routes completed heading/layout checks at 1440/1024/768/390px. The matrix failed its final console check on a React pre-mount state-update warning at Admin parent detail. Its warning has not been declared fixed. A subsequent split into Parent/Admin test contexts and the latest book/mobile refinements have NOT been rerun.
- The current password fixture now includes an email provider so the next browser run will exercise the actual password fields, in addition to the earlier recovery-only screenshot.
- Build and live PostgreSQL/device/AI integrations: NOT RUN after the final refinements. Earlier successful builds are historical.
- One additional comparison-report design context (`236:3596`) was inspected after the list above: 49 unique high-fidelity contexts in total. This does not establish exhaustive pixel equivalence for all Figma states.
