# ViRead Global Internationalization — Research & Architecture Selection

## 1. Repository Stack Baseline (Verified)

Measured directly in `frontend/package.json`, `frontend/proxy.ts`, `backend/requirements.txt`, and `android/`:

| Component          | Exact Version / Mechanism                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Frontend Framework | Next.js `16.4.6` (App Router, async `cookies()`, `frontend/proxy.ts` middleware)                           |
| UI Runtime         | React `19.3.0` / React DOM `19.3.0` (Server Components + Client Components)                                |
| Language           | TypeScript `6.0.3`                                                                                         |
| Styling            | Tailwind CSS `4.3.3` + CSS custom properties in `frontend/app/globals.css`                                 |
| Font               | `@fontsource-variable/nunito` `5.3.0` (bundled for Latin + Vietnamese)                                     |
| Auth & Data        | `@supabase/ssr` `^0.12.7`, `@supabase/supabase-js` `^2.117.2`                                              |
| Test Tooling       | Vitest `5.1.1`, Playwright `1.63.0`, Python `unittest`                                                     |
| Android Host       | Native WebView (`MainActivity.java`) loading HTTPS Web origin (`minSdk`/`targetSdk` Android 16 compatible) |

---

## 2. i18n Library & Architecture Comparison

We evaluated six candidates against ViRead's exact constraints: Next.js 16.4.6 App Router (`proxy.ts`), React 19.3.0, TypeScript 6.0.3, Supabase Auth PKCE callbacks, Android WebView cookie storage, lazy per-locale bundle splitting across 30–100+ languages, RTL support, and `0 VND` cost.

| Solution                                                        | Next.js 16 App Router (RSC + Client)                                                                    | TypeScript 6 / Zero Peer Conflicts                                    | URL-Free Cookie Locale Support                                   | Per-Locale Lazy Loading & Bundle Impact                              | ICU Plural + Safe Plain Interpolation                                            | Cross-Account Cookie Isolation                              | Decision     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------ |
| **Custom Typed JSON Dictionaries + `Intl` Core (`lib/i18n/*`)** | Native async `cookies()` SSR + synchronous default `vi` context in Client                               | Zero third-party peer risk; clean strict TS                           | First-class (`viread_locale` cookie + `viread:locale:user:<id>`) | Only `vi` initially; 29+ locales loaded via dynamic `import()`       | Custom balanced-brace parser + `Intl.PluralRules(bcp47)` + 7 `Intl.*` formatters | Full (`LOCALE_COOKIE_OWNER_STORAGE_KEY` + auth sync events) | **SELECTED** |
| `next-intl`                                                     | Strong App Router support                                                                               | New dependency; middleware/routing conventions couple with `proxy.ts` | Possible via `localePrefix: "never"`, extra adapter needed       | Requires bundler plugin/config or server-passed messages             | Full ICU (`intl-messageformat`)                                                  | Custom wrapper still required                               | Not selected |
| `i18next` / `react-i18next`                                     | Needs separate SSR/client wiring in App Router RSC                                                      | Runtime weight larger; plugin ecosystem fragmented for Next 16 RSC    | Works with custom detector                                       | Needs `i18next-resources-to-backend` + client hydration coordination | Needs extra ICU plugin for full CLDR plural rules                                | Custom wrapper still required                               | Not selected |
| `next-i18next`                                                  | Designed for Pages Router (`_app` / `getStaticProps`); incompatible pattern for App Router              | Not suitable for Next 16 App Router RSC                               | Coupled to Next Pages `i18n` config                              | Pages Router chunking                                                | Via `i18next`                                                                    | N/A                                                         | Rejected     |
| `Lingui`                                                        | Compile-time macro extraction requires SWC/Babel extractor maintenance in Next 16 Turbopack             | Build-chain risk with Next 16 Turbopack + Vitest 5                    | Possible, custom wiring                                          | Good compiled catalogs, extra compile step                           | Native ICU macros                                                                | Custom wrapper still required                               | Not selected |
| Native Next.js `i18n` Routing                                   | Subpath/domain routing alters URLs (`/en/books`), deprecated in App Router without custom proxy rewrite | Built-in                                                              | Forces URL prefixes or rewrites                                  | Dictionary layer still must be written                               | None built-in                                                                    | None                                                        | Rejected     |

### Why Custom Typed JSON Dictionaries + `Intl` Won on Evidence

1. **Zero Dependency & Zero Peer-Dependency Risk**: Next.js `16.4.6`, React `19.3.0`, and TypeScript `6.0.3` are cutting-edge major versions. Avoiding external i18n runtime libraries guarantees zero peer-dependency mismatches, zero bundler/SWC plugin breakage under Turbopack (`frontend/next.config.ts`), and full control over updates.
2. **Synchronous Test & SSR Compatibility**: Providing `viMessages` as the synchronous default inside `I18nContext` allows all existing component unit tests in Vitest (which mount components standalone without wrapping in `<I18nProvider>`) to render authentic Vietnamese copy with zero wrapper boilerplate.
3. **Strict Lazy Loading (Zero Multi-Locale Bloat)**: `frontend/messages/loader.ts` stores `DEFAULT_LOCALE = "vi"` cleanly for instant default SSR/hydration and loads each non-Vietnamese locale (`en`, `ja`, `ar`, etc.) strictly via dynamic `import()` only when selected or requested in `viread_locale`.
4. **First-Class Security & State Preservation**: No runtime AI translation, zero `dangerouslySetInnerHTML`, a deterministic parser (`renderMessageTemplate` with `MAX_INTERPOLATION_DEPTH = 4` and NUL-byte stripping), and `Intl.PluralRules` / `Intl.DateTimeFormat` / `Intl.NumberFormat` / `Intl.ListFormat` / `Intl.RelativeTimeFormat` native in modern Chromium, Node 22+, and Android WebView.

---

## 3. URL Strategy: Cookie-Based Locale (`viread_locale`) vs. Subpath Prefixes (`/vi/...`, `/en/...`)

| Criterion                                                                    | Cookie-Based (`viread_locale`) + No URL Mutation (**Selected**)                                                                                                                      | Path Prefix (`/vi/books`, `/en/books`)                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Existing routes & bookmarks (`/books`, `/reading/[sessionId]`, `/admin/*`)   | **100% preserved** (`0` broken links)                                                                                                                                                | Every link, test selector, and route file shifts or needs rewrite layer                           |
| Supabase Auth PKCE callbacks & OAuth redirects (`/login`, `/reset-password`) | **Zero impact**; Supabase Redirect URL allowlist & `MainActivity.OAuthLoopbackServer` work unchanged                                                                                 | Requires dynamic `[locale]` callback whitelist across Supabase Dashboard & Android intent filters |
| `frontend/proxy.ts` protected-route guard (`getProtectedRouteArea`)          | Unchanged (`pathname === "/dashboard"`, `"/admin"`, etc.)                                                                                                                            | Must strip locale segments before every RBAC / auth check                                         |
| Switching UI language mid-reading session                                    | Instant client state + cookie update (`< 50ms` cached) with **zero route navigation, zero lost reading progress, zero lost OCR/form state**                                          | Triggers `router.push` / full route segment navigation (`/[newLocale]/...`)                       |
| Private Parent/Child/Admin routes & SEO                                      | Private routes stay behind auth (`proxy.ts`) and unindexed; public root (`generateMetadata`) reflects active SSR `viread_locale` without polluting search indexes with private pages | Exposes duplicate `/locale/*` paths requiring `hreflang` / canonical hygiene for private prefixes |
| Future extensibility                                                         | Compatible if public marketing landing pages later opt into SEO path aliases, with zero app-shell rewrite                                                                            | Expensive migration                                                                               |

**Decision**: Retain canonical URL paths (`/`, `/login`, `/dashboard`, `/books`, `/reading/[sessionId]`, `/admin/...`) with `viread_locale` HTTP cookie + per-user `localStorage` + optional `user_metadata.preferred_locale` sync.

---

## 4. Font Licensing & Multi-Script Typography Strategy

- **Latin & Vietnamese (`vi`, `en`, `fr`, `de`, `es`, `pt`, `it`, `id`, `ms`, `fil`, `tr`, `nl`, `sv`, `pl`)**: Preserves `@fontsource-variable/nunito` (`Nunito Variable`, Open Font License / SIL OFL), ensuring complete Vietnamese combining diacritics (`ă â đ ê ô ơ ư` + 5 tone marks) never regress.
- **Non-Latin Scripts (`zh-Hans`, `zh-Hant`, `ja`, `ko`, `ru`, `uk`, `el`, `ar`, `he`, `th`, `km`, `lo`, `my`, `hi`, `ne`, `bn`)**: Uses targeted CSS `html:lang(...)` `--font-sans` stacks in `frontend/app/globals.css` pointing to verified cross-platform OS UI fonts (macOS/iOS, Windows 10/11, Android Roboto/Noto system families).
- **CSP & Performance Benefit**: `frontend/next.config.ts` sets `font-src 'self' data:`. Relying on system CJK/Indic/Arabic/SE-Asian script fallbacks avoids bundling tens of megabytes of external `.woff2` files, respects zero-cloud-egress limits, and satisfies strict CSP with zero external font CDNs.

---

## 5. Zero-Cost Operating Guarantee & Data Privacy Boundary

- **Runtime Translation Cost**: `0 VND`. All UI translations ship as static frontend TypeScript/JSON chunks and static Python/Android string tables. Switching languages never calls Google Translate API, DeepL, OpenAI, Gemini, Groq, or Ollama, and never depends on a developer laptop being online.
- **Data Privacy & Child Safety**: Only static, generic UI labels exist in `frontend/messages/**`. No user PII, child profile data, private parent books, reading recordings, or Supabase database rows ever leave ViRead for localization.
- **Domain Invariant**: Hybrid OCR (`VietOCR` + `PaddleOCR` + `Tesseract`), Vietnamese STT, Vietnamese TTS, phonics syllables, difficult words, karaoke lyrics, and Flow 1/Flow 2 training datasets remain 100% locked to Vietnamese (`lang="vi"`, `dir="ltr"`).
