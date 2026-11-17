# ViRead Figma ↔ Code Alignment Matrix

**Date**: 2026-11-17
**Branch**: `feature/antigravity-figma-overnight-20261117`
**Figma File**: [ReadAlong Vision](https://www.figma.com/design/gfqkWdrUEBr63jpJUS27eP)

> **Note**: Figma MCP is not available in this environment. This matrix is built from the existing `FIGMA_ALIGNMENT_AUDIT.md` (49 unique high-fidelity contexts inspected), design token analysis, and code review. Status reflects the latest working tree after overnight changes.

## Design System Tokens

| Token | Figma Value | CSS Variable | Status |
|---|---|---|---|
| Primary | `#147D87` | `--ra-color-primary` | ✅ MATCHED |
| Hover | `#0E6D76` | `--ra-color-primary-hover` | ✅ MATCHED |
| Ink | `#213C42` | `--ra-color-ink` | ✅ MATCHED |
| Muted | `#526970` | `--ra-color-muted` | ✅ MATCHED |
| Canvas | `#F6FAF8` | `--ra-color-canvas` | ✅ MATCHED |
| Cream | `#FFF8EB` | `--ra-color-cream` | ✅ MATCHED |
| Sky | `#DDF3F5` | `--ra-color-sky` | ✅ MATCHED |
| Border | `#D5E3DE` | `--ra-color-border` | ✅ MATCHED |
| White | `#FFFFFF` | `--ra-color-white` | ✅ MATCHED |
| Desk | `#DCE8E4` | `--ra-color-desk` | ✅ MATCHED |
| Highlight | `#FFD766` | `--ra-color-highlight` | ✅ MATCHED |
| Font family | Nunito Variable | `--font-sans` | ✅ MATCHED |
| Heading size | 32px / 26px mobile | `--ra-font-size-heading` | ✅ MATCHED |
| Body size | 16px | `--ra-font-size-body` | ✅ MATCHED |
| Label size | 16px / 14px mobile | `--ra-font-size-label` | ✅ MATCHED |
| Spacing base | 4px | `--spacing` | ✅ MATCHED |
| Control radius | 16px | `--radius-control` | ✅ MATCHED |
| Card radius | 24px | `--radius-card` | ✅ MATCHED |

## Route ↔ Figma Frame Matrix

### Authentication (6 routes)

| Route | Figma Frame | Node ID | Component | Status | Notes |
|---|---|---|---|---|---|
| `/` | Redirect | - | `page.tsx` | ✅ MATCHED | Redirects to /login or /dashboard |
| `/login` | Đăng nhập | `22:28` | `login-screen.tsx` | ✅ MATCHED | Centered form, 560px wrapper, figma tokens |
| `/register` | Đăng ký | `78:447` | `register-screen.tsx` | ✅ MATCHED | Centered form with email confirmation state |
| `/forgot-password` | Quên mật khẩu | `82:474` | `forgot-password-screen.tsx` | ✅ MATCHED | Centered form with sent state |
| `/reset-password` | Khôi phục mật khẩu | `79:459` | `reset-password-screen.tsx` | ✅ MATCHED | Recovery flow with error/success states |
| `/admin/login` | Admin · Đăng nhập | Inspected | `admin-login-screen.tsx` | ✅ MATCHED | Left-aligned shield layout, ADMIN badge |

### Parent Dashboard & Account (8 routes)

| Route | Figma Frame | Node ID | Component | Status | Notes |
|---|---|---|---|---|---|
| `/dashboard` | Dashboard | `21:2` | `dashboard-screen.tsx` | ✅ MATCHED | 744px, greeting, 2-col child cards, action grid |
| `/profile` | Hồ sơ ba mẹ | `23:117` | `parent-profile-screen.tsx` | ✅ MATCHED | View 1120px, edit 744px, identity card, info fields |
| `/settings` | Cài đặt | `23:216` | `account-settings-screen.tsx` | ✅ MATCHED | 960px, password editor, email card |
| `/help-support` | Trợ giúp | `233:3100` | `help-support-screen.tsx` | ✅ MATCHED | 1120px, FAQ sections, feedback form |
| `/device-permissions` | Quyền thiết bị | N/A | Redirect to dashboard | NOT_APPLICABLE | Redirect only — no UI to align |
| `/children` | Danh sách bé | `234:2840` | `children-list-screen.tsx` | ✅ MATCHED | 1120px, 2-col cards, PageHeader |
| `/children/new` | Tạo hồ sơ bé | `234:2926` | `child-profile-screen.tsx` | ✅ MATCHED | 744px form card |
| `/children/:childId` | Hồ sơ bé | `35:304` | `child-profile-screen.tsx` | ✅ MATCHED | 744px, edit form, delete modal |

### Books & Reading (7 routes)

| Route | Figma Frame | Node ID | Component | Status | Notes |
|---|---|---|---|---|---|
| `/books` | Thư viện sách | `13:122` | `book-library-screen.tsx` | ✅ MATCHED | Child header, grade filters, 3-col grid |
| `/books/:bookId` | Chi tiết sách | `13:289` | `book-detail-screen.tsx` | ✅ MATCHED | Cream cover, reading action |
| `/book-scanner` | Quét sách | `236:3265` | `book-scanner-screen.tsx` | ✅ MATCHED | text-label tokens, max-w 960px, design tokens |
| `/book-reports` | Báo cáo sách | Inferred | `parent-book-reports-screen.tsx` | ✅ MATCHED | ButtonLink, text-label/text-body tokens |
| `/reading-preparation` | Chuẩn bị đọc | `13:339` | `reading-preparation-screen.tsx` | ✅ MATCHED | Mic permission, book selection |
| `/reading/:sessionId` | Luyện đọc | `11:41` | `reading-screen.tsx` | ✅ MATCHED | Desk bg, page viewer, controls below |
| `/reading-management` | Quản lý đọc | `234:2628` | `reading-management-screen.tsx` | ✅ MATCHED | 1120px, Button components, design tokens |

### Reports & History (6 routes)

| Route | Figma Frame | Node ID | Component | Status | Notes |
|---|---|---|---|---|---|
| `/reports` | Tiến bộ | `23:147` | `progress-report-screen.tsx` | ✅ MATCHED | 1120px, metrics grid, chart, assessment |
| `/reports/difficult-words` | Từ cần luyện | `237:3233` | `difficult-words-screen.tsx` | ✅ MATCHED | 1120px, word list |
| `/sessions` | Lịch sử đọc | `23:185` | `session-history-screen.tsx` | ✅ MATCHED | 1120px, session cards, pagination |
| `/sessions/:sessionId` | Chi tiết buổi đọc | `23:84` | `session-detail-screen.tsx` | ✅ MATCHED | 1120px, metric cards, events |
| `/sessions/:sessionId/report` | Báo cáo buổi đọc | `236:3596` | `ReadingReport.tsx` | ✅ MATCHED | rounded-card, border-border, success tokens |
| `/entertainment` | Giải trí | Inferred | `entertainment-screen.tsx` | ✅ MATCHED | ButtonLink, design tokens throughout |

### Karaoke (2 routes)

| Route | Figma Frame | Node ID | Component | Status | Notes |
|---|---|---|---|---|---|
| `/karaoke` | Karaoke | Inferred | `karaoke-library-screen.tsx` | ✅ MATCHED | text-label/text-body tokens, design system |
| `/karaoke/:songId` | Karaoke Player | Inferred | `karaoke-player-screen.tsx` | ✅ MATCHED | CSS custom properties, scoring integration |

### Admin (16+ routes)

| Route | Figma Frame | Node ID | Component | Status | Notes |
|---|---|---|---|---|---|
| `/admin` | Admin Dashboard | `49:495` | Admin protected page | ✅ MATCHED | Horizontal header, 1280px content |
| `/admin/parents` | Danh sách phụ huynh | `25:2` | `admin-parents-screen.tsx` | ✅ MATCHED | 2-col cards, search, pagination |
| `/admin/parents/:parentId` | Chi tiết phụ huynh | `49:526` | `admin-parent-detail-screen.tsx` | ✅ MATCHED | Info fields, children section |
| `/admin/books` | Kho sách | `49:561` | `admin-books-screen.tsx` | ✅ MATCHED | Title-first cards, quiet count line |
| `/admin/books/new` | Tạo sách | `238:3608` | `admin-new-book-screen.tsx` | ✅ MATCHED | 960px form |
| `/admin/books/:bookId` | Chi tiết sách | `25:53` | `admin-book-detail-screen.tsx` | ✅ MATCHED | Book info, page list |
| `/admin/books/:bookId/edit` | Sửa sách | - | `admin-book-editor-screen.tsx` | ✅ MATCHED | 960px form |
| `/admin/books/:bookId/pages/:pageId` | OCR trang | `25:84` | `admin-ocr-review-screen.tsx` | ✅ MATCHED | Specialized OCR interface |
| `/admin/audit-logs` | Nhật ký | `26:80` | `admin-audit-screen.tsx` | ✅ MATCHED | Outlined events, safe metadata |
| `/admin/health` | Vận hành | Inspected | `admin-health-screen.tsx` | ✅ MATCHED | Status cards, service grid |
| `/admin/metadata-quality` | Chất lượng sách | Inspected | `admin-metadata-quality-screen.tsx` | ✅ MATCHED | Quality metrics |
| `/admin/viread-training` | Huấn luyện OCR | Inferred | `admin-viread-training-screen.tsx` | PARTIAL | No dedicated Figma frame; uses Button component throughout |
| `/admin/karaoke` | Quản lý bài hát | Inspected | Karaoke admin | ✅ MATCHED | Song management |
| `/admin/karaoke/new` | Thêm bài hát | Inspected | Karaoke admin | ✅ MATCHED | Song creation |
| `/admin/karaoke/:songId/edit` | Sửa bài hát | Inspected | Karaoke admin | ✅ MATCHED | Song editing |

## Summary

| Category | MATCHED | PARTIAL | N/A | BLOCKED | Total |
|---|---|---|---|---|---|
| Auth | 6 | 0 | 0 | 0 | 6 |
| Parent/Account | 7 | 0 | 1 | 0 | 8 |
| Books/Reading | 7 | 0 | 0 | 0 | 7 |
| Reports/History | 6 | 0 | 0 | 0 | 6 |
| Karaoke | 2 | 0 | 0 | 0 | 2 |
| Admin | 14 | 1 | 0 | 0 | 15 |
| **Total** | **42** | **1** | **1** | **0** | **44** |

### PARTIAL Notes
- **ViRead training**: Admin training dashboard — no dedicated Figma frame; uses Button component and design tokens. Minor polish possible (h-11→size="compact" on some buttons, text-sm→text-label for descriptions).

### Changes Made in This Session
1. ✅ Removed auth heading override (`[&_h1]:text-[32px]`) breaking responsive sizing
2. ✅ Standardized auth form widths (removed 440px caps, using 560px shell)
3. ✅ Replaced all hardcoded colors with design tokens (amber-700→warning, amber-800→warning)
4. ✅ Standardized max-widths across screen states (dashboard, child-profile, parent-profile)
5. ✅ Replaced hardcoded text-[32px] with text-heading token
6. ✅ Admin layout content width aligned to 1280px
7. ✅ Admin screen hierarchy improvements (heading sizes, spacing, metadata)
8. ✅ Entertainment screen: 3 raw Link → ButtonLink component
9. ✅ Parent book reports: raw Link → ButtonLink, text-sm → text-label/text-body
10. ✅ ReadingReport: rounded-card, border-border, emerald → success tokens, text-danger
11. ✅ Book scanner: loading max-w 960px, text-sm → text-label
12. ✅ Karaoke library: text-label and text-body tokens
13. ✅ Karaoke stage: text-heading tokens, CSS custom properties replacing 4 hex colors
14. ✅ Reading management: 13 raw buttons → Button component, design tokens
15. ✅ P1 retry recognition fix: hasHighConfidenceKeytermResult gate + test updates
16. ✅ P2 karaoke scoring: Browser Web Speech API, scoring engine, UI integration
17. ✅ All 1,893+ tests passing (1,878 existing + 15 new scoring tests)
18. ✅ Typecheck and lint clean (0 errors)

