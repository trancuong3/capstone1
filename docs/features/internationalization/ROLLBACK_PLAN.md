# ViRead Global Internationalization — Rollback Plan

ViRead's internationalization feature is purely additive on application/UI layers:

- **Zero Supabase schema migrations** were added (`0` ALTER TABLE / RLS changes).
- **Zero external paid API keys or runtime cloud services** are required.
- **Zero changes** were made to OCR engines, STT/TTS models, Flow 1/Flow 2 training datasets, or book content data.

Because of these invariants, rollback can be executed cleanly at three granularities with zero data loss and zero database downtime.

---

## Level 1: Unpublish a Single Problematic Locale (Fastest, Safe Hotfix)

If a newly published locale causes layout clipping, translation errors, or RTL rendering issues in production:

1. Open `frontend/lib/i18n/locales.ts`.
2. Locate the locale entry in `LOCALE_REGISTRY` and set:
   ```ts
   status: "needs_review",
   published: false,
   ```
3. Deploy frontend (or push PR commit).

**Effect:**

- The locale immediately disappears from the default `<LanguageSelector publishedOnly />`.
- Existing users who previously stored that locale in `viread_locale` cookie automatically fall back to `DEFAULT_LOCALE = "vi"` inside both `resolveServerLocaleFromCookieValue()` (SSR) and `I18nProvider` (Client), with zero errors and zero session loss.
- Backend `resolve_supported_locale("vi")` remains untouched.

---

## Level 2: Force Global Vietnamese-Only Mode (Preserve Core Engine)

If urgent triage requires reverting all users to Vietnamese UI without tearing down the i18n code structure:

1. In `frontend/lib/i18n/locales.ts`, set `published: false` on every entry except `"vi"`.
2. Verify `npm --prefix frontend run verify` and `npm --prefix frontend run build`.

**Effect:** All SSR and client views serve `"vi"` deterministically, ignoring non-`"vi"` cookies safely while keeping API headers and test harnesses intact.

---

## Level 3: Full Feature Revert (Git Merge Revert)

To remove the entire i18n change set after merge to `main`:

1. Identify the merge commit SHA on `main`:
   ```powershell
   git log --oneline -n 10
   ```
2. Revert safely without history rewriting (`--no-edit`, preserving git history):
   ```powershell
   git revert -m 1 <merge_commit_sha>
   ```
3. Run required verification gates before merging the revert PR:
   - `npm --prefix frontend run verify`
   - `npm --prefix frontend run build`
   - `f:\c1\capstone1\.venv\Scripts\python.exe -B -m unittest discover -s backend -p "test_*.py"`
   - `android/scripts/build-android.ps1` unit tests (`:app:testDebugUnitTest :app:lintDebug`)

**User Data / Database Safety Guarantee after Full Revert:**

- Any stale `viread_locale` cookie or `viread:locale:*` `localStorage` entry in users' browsers is harmlessly ignored once reverted.
- Any `preferred_locale` key written inside Supabase `auth.users.user_metadata` is benign JSON metadata unused by pre-i18n code and requires no database cleanup or migration rollback.
- Existing Supabase Auth sessions, Parent/Child profiles, private books, OCR revisions, reading sessions, difficult words, and Flow 1/Flow 2 training artifacts remain completely unaffected.
