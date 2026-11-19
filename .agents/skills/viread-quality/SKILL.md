---
name: viread-quality
description: "Use only near completion for ViRead verification, focused tests, E2E checks, code review, and final quality gates."
---
# Quality gateway
Load only at completion or when testing is the task.
Prefer project `viread-quality-gate`; then `verification-before-completion`.
Testing: choose one relevant layer skill (pytest/vitest/e2e/playwright), not all.
Use full suites only for cross-cutting changes or when focused tests are insufficient.
