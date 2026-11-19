---
name: viread-figma-parity
description: >-
  Use this skill when implementing, auditing, or refining ViRead UI screens against the Figma design ("ReadAlong Vision · Bạn nhỏ cùng đọc"), checking design tokens, reusing SVG/component assets, or verifying responsive layouts.
---

# ViRead Figma Parity & UI Guidelines

Ensure visual fidelity with the official Figma file (`ReadAlong Vision · Bạn nhỏ cùng đọc`) without breaking domain behavior. Read [frontend/FIGMA_ALIGNMENT_AUDIT.md](../../../frontend/FIGMA_ALIGNMENT_AUDIT.md) for historical frame audits and route coverage before redesigning screens.

## 1. Verified ViRead Design Tokens

Always use the established ViRead token set (never fall back to generic Tailwind slate/indigo defaults or older `#176C68` warm-paper tokens):

- **Typography**: `Nunito Variable` (`@fontsource-variable/nunito`) with full Vietnamese glyph & diacritic legibility.
- **Colors**:
  - Canvas background: `#F6FAF8` (`bg-canvas`)
  - Primary action teal: `#147D87` / hover `#0E6D76`
  - Primary ink: `#213C42` | Muted text: `#526970`
  - Warm cream surface: `#FFF8EB` | Pale sky/aqua accent: `#DDF3F5`
  - Border token: `#D5E3DE` (`border-border`)
- **Geometry & Rhythm**:
  - Spacing steps: `4px` grid
  - Interactive controls / inputs / buttons: `16px` border radius
  - Content & summary cards: `24px` border radius
  - Desktop frame reference: `1440px` viewport with centered `1280px` content container
  - Admin desktop navigation: Horizontal top header (with scrollable nav fallback on tablet/mobile), shared Admin footer.

## 2. Component & Asset Reuse Rules

1. **Inspect existing primitives first**: Reuse `frontend/components/common/*` (`button.tsx`, `status-message.tsx`, `skeleton.tsx`, dialogs, cards, form inputs) and exported Figma SVG artwork (e.g., ViRead teal mark, owl & reading illustrations in `frontend/public/`).
2. **Preserve semantic reading colors**:
   - Current target word: Amber outline highlight only.
   - Verified reading/comparison states (`MATCH`/correct green, `SUBSTITUTE` orange, `DELETE` red, `INSERT` purple) must remain semantically consistent across `book-page-content.tsx` and `ReadingReport.tsx`.
3. **Never break domain-sensitive hooks while restyling**:
   - Keep `selectedChild` context checks, explicit user-gesture camera/microphone permission triggers, `useSpeechRecorder`, `BrowserTranscriptCollector`, and route guards untouched.

## 3. Parity & Responsive Verification Workflow

1. Check Next.js 16 conventions in [frontend/AGENTS.md](../../../frontend/AGENTS.md) before modifying App Router pages/layouts.
2. Verify responsive reflow across all 4 required ViRead widths: **`390px` (mobile), `768px` (tablet), `1024px` (laptop), and `1440px` (desktop)** — no horizontal overflow, clipped Vietnamese diacritics, or inaccessible nav actions.
3. Isolate build output if a dev server is running (`NEXT_DIST_DIR=.next-figma-build`) and run `npm --prefix frontend run typecheck` + `npm --prefix frontend run lint` + targeted Vitest/Playwright checks.
