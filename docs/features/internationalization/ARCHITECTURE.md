# ViRead Global Internationalization — System Architecture

## 1. High-Level Overview

ViRead implements a **unified, zero-cost, three-tier internationalization system** spanning Next.js 16 (SSR + Client), FastAPI Backend (localized errors & transactional emails), and Android WebView APK (native resource bundles + locale cookie synchronization), while preserving Vietnamese (`vi`) as the immutable default and protecting Vietnamese learning content from UI/RTL side effects.

```
+-------------------------------------------------------------------------+
|                    User Language Choice Priority                        |
|  1. Explicit user switch  ->  2. Authenticated user's saved pref         |
|  3. Isolated device cookie (`viread_locale`) -> 4. Default `"vi"`       |
|  (NEVER OS locale, NEVER navigator.language, NEVER Accept-Language/IP)  |
+-------------------------------------------------------------------------+
         |                           |                           |
         v                           v                           v
+------------------+      +---------------------+      +------------------+
|  Next.js 16 SSR  |      |  Client I18nEngine  |      |   Android Shell  |
| getServerI18n()  |      |   I18nProvider &    |      | MainActivity.java|
|  await cookies() |      |   loadLocaleMessages|      | attachBaseContext|
| -> html[lang/dir]|      |  (lazy import() +   |      | SharedPreferences|
+------------------+      |   in-memory cache)  |      | + CookieManager  |
                          +---------------------+      +------------------+
                                     |
                                     | HTTP Header: X-ViRead-Locale
                                     v
                          +---------------------+
                          |   FastAPI Backend   |
                          | app/services/i18n/* |
                          | Structured Errors + |
                          | 30-Locale Email     |
                          +---------------------+
```

---

## 2. Locale Resolution & Cross-Account Isolation

### Strict Priority Rule (`frontend/lib/i18n/locales.ts`)

`resolveLocalePriority()` resolves locales in this exact precedence:

1. **Explicit user selection** (just picked in `<LanguageSelector />`).
2. **Saved account preference** for the **matching active user ID** (`accountUserId === activeUserId`), read from per-user `localStorage` (`viread:locale:user:${userId}`) or Supabase `user.user_metadata.preferred_locale`.
3. **Isolated device preference / cookie** (`viread_locale` HTTP cookie or guest `localStorage` `viread:locale:guest`).
4. **Mandatory Default**: `DEFAULT_LOCALE = "vi"`.

`navigator.language`, `Accept-Language`, and IP geolocation are intentionally ignored everywhere across frontend, backend, and Android.

### Cross-Account Leak Prevention (`frontend/lib/i18n/persistence.ts`)

To stop Account A's UI language on a shared browser/tablet from leaking into Account B or guest sessions:

- Authenticated switches store `viread:locale:user:${userId}` AND record `viread:locale:cookie_owner = userId` alongside cookie `viread_locale`.
- Guest switches store `viread:locale:guest` and remove `viread:locale:cookie_owner`.
- `resolveAccountClientLocale()` compares `cookieOwner` against the active signed-in `userId`: if `cookieOwner` belongs to another account, Account B ignores A's cookie and falls back cleanly to B's saved preference (or `viread:locale:guest` / `"vi"`).
- `AppShell` and `AuthServiceProvider` dispatch `dispatchI18nAuthSync({ userId: null, preferredLocale: null })` via `VIREAD_AUTH_SYNC_EVENT` on sign-out/account switch.

---

## 3. Frontend Architecture

| Module               | Path                                                                       | Responsibility                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry & Allowlist | `frontend/lib/i18n/locales.ts`                                             | 30-locale metadata (`code`, `bcp47`, `nativeName`, `englishName`, `dir`, `popular`, `regionGroup`, `status`, `published`), strict `normalizeLocale()` allowlist & alias normalization (`zh-CN` -> `zh-Hans`, `iw` -> `he`, `in` -> `id`), and `resolveLocalePriority()`                                                           |
| Types & Namespaces   | `frontend/lib/i18n/types.ts`                                               | Defines all 19 namespaces (`common`, `auth`, `navigation`, `parent`, `child`, `admin`, `books`, `ocr`, `reading`, `speech`, `difficultWords`, `reports`, `entertainment`, `games`, `settings`, `errors`, `validation`, `notifications`, `accessibility`)                                                                          |
| Safe Formatter       | `frontend/lib/i18n/formatter.ts`                                           | Plain-text `{var}` interpolation (`MAX_INTERPOLATION_DEPTH = 4`), balanced-brace ICU pluralization backed by `Intl.PluralRules`, `viMessages` fallback, and native `Intl` formatters (`formatDate`, `formatTime`, `formatDateTime`, `formatNumber`, `formatPercent`, `formatDuration`, `formatRelativeTime`, `formatList`)        |
| SSR Loader           | `frontend/lib/i18n/server.ts`                                              | Async `getServerLocale()` / `getServerI18n()` using Next.js 16 `await cookies()`; rejects invalid/unpublished cookies to `"vi"` and loads ONLY that single locale bundle for SSR + `generateMetadata()`                                                                                                                           |
| Persistence          | `frontend/lib/i18n/persistence.ts`                                         | Cookie (`viread_locale`, `SameSite=Lax`, auto `Secure` on HTTPS), user/guest `localStorage`, optional Supabase `auth.updateUser({ data: { preferred_locale } })`, and account isolation                                                                                                                                           |
| Lazy Loader          | `frontend/messages/loader.ts`                                              | Keeps `viMessages` eager as baseline; lazy-loads every non-`vi` locale once via dynamic `import()`, deduplicates concurrent requests via `inflightLoads`, caches in `messageCache`, and safely falls back to `viMessages` on error                                                                                                |
| Context & Hook       | `frontend/components/i18n/i18n-provider.tsx`, `frontend/hooks/use-i18n.ts` | Synchronizes `document.documentElement.lang` & `dir`, updates locale without `router.refresh()` (preserving active forms, filters, reading/OCR state), provides synchronous `vi` default in `I18nContext` for standalone unit tests                                                                                               |
| Selector UI          | `frontend/components/i18n/language-selector.tsx`                           | Accessible popover (`header`, `compact`, `menu`, `settings`) on desktop + mobile `< 640px` bottom sheet with search input, Popular/All sections, active checkmark, keyboard nav, WCAG 2.2 focus rings, 44px+ targets, safe-area inset padding, Android `popstate`/Escape close, and conditional `role="status"` live announcement |
| Global Root & CSS    | `frontend/app/layout.tsx`, `frontend/app/globals.css`                      | Async `RootLayout` sets `<html lang={locale} dir={dir}>`; CSS provides script-aware font fallbacks and `.viread-learning-content` isolation                                                                                                                                                                                       |

### Selector Placement Policy (Child UI Protection)

- **Exposed**: Public header (`SiteHeader`), Login/Register/Forgot/Reset/Admin-Login, authenticated `AppShell` header & `AccountAvatarMenu`, `AccountSettingsScreen` (with note clarifying books/OCR/STT/TTS stay Vietnamese), and `AdminLayout`.
- **Omitted Intentionally**: Active child reading workspace (`ReadingScreen` / `reading-controls.tsx`) so children cannot accidentally trigger locale switches mid-session.

---

## 4. RTL Support & Learning-Content Isolation

- **RTL UI Chrome**: Setting locale to `ar` or `he` applies `dir="rtl"` on `<html>`. Tailwind physical directional utilities (`ml-*`, `mr-*`, `pl-*`, `pr-*`, `left-*`, `right-*`, `text-left`, `text-right`) across headers, sidebars, dropdowns, modals, cards, tables, and admin chrome were converted to logical properties (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`, `text-start`, `text-end`), with directional directional icons flagged via `.viread-rtl-flip`.
- **Immutable Vietnamese Content (`viread-learning-content`)**: `BookPageViewer`, `BookPageContent`, `WordHighlightOverlay`, OCR reference/extracted text previews, difficult-word target words, phonics syllable cards, live transcript tokens, and karaoke lyrics explicitly carry `dir="ltr" lang="vi"` and `.viread-learning-content` (`direction: ltr; unicode-bidi: isolate;` in `frontend/app/globals.css`). Book scans, OCR bounding coordinates, word sequences, and audio playback icons remain unmirrored.

---

## 5. Backend Internationalization Architecture

Located in `backend/app/services/i18n/`:

1. **`locales.py`**: Mirrors all 30 canonical locales (`DEFAULT_LOCALE = "vi"`, `RTL_LOCALES = {"ar", "he"}`, `LOCALE_HEADER_NAME = "X-ViRead-Locale"`). `normalize_locale()` enforces strict ASCII regex (`^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$`), rejects NUL bytes, path traversal (`..`, `/`, `\`), HTML payloads, and unsupported tags, returning `"vi"` via `resolve_supported_locale()`.
2. **`errors.py`**: `ERROR_REGISTRY` and `format_error_detail(code, default_message, **params)` attach backward-compatible `{ code, message_key, message_params, message }` details. Machine error codes (`OCR_WORKER_OFFLINE`, `GOAL_DUPLICATE`, `SESSION_NOT_ACTIVE`, etc.) are never altered or translated; `frontend/lib/api/api-client.ts` sends `X-ViRead-Locale` on requests and maps safe backend error codes/messages to localized `errors.*` keys in the UI.
3. **`email_templates.py` & Providers**: `reading_reminder_email_provider.py`, `reading_presence_email_provider.py`, and `support_email_provider.py` (along with workers `reading_reminder_worker.py` and `reading_presence_alert_worker.py`) accept optional `locale: str = "vi"` and set email `Content-Language`. `"vi"` preserves legacy Vietnamese copy verbatim; reminder `local_date`, `local_time`, and `timezone_name` are passed through verbatim so scheduling semantics never drift with UI language.

---

## 6. Android APK Architecture

In `android/`:

- **Resource Bundles**: Default Vietnamese `android/app/src/main/res/values/strings.xml` stays unchanged (`vi` fallback), paired with 29 localized `values-<qualifier>/strings.xml` directories (including legacy Android aliases `values-in` for `id`, `values-iw` for `he`, and BCP-47 `values-b+zh+Hans`, `values-b+zh+Hant`, `values-b+fil`), keeping `%1$d` format arguments and brand `ViRead` intact.
- **Device-Locale Independence (`MainActivity.java`)**:
  - `attachBaseContext(Context newBase)` reads persisted `"viread_ui_locale"` from `SharedPreferences` (`"viread_locale_prefs"`), defaulting strictly to `"vi"` when unset/invalid — completely ignoring Android OS language (`persist.sys.locale`).
  - Applies `LocaleList` + `createConfigurationContext(config)` before Activity resource inflation.
  - `syncLocalePreferenceFromCookies()` inspects `CookieManager` for `viread_locale` on the trusted ViRead origin during `onPageFinished`, `onPause`, and `onStop`, flushes cookies via `CookieManager.getInstance().flush()`, and saves normalized locale changes to `SharedPreferences` for subsequent launches.
  - `handleBackNavigation()` and `registerModernBackCallback()` preserve Android Back gesture / WebView history navigation for bottom-sheet dismissal (`popstate` hook in `LanguageSelector`) and screen exit confirmation.
