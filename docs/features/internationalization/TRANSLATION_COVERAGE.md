# ViRead Translation Coverage Report

> [!NOTE]
> All counts below come directly from `frontend/messages/vi/*.json`, `node scripts/check-i18n.mjs --strict`, and `frontend/coverage/i18n-report.json`.

## Summary

- **Reference Locale**: `vi` (`Tiếng Việt`)
- **Total Leaf Keys**: **5,136** across **19 namespaces** (`4,526` unique source strings)
- **Published Locales**: **11 / 30** (`vi`, `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `fr`, `de`, `es`, `ar`, `he`)
- **Unpublished Locales (`published: false`)**: **19 / 30** (`pt`, `it`, `ru`, `th`, `id`, `ms`, `fil`, `hi`, `bn`, `tr`, `nl`, `sv`, `pl`, `uk`, `el`, `km`, `lo`, `my`, `ne` — omitted from `frontend/messages/` until 100% translated)
- **Validation Status (`i18n:check --strict`)**: `ok: true`, `errorCount: 0`, `warningCount: 0`

## Coverage by Published Locale

| Locale     | Status     | Leaf Keys | Translated | Missing | Extra | Placeholder Errors | Untranslated Errors | Coverage |
| ---------- | ---------- | --------- | ---------- | ------- | ----- | ------------------ | ------------------- | -------- |
| `vi` (ref) | `complete` | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `en`       | `complete` | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `zh-Hans`  | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `zh-Hant`  | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `ja`       | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `ko`       | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `fr`       | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `de`       | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `es`       | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `ar` (RTL) | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |
| `he` (RTL) | `beta`     | 5,136     | 5,136      | 0       | 0     | 0                  | 0                   | **100%** |

## Leaf Key Distribution Across All 19 Namespaces

| Namespace File        | Description                                                               | Leaf Keys |
| --------------------- | ------------------------------------------------------------------------- | --------- |
| `accessibility.json`  | ARIA labels, skip links, focus descriptions                               | 9         |
| `admin.json`          | Admin portal, OCR review, AI workflows, Flow 1/2 training, karaoke studio | 2,113     |
| `auth.json`           | Login, registration, password reset, email verification                   | 90        |
| `books.json`          | Catalog, parent My Books, upload/moderation wizards                       | 462       |
| `child.json`          | Child profile creation, switcher, reading level prompts                   | 24        |
| `common.json`         | Shared actions, states, language selector UI, branding                    | 77        |
| `difficultWords.json` | Difficult words dashboard and practice panel UI                           | 152       |
| `entertainment.json`  | Karaoke player, picture description, entertainment hub                    | 301       |
| `errors.json`         | API error catalog, HTTP fallback messages, client runtime errors          | 284       |
| `games.json`          | Sentence shooter and educational mini-games UI                            | 88        |
| `navigation.json`     | Header links, mobile bottom nav, account menu, footer                     | 61        |
| `notifications.json`  | Confirmation dialogs, reminder toasts, email verification notices         | 7         |
| `ocr.json`            | Scanner capture, camera upload, OCR extraction feedback                   | 99        |
| `parent.json`         | Parent dashboard, profile, settings, reading plans, support               | 209       |
| `reading.json`        | Reading preparation, active session UI, phonics, tutor prompts            | 410       |
| `reports.json`        | Progress charts, session history, comprehension reports                   | 593       |
| `settings.json`       | Preference groups, language management, account controls                  | 39        |
| `speech.json`         | STT/TTS status banners, WASM progress, microphone permission UI           | 91        |
| `validation.json`     | Form schema validation messages across auth, parent, admin forms          | 27        |
| **Total**             | **All 19 Namespaces**                                                     | **5,136** |

## Non-Frontend Localization Coverage

- **Backend (`backend/app/services/i18n/`)**:
  - `locales.py`: 30 allowlisted locales with safe BCP-47 normalization and `"vi"` default.
  - `email_templates.py`: Localized reminder, presence alert, and support emails via `render_reading_reminder_email`, `render_reading_presence_email`, and `SupportEmailProvider`.
  - `errors.py`: Safe localized `format_error_detail` mapping (`10/10` tests passing in `backend/test_i18n_backend.py` in `0.177s`).
- **Android (`android/app/src/main/res/values*/strings.xml`)**:
  - 30 string resource directories (`values` default `vi` + 29 qualified locale directories) verified with `LocalePersistenceAndResourcesTest` (`3/3` Robolectric tests passing).
