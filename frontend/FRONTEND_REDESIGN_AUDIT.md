# ViRead frontend redesign audit (historical)

> This report documents the earlier inferred redesign as it existed before the Figma file became available. Its claim that Figma could not be inspected, its token choices, and its 38-route coverage are not the current audit. See [FIGMA_ALIGNMENT_AUDIT.md](./FIGMA_ALIGNMENT_AUDIT.md) for the current Figma evidence, 46-route source inventory, and alignment work.

## Baseline and safety

- Repository: `capstone1`, branch `feature/ui-unslop-full-redesign-20261117`.
- Starting commit: `d74934e` (`fix(frontend): format Viread training screen`).
- Starting working tree: clean; no user changes were present to overwrite.
- Implementation scope: frontend presentation and responsive behavior. Authentication, authorization, Supabase services, API contracts, persistence, database, camera/microphone permission triggers, reading comparison semantics, OCR behavior, and domain logic remain protected.
- No commit, push, or merge is authorized.
- The referenced Figma file could not be opened in this environment (browser access was unavailable and the web viewer could not retrieve it). The redesign direction below uses the repository's real brand, assets, and existing product behavior; no Figma details are claimed as inspected.

## Route inventory and coverage

The source contains 38 page routes plus the `/auth/callback` route handler. The route count includes dynamic pages and admin pages:

| Area                    | Routes                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public and auth         | `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/admin/login`                                                                                                                                                                                                |
| Parent home and account | `/dashboard`, `/profile`, `/settings`, `/help-support`, `/device-permissions`                                                                                                                                                                                                    |
| Children                | `/children`, `/children/new`, `/children/:childId`                                                                                                                                                                                                                               |
| Books and reading       | `/books`, `/books/:bookId`, `/book-reports`, `/book-scanner`, `/reading-preparation`, `/reading/:sessionId`                                                                                                                                                                      |
| Sessions and reports    | `/sessions`, `/sessions/:sessionId`, `/sessions/:sessionId/report`, `/reports`, `/reports/difficult-words`, `/reading-management`                                                                                                                                                |
| Admin                   | `/admin`, `/admin/parents`, `/admin/parents/:parentId`, `/admin/books`, `/admin/books/new`, `/admin/books/:bookId`, `/admin/books/:bookId/edit`, `/admin/books/:bookId/pages/:pageId`, `/admin/audit-logs`, `/admin/health`, `/admin/metadata-quality`, `/admin/viread-training` |

All route entry files and shared layout/component directories were enumerated. The browser route matrix visited all 38 page routes at 390, 768, 1024, and 1440 CSS pixels. Every page returned HTTP 200, exposed a visible `h1`, settled its busy state, and passed the horizontal-overflow and browser-console/resource checks. The `/auth/callback` handler was inspected as a route handler rather than a page. The older README and acceptance report list only 24 routes and are stale.

## Existing UI findings

- The app has a recognizable brand mark, Nunito Variable, Lucide icons, real book illustrations, and a teal accent worth preserving.
- Shared controls were oversized for general desktop forms: the default button was 64px tall with 20px text; text and select controls could exceed 90px. Cards had large 24px radii and generous nested padding.
- Auth used a greeting headline, uppercase tracked eyebrow, duplicated sign-in/sign-up actions, a narrow centered card, and the same oversized control rhythm on mobile.
- Parent navigation was a dense horizontal row and account links were hidden in the avatar menu. Admin navigation also used a horizontal row, which became crowded on smaller screens.
- Multiple pages repeated all-caps tracked section labels; several success states used celebratory emoji, exclamation marks, or confetti/bounce/pulse effects.
- Reading layout mixed the page, many controls, and several competing status panels. Its word-state colors encode product meaning and must remain intact.
- Some book, metric, and chart cards used tinted shadows. A handful of one-off dimensions and gaps bypassed the 4px spacing rhythm.
- Existing empty/loading/error patterns are shared but need clearer, compact states. Data-dependent states must keep `null` distinct from numeric zero.
- The current scanner and reading preparation flows expose explicit permission actions. These triggers must remain user initiated, with no camera request on scanner entry and no microphone request before the parent action.

## Direction recorded before implementation

Product: ViRead helps Vietnamese families practice children's reading and understand progress using real books and word-level feedback.
Character: calm, patient, bookish.
World: a shared reading table, real Vietnamese book pages, warm paper, ink, and the existing teal brand mark.
Moments: readable page text, the current spoken word, honest progress, and clear recovery from device or service errors.
Signature: a restrained amber cursor for the current word, with the existing semantic success/error/uncertain colors preserved for recognized reading states.

Design system intent: keep Nunito Variable for Vietnamese readability and brand continuity; use warm neutral canvas and white surfaces, a focused teal accent, semantic state colors, a 4px spacing grid, smaller and consistent general-purpose controls, compact radii and neutral shadows. Keep book-page typography larger than dashboard typography. Use Lucide consistently and reserve motion for functional feedback.

## Implemented design system and interaction rules

- Palette: primary teal `#176c68` and hover `#105954`; ink `#263a38`; muted text `#596b67`; canvas `#f7f7f3`; paper `#f4f0e6`; pale teal `#e4efeb`; border `#d8dfda`; semantic success, warning, danger, and reading-highlight colors retained in tokens.
- Type: Nunito Variable remains the family; shared heading/body/label tokens are 30/16/14px with 1.4 copy line height. Book-page text remains larger than surrounding interface text.
- Spacing and shape: 4px grid with 8/12/16/24/32px steps; shared control/card radii are 12/16px. Default button height is 48px (`min-h-12`); text and select controls use a consistent compact rhythm.
- Shared patterns: quieter page headers, labeled form fields, neutral cards, status messages, compact skeletons, and clear empty states. Parent navigation scrolls horizontally on narrow screens; admin uses one responsive navigation and sign-out action.
- Reading and scanner: the active word uses a restrained amber outline; success/error/uncertain word-state colors remain semantic. Success feedback is calmer and non-celebratory; non-functional confetti and pulse/bounce effects were removed. Scanner entry and reading preparation remain permission-free until their explicit camera and microphone actions.
- Area coverage: auth screens; parent shell, dashboard, profile, children, books, scanner and reading-management; reading session, completion, history and reports; and admin shell, parents, catalog, OCR, quality, metadata, health, audit, and training screens.

## Preserved product behavior

- No backend, database, API service/schema, authorization, or Supabase integration files were changed.
- Existing selected-child context, route access, reading comparison and retry semantics, TTS/STT behavior, OCR revision/bounding-box handling, persistence, and explicit camera/microphone permission triggers remain intact.
- Browser coverage exercised selected-child and book flows, OCR editing/saving/verification, reading/TTS/retry/history, and confirmed no camera request on scanner entry and no microphone request until the parent presses the explicit action.
- Test fixtures were completed for the read-only pages in the route matrix. Existing presentation assertions were updated where the redesign intentionally changes visual defaults or copy; behavior assertions remain.

## Skill and source review

- Read the installed `unslop` skill and its five required references: Signs, Tokens, Visuals, References, and Effects.
- Read the project guidance and specified project docs, plus the Next.js 16.3.4 documentation requested by the master prompt.
- The referenced Figma could not be retrieved in this environment, so the implementation follows the recorded direction and the repository's real brand/assets without claiming Figma inspection.

## Validation results

| Check                          | Result                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Prettier format check          | PASS                                                                                                                               |
| ESLint                         | PASS; 12 pre-existing unused-variable warnings, 0 errors                                                                           |
| TypeScript                     | PASS                                                                                                                               |
| Vitest                         | PASS; 104 files and 1,738 tests                                                                                                    |
| Production build               | PASS with the webpack builder. The default Turbopack build failed to start a worker in this environment; the webpack retry passed. |
| Playwright                     | PASS; 97 passed, 13 skipped, 0 failed                                                                                              |
| Responsive visual and route QA | PASS at 390/768/1024/1440px; all 38 routes checked at each width                                                                   |

The 13 Playwright skips are the eight PostgreSQL integration cases (database not configured) and five duplicate mobile-project visual/matrix cases; the desktop browser context explicitly exercised the requested widths. Screenshots for ten representative screen states at all four widths are saved in the delivery folder.

## Implementation passes

Work in the requested sequence: foundation and shared controls; parent/admin/auth shells; parent and book/scanner pages; reading; reports/history; admin; then responsive, accessibility, loading/error/empty, and interaction polish. Validate the relevant component group after each batch. No design-only changes are permitted to alter route access, user context, service calls, or interaction meaning.
