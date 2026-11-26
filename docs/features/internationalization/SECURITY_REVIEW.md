# ViRead Global Internationalization Security & Privacy Review

## Privacy & Data Residency Guarantees

- **Zero PII / Child Data Transmission**: ViRead never sends user emails, child profiles, reading transcripts, OCR captures, private book pages, or API tokens to any translation service at runtime or build time.
- **No External Runtime Translation**: All translations reside in static, version-controlled JSON files (`frontend/messages/<locale>/`), Python modules (`backend/app/services/i18n/`), and Android XML resources (`android/app/src/main/res/values*/strings.xml`).
- **CSP Compliance**: System script-aware font stacks declared in `frontend/app/globals.css` require no external CDN fonts, preserving the strict `font-src 'self' data:` Content Security Policy in `frontend/next.config.ts`.

## Locale Input Validation & Injection Defenses

Both frontend TypeScript and backend Python apply defense-in-depth allowlist normalization before reading, storing, rendering, or dynamically importing any locale:

1. **Strict Regex & Length Guard**:
   - Frontend (`frontend/lib/i18n/locales.ts`): `SAFE_LOCALE_INPUT_PATTERN = /^[A-Za-z0-9_-]{2,32}$/` and `STRICT_BCP47_SUBTAG_PATTERN` reject whitespace, quotes, angle brackets (`<script>`), path separators (`../`, `/`, `\`), semicolons, null bytes, CRLF header injection, and inputs longer than 32 chars.
   - Backend (`backend/app/services/i18n/locales.py`): `_LOCALE_TAG_RE` enforces strict 2-to-3 subtag ASCII structure and allowlists only `SUPPORTED_LOCALES`.
2. **Closed Allowlist Dispatch**: `frontend/messages/loader.ts` maps strictly from canonical `SupportedLocale` enum keys to explicit ES module `import()` thunks — never constructing dynamic file paths from raw user strings, eliminating path-traversal / arbitrary module loading risks.
3. **Unpublished Locale Gating**: `resolveLocalePriority({ publishedOnly })` rejects incomplete locales when unpublished gating is enforced, falling back safely to `"vi"`.
4. **XSS & Header Injection Resistance**:
   - Translations are rendered as plain text React nodes and structured ICU strings (zero `dangerouslySetInnerHTML`).
   - API error interpolation runs through React/text serialization rather than HTML concatenation.
   - Cookie storage uses `encodeURIComponent(locale)` and validates on every read via `normalizeLocale(decodeURIComponent(rawValue))` before applying to `<html lang={locale} dir={dir}>`.

## Verified Malicious Input Matrix

Tested in both `backend/test_i18n_backend.py` (`test_normalization_aliases_and_security_rejection`) and Chromium Playwright E2E (`frontend/tests/e2e/i18n.spec.ts`):

- `<script>window.__xssTriggered=true</script>` -> rejected (`null`), safely resolves to `vi` (`ltr`), `__xssTriggered === undefined`.
- `../../etc/passwd` / `en/../../etc/passwd` / `..\en` -> rejected (`null`), resolves to `vi`.
- `vi\r\nX-Injected: 1` / `en\x00vi` -> rejected (`null`), resolves to `vi`.
- `vi;DROP TABLE profiles` -> rejected (`null`), resolves to `vi`.
- Unpublished / unknown tags (`xx-INVALID`, `zz-ZZ`, `th` when gated) -> safely falls back to `vi` (`ltr`).

## Cookie & Multi-Account Isolation on Shared Devices

- **Cookie Attributes**: `viread_locale` is written with `Path=/; Max-Age=31536000; SameSite=Lax` plus `; Secure` when `window.location.protocol === "https:"`.
- **Cross-Account Isolation (`frontend/lib/i18n/persistence.ts`)**:
  - Authenticated preferences scope by `viread:locale:user:<userId>` in `localStorage` and track the active cookie owner via `viread:locale:cookie_owner`.
  - When signing out or switching to a different `userId` (`resolveAccountClientLocale`), Account A's `viread_locale` cookie cannot bleed into Account B's session if Account B has not chosen a preference; guest sessions read `viread:locale:guest` or default to `"vi"`.
- **CORS Compatibility (`frontend/lib/api/api-client.ts`)**: Default `"vi"` API requests omit the optional `X-ViRead-Locale` header so CORS preflights remain unaffected for legacy routes, while non-default locale selections send `X-ViRead-Locale` cleanly to FastAPI (`allow_headers=["*"]`).

## Auth, RBAC & Supabase RLS Boundary Preservation

- `proxy.ts`, Supabase Auth (`getClaims()` + `public.profiles` role check), Admin/Parent/Child route guards, and Supabase RLS policies remain completely untouched.
- Browser language preference cannot escalate privileges, bypass login redirects, or alter `public.profiles.role`.
- Child `ReadingScreen` intentionally omits `<LanguageSelector>` so young readers cannot inadvertently flip UI direction mid-session, while `.viread-learning-content` locks Vietnamese pedagogical text to `dir="ltr" lang="vi"`.
