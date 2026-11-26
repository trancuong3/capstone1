# ViRead Supported Languages & Rollout Status

ViRead's internationalization architecture maintains a unified 30-locale registry across:

- Frontend: `frontend/lib/i18n/locales.ts` (`SUPPORTED_LOCALE_CODES`, `LOCALE_REGISTRY`)
- Backend: `backend/app/services/i18n/locales.py` (`SUPPORTED_LOCALE_CODES`, `LOCALE_REGISTRY`)
- Android: `android/app/src/main/res/values/strings.xml` plus 29 qualified resource directories (`values-*`)

The registry is architected to scale beyond 100 locales without changing routing or auth, while **Vietnamese (`vi`)** remains the immutable system default and AI learning/OCR/STT/TTS pipeline language.

## Production Publishing Gate

Per project policy, a language is **only** exposed in production selectors (`published: true`) after reaching 100% UI key parity (`5,136 / 5,136` keys) and passing `i18n:check --strict` with zero placeholder, schema, or untranslated errors. Unfinished languages remain `status: "incomplete"` and `published: false` in `LOCALE_REGISTRY`, hidden from `<LanguageSelector>` by default (`publishedOnly = true`), and safely resolve back to `vi` if requested directly.

## Complete 30-Locale Registry

### Published in Production (11 Locales — 5,136 / 5,136 Keys Verified)

| Code      | Native Name | English Name          | Direction | Region Group     | Popular | Status     | Published |
| --------- | ----------- | --------------------- | --------- | ---------------- | ------- | ---------- | --------- |
| `vi`      | Tiếng Việt  | Vietnamese            | `ltr`     | `southeast-asia` | Yes     | `complete` | Yes       |
| `en`      | English     | English               | `ltr`     | `global`         | Yes     | `complete` | Yes       |
| `zh-Hans` | 简体中文    | Chinese (Simplified)  | `ltr`     | `east-asia`      | Yes     | `beta`     | Yes       |
| `zh-Hant` | 繁體中文    | Chinese (Traditional) | `ltr`     | `east-asia`      | Yes     | `beta`     | Yes       |
| `ja`      | 日本語      | Japanese              | `ltr`     | `east-asia`      | Yes     | `beta`     | Yes       |
| `ko`      | 한국어      | Korean                | `ltr`     | `east-asia`      | Yes     | `beta`     | Yes       |
| `fr`      | Français    | French                | `ltr`     | `europe`         | Yes     | `beta`     | Yes       |
| `de`      | Deutsch     | German                | `ltr`     | `europe`         | Yes     | `beta`     | Yes       |
| `es`      | Español     | Spanish               | `ltr`     | `global`         | Yes     | `beta`     | Yes       |
| `ar`      | العربية     | Arabic                | `rtl`     | `middle-east`    | Yes     | `beta`     | Yes       |
| `he`      | עברית       | Hebrew                | `rtl`     | `middle-east`    | No      | `beta`     | Yes       |

### Registered Framework Locales Pending Full Translation (19 Locales)

These 19 locales have full locale metadata, BCP-47 alias canonicalization, backend registry entries, and Android resource files (`values-*`), while UI dictionary bundles (`frontend/messages/<locale>/`) remain unpublished until completed to 100%:

| Code  | Native Name      | English Name | Direction | Android Qualifier | Status       | Published |
| ----- | ---------------- | ------------ | --------- | ----------------- | ------------ | --------- |
| `pt`  | Português        | Portuguese   | `ltr`     | `values-pt`       | `incomplete` | No        |
| `it`  | Italiano         | Italian      | `ltr`     | `values-it`       | `incomplete` | No        |
| `ru`  | Русский          | Russian      | `ltr`     | `values-ru`       | `incomplete` | No        |
| `th`  | ไทย              | Thai         | `ltr`     | `values-th`       | `incomplete` | No        |
| `id`  | Bahasa Indonesia | Indonesian   | `ltr`     | `values-in`       | `incomplete` | No        |
| `ms`  | Bahasa Melayu    | Malay        | `ltr`     | `values-ms`       | `incomplete` | No        |
| `fil` | Filipino         | Filipino     | `ltr`     | `values-b+fil`    | `incomplete` | No        |
| `hi`  | हिन्दी           | Hindi        | `ltr`     | `values-hi`       | `incomplete` | No        |
| `bn`  | বাংলা            | Bengali      | `ltr`     | `values-bn`       | `incomplete` | No        |
| `tr`  | Türkçe           | Turkish      | `ltr`     | `values-tr`       | `incomplete` | No        |
| `nl`  | Nederlands       | Dutch        | `ltr`     | `values-nl`       | `incomplete` | No        |
| `sv`  | Svenska          | Swedish      | `ltr`     | `values-sv`       | `incomplete` | No        |
| `pl`  | Polski           | Polish       | `ltr`     | `values-pl`       | `incomplete` | No        |
| `uk`  | Українська       | Ukrainian    | `ltr`     | `values-uk`       | `incomplete` | No        |
| `el`  | Ελληνικά         | Greek        | `ltr`     | `values-el`       | `incomplete` | No        |
| `km`  | ភាសាខ្មែរ        | Khmer        | `ltr`     | `values-km`       | `incomplete` | No        |
| `lo`  | ລາວ              | Lao          | `ltr`     | `values-lo`       | `incomplete` | No        |
| `my`  | မြန်မာ           | Burmese      | `ltr`     | `values-my`       | `incomplete` | No        |
| `ne`  | नेपाली           | Nepali       | `ltr`     | `values-ne`       | `incomplete` | No        |
