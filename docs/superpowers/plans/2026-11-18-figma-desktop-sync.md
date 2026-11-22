# ViRead Desktop Figma Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Map and align every desktop web frame on Figma page `2:6` with the ViRead web app, leaving no desktop screen or state unaccounted for.

**Architecture:** Keep the existing Next.js routes, React screens, Tailwind v4 tokens, service adapters, and interaction logic. Use the Figma frames as the visual source and update existing components only where direct comparison shows a gap. Track every frame ID against its route and UI state.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind CSS v4, Figma MCP.

**Spec:** Figma file `gfqkWdrUEBr63jpJUS27eP`, page `2:6`; use only frames named `Web · …` (85 frames, all 1440px wide). Mobile frames are out of scope.

## Global Constraints

- Inspect and implement desktop web frames only; do not inspect mobile layouts.
- Keep current authentication, authorization, selected-child ownership, API contracts, database behavior, OCR, and camera/microphone permission triggers intact.
- Reuse current design tokens and components; do not add dependencies.
- Do not access secrets or private credentials.
- Do not commit, push, merge, or deploy.

## Review Focus

- Every one of the 85 desktop frame IDs maps to an existing route, a reachable state, or an explicit Figma-only limitation.
- Error, empty, loading, modal, and success frames are reachable in the corresponding screen state.
- Layout widths, headings, spacing, typography, colors, and action hierarchy match the exact desktop frame.
- Reading and OCR status colors retain their existing meaning.
- Camera and microphone prompts remain user-triggered and appear at the intended stage.

---

### Task 1: Complete the desktop frame inventory

**Files:**

- Create: `docs/FIGMA_DESKTOP_COVERAGE.md`
- Read: `frontend/app/**/page.tsx`, `frontend/components/**`, and the Figma desktop frames on page `2:6`

- [x] Record all 85 frame IDs, names, route/component mappings, and state variants.
- [x] Mark frames without a corresponding route or reachable state as concrete implementation gaps; none were found in the static route/state audit.
- [x] Confirm the inventory count is exactly 85 and contains no Mobile frame.

### Task 2: Align account and parent screens

**Files:**

- Modify only relevant existing files under `frontend/components/auth`, `frontend/components/layout`, `frontend/components/dashboard`, `frontend/components/children`, `frontend/components/profile`, `frontend/components/settings`, `frontend/components/support`, `frontend/components/reading-management`, and `frontend/components/reports`.

- [x] Compare Figma text/state and source route mappings for all frames in this group; directly inspect screenshots for the rows marked accordingly in the coverage ledger.
- [x] Fix evidenced desktop layout, typography, spacing, copy, and state reachability gaps.
- [x] Preserve existing behavior and validation.

### Task 3: Align book, reading, and admin screens

**Files:**

- Modify only relevant existing files under `frontend/components/books`, `frontend/components/reading`, and `frontend/components/admin`.

- [x] Compare Figma text/state and source route mappings for all frames in this group; directly inspect screenshots for the rows marked accordingly in the coverage ledger.
- [x] Fix evidenced desktop layout, typography, spacing, copy, and OCR word/history state reachability gaps.
- [x] Preserve OCR data and save/verify behavior, route protection, and explicit device permission actions.

### Task 4: Desktop-only review and handoff

**Files:**

- Update: `docs/FIGMA_DESKTOP_COVERAGE.md`
- Update if needed: `frontend/FIGMA_ALIGNMENT_AUDIT.md)

- [x] Open and compare screenshots for all 85 desktop frames against their source routes and states; mark every frame as screenshot-reviewed in the coverage ledger.
- [ ] Capture and inspect the updated worktree app at 1440px. Runtime review remains deferred; the isolated worktree could not safely start a dev server in the nearly full C: volume, and authenticated/device states require real access.
- [x] Run formatting, lint, and TypeScript checks on changed code; do not run mobile checks or tests.
- [x] Confirm no backend files, secrets, or out-of-scope files changed.
- [x] Record all 85 screenshot reviews, changed frames, and runtime limitations in the coverage ledger.
