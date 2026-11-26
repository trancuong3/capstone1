# How to Add a New Language to ViRead

ViRead's i18n registry (`frontend/lib/i18n/locales.ts`) is designed to scale cleanly beyond the initial 30 languages to 100+ locales without changing core framework or routing architecture. Follow the checklist below whenever adding locale `<code >`.

---

## Step 1: Register Metadata on the Frontend

Edit `frontend/lib/i18n/locales.ts`:

1. Add the canonical BCP 47 tag (for example `"cs"` or `"sw"`) to `SUPPORTED_LOCALE_CODES`.
2. Add its `LocaleMetadata` entry to `LOCALE_REGISTRY`:
   - `code`: canonical tag (`"cs"`)
   - `bcp47`: Intl-compatible tag (`"cs"` or `"cs-CZ"`)
   - `nativeName`: native autonym (`"Čeština"`) — **do not rely solely on country flags**
   - `englishName`: searchable English name (`"Czech"`)
   - `dir`: `"ltr"` or `"rtl"` (check RTL script rules if adding Urdu `ur`, Persian `fa`, etc.)
   - `popular`: `true` or `false`
   - `regionGroup`: one of `"southeast-asia" | "east-asia" | "south-asia" | "europe" | "middle-east" | "global"`
   - `status`: start with `"incomplete"`
   - `published`: start with `false` (never expose incomplete locales in the default `<LanguageSelector />`)
3. Optionally map legacy or regional aliases in `LOCALE_ALIAS_MAP` if needed.

---

## Step 2: Verify Script & Font Fallback

Check `frontend/app/globals.css`:

- Latin-script languages already inherit `@fontsource-variable/nunito` (`Nunito Variable`).
- If the new language uses an uncovered non-Latin or RTL script, add an `html:lang(<code>)` `--font-sans` stack with standard system fonts (macOS/Windows/Android) so no external font download is required at startup.
- Keep `.viread-learning-content { direction: ltr; unicode-bidi: isolate; }` intact.

---

## Step 3: Create All 19 Static Message Namespaces

Copy the structure of `frontend/messages/vi/` (reference baseline) into `frontend/messages/<code>/`:

1. Create every required namespace file matching `I18N_NAMESPACES` (`frontend/lib/i18n/types.ts`):
   `common.json`, `auth.json`, `navigation.json`, `parent.json`, `child.json`, `admin.json`, `books.json`, `ocr.json`, `reading.json`, `speech.json`, `difficultWords.json`, `reports.json`, `entertainment.json`, `games.json`, `settings.json`, `errors.json`, `validation.json`, `notifications.json`, `accessibility.json`.
2. Create `frontend/messages/<code>/index.ts` exporting the combined namespace dictionary (`MessagesDictionary`).
3. Follow `docs/features/internationalization/TRANSLATION_GLOSSARY.md`:
   - Keep branded/engine tokens verbatim (`ViRead`, `OCR`, `Hybrid OCR`, `AI Tutor`, `VietOCR`, `PaddleOCR`, `Tesseract`, `Supabase`, `HTTPS`, `APK`).
   - Preserve exact `{placeholder}` names and ICU plural syntax (`{count, plural, =0 {...} one {...} other {...}}`).
   - Never include raw HTML tags or executable snippets.

---

## Step 4: Wire Lazy Dynamic Import

Edit `frontend/messages/loader.ts` and add a single dynamic import entry under `BUILTIN_LOCALE_LOADERS`:

```ts
<code>: async () => (await import("@/messages/<code>")).default,
```

> **Rule:** Never statically import non-Vietnamese dictionaries at top level in `loader.ts` or `app/layout.tsx`, so initial JS bundles only contain Vietnamese (`DEFAULT_LOCALE`).

---

## Step 5: Validate Programmatically Before Publishing

From `frontend/`:

```powershell
npm run i18n:check -- --locale <code> --strict
npm run i18n:report
```

Confirm:

- Zero JSON syntax errors or duplicate keys.
- Zero missing or extra keys relative to `messages/vi/`.
- Exact placeholder parity (`{var}`) and balanced ICU plural braces.
- Zero untranslated strings outside the allowlist and zero leftover Vietnamese diacritics.

Only after passing `--strict` validation (plus UI/RTL/Playwright inspection on desktop `1440px` and mobile `320px`/`390px`), update `frontend/lib/i18n/locales.ts`:

- Set `status: "beta"` (or `"complete"` after qualified human review)
- Set `published: true`

---

## Step 6: Update Backend Locale Allowlist & Email Templates

1. Edit `backend/app/services/i18n/locales.py`:
   - Add `<code>` to `SUPPORTED_LOCALES`, `LOCALE_REGISTRY`, and `RTL_LOCALES` (if RTL).
2. Edit `backend/app/services/i18n/email_templates.py`:
   - Add localized entries to `READING_REMINDER_TEMPLATES` and `READING_PRESENCE_TEMPLATES` preserving `{child_alias}`, `{local_date}`, `{local_time}`, `{timezone_name}`, and `{app_url}` verbatim.
3. Run backend i18n tests:

```powershell
f:\c1\capstone1\.venv\Scripts\python.exe -m unittest test_i18n_backend -v
```

---

## Step 7: Add Android Resource Strings

1. Determine the Android resource qualifier (`values-<code>` for standard ISO-639-1 codes, or `values-b+<lang>+<script>` for script/3-letter tags; note Android legacy aliases `iw`/`in` if applicable).
2. Create `android/app/src/main/res/values-<qualifier>/strings.xml` translating user-facing native strings while keeping `app_name = "ViRead"`, escaped apostrophes (`\'`), XML entities (`&amp;`), and `%1$d` placeholders intact.
3. Add `<code>` to the `supported` list (and any aliases) in `MainActivity.java`.
4. Add/extend assertions in `android/app/src/test/java/vn/viread/android/LocalePersistenceAndResourcesTest.java` and run `:app:testDebugUnitTest :app:lintDebug`.
5. Run full `npm --prefix frontend run verify` and update `docs/features/internationalization/SUPPORTED_LANGUAGES.md` & `TRANSLATION_COVERAGE.md`.
