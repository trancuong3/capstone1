# CI + OCR reliability audit (work in progress)

## Scope and source baseline
- Branch: `fix/ci-ocr-real-engine-gates-20261120` from `main` at `2791501f51feee11085c3d7d80dec92469e2f94d`.
- Observed baseline `Backend Tests` on 2026-11-19: **1,174 tests, 64 skipped**; all 64 were treated as success (GitHub run `44578189513`).
- `Frontend Checks` was green, but the production build used `continue-on-error: true`.
- Audit performed through GitHub repository and workflows, **not** the user's Windows checkout. No production Supabase/Render resources were altered.

## Remediation implemented
1. Keep lazy OCR imports in `app/services/ocr_engine.py` unchanged. Both real-engine suites now use the explicit `VIREAD_REAL_OCR_GATE=1` selection, rather than import-time `PaddleOCR is not None`. During mandatory execution, a missing OCR engine, weights, or Vietnamese Tesseract raises an error instead of `SkipTest`.
2. Add a **separate mandatory Real OCR model quality gate** on GitHub-hosted Ubuntu that initializes the engines and evaluates the existing synthetic Vietnamese pages. It enforces **14 executed, zero skipped** tests, including diacritics, OCR recognition metrics, box geometry, uncertainty and word-color invariants. Failure to load downloaded weights must fail the job.
3. Run Karaoke and Phase 7 PostgreSQL test modules in **independent disposable databases** exposed at their exact loopback ports 55447 and 55439. The `run_ci_tests.py` wrapper rejects unexpected skips. Both databases exist only inside the GitHub Actions job.
4. Change full frontend formatting/lint/typecheck/Vitest and production build into **required** GitHub Actions steps. Existing targeted tests stay intact.
5. Existing `Admin Book CRUD Verification` already runs full Playwright on every PR targeting `main`; keep this independent PR check.

## Acceptance boundaries and remaining risks
- The repo **does not provide independently verified photographs of real books**. Existing `test_g_real_book_photographs_are_not_available` remains in normal discovery. This new real-engine CI job explicitly **does not** claim Gate E real-photograph acceptance. Real book images, ground truth, privacy rights and an independent evaluation are still required.
- Real-engine integration may require model download, CPU memory and runtime. **No PASS can be claimed until CI has actually executed the tests**. A missing model or network resource correctly blocks the PR.
- The test-only PostgreSQL fixtures must never be pointed at production. The test suites themselves enforce exact loopback host, username and database.
- The separate opt-in Karaoke audio research smoke is not a standard CI quality gate. It remains a disclosed skip unless the necessary local media engines are installed and its independent acceptance criteria are met.
- Normal unit/API discovery still reports the 15 **intentionally deferred real-engine tests** and a local research smoke as skips; both real-engine classes must run independently in the mandatory OCR job.
- Branch protection cannot be enforced merely by YAML. In repository **Settings → Branches** (or Rulesets), require PRs and these successful checks: `Backend unit and API tests`, `Real OCR model quality gate`, `Frontend tests, typecheck, lint and build`, `Frontend format, lint, typecheck, tests, build and E2E`. Confirm exact installed status contexts before applying. Existing `main` was unprotected at audit time.
- Model provenance (Flow1 vs Original checkpoint SHA at runtime) and physical camera/microphone testing are distinct open workstreams.

## Verification
```powershell
# Standard backend tests (safe only with disposable PostgreSQL URLs)
cd backend
python scripts/run_ci_tests.py

# Mandatory real-engine gate: requires full OCR runtime and model files.
$env:VIREAD_REAL_OCR_GATE = '1'
python scripts/run_real_ocr_gate.py

cd ..\frontend
npm run verify
npm run build
npx playwright test --config=playwright.real-data.config.ts
```

## Evidence ledger
| Gate | Before | After | Status |
| --- | --- | --- | --- |
| Backend | 1174 tests; 64 skips | Disposables + fail-on-unexpected-skip audit | Awaiting PR CI |
| Real-engine OCR | 15 skipped under lazy-import guard | Strict 14-test synthetic gate | Awaiting PR CI |
| Frontend | Focused checks green | Required full verify and build | Awaiting PR CI |
| E2E | PR-only full E2E exists | Retained as separate required PR check | Awaiting PR CI |
| Branch protection | Unprotected main | Exact status checks documented | Manual settings change required |

**Not complete until live CI evidence is collected and all mandatory checks pass.**
