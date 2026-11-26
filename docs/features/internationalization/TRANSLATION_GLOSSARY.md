# ViRead Global Internationalization — Translation Glossary & Terminology Rules

This glossary defines canonical product terminology, untranslated brand/technical identifiers, placeholder rules, and domain invariants for all 30 ViRead UI locales (`vi`, `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `fr`, `de`, `es`, `pt`, `it`, `ru`, `th`, `id`, `ms`, `fil`, `hi`, `bn`, `ar`, `tr`, `nl`, `sv`, `pl`, `uk`, `el`, `he`, `km`, `lo`, `my`, `ne`).

---

## 1. Core Domain Invariant: UI Language vs. Learning Content Language

ViRead is a **Vietnamese reading and literacy platform** for children. Localizing the application interface **only** translates UI chrome (navigation, buttons, labels, settings, reports, dialogs, onboarding, and error messages). The following **learning and domain data are NEVER translated** by UI dictionaries and remain `lang="vi"` (`dir="ltr"`):

- Vietnamese book titles, descriptions, page images, and page text
- OCR extracted tokens, reference Vietnamese text, and bounding-box overlays
- Phonics syllables, Vietnamese target words, and difficult-word lists
- Speech-to-Text (STT) transcripts and Text-to-Speech (TTS) pronunciation models (`vi` / `vi-VN`)
- Karaoke song lyrics and syllable timing tokens

---

## 2. Terms Kept Untranslated (Branded, Engine, Protocol & Format Tokens)

These terms MUST remain verbatim in Latin/ASCII form across all 30 locales (including non-Latin scripts such as `zh-Hans`, `zh-Hant`, `ja`, `ko`, `ru`, `th`, `hi`, `bn`, `ar`, `he`, `uk`, `el`, `km`, `lo`, `my`, `ne`). When grammar requires inflection or particles (e.g., Japanese `ViReadの`, Korean `ViRead의`, Arabic `في ViRead`), attach particles without altering the token spelling.

| Term                             | Category                  | Rule                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ViRead`                         | Brand / Product           | Always keep exact casing `ViRead` (also `ViRead Studio`, `ViRead Android WebView`). Never translate or transliterate.                                                                                                                                                                    |
| `OCR`                            | Technical Acronym         | Keep `OCR` verbatim in all locales (may pair with local words like "OCR scan" / "Quét OCR").                                                                                                                                                                                             |
| `Hybrid OCR`                     | Product Feature / Engine  | Keep `Hybrid OCR` verbatim (or `<translated modifier> Hybrid OCR` where natural, never altering `Hybrid OCR`).                                                                                                                                                                           |
| `AI Tutor`                       | Product Feature Name      | Keep `AI Tutor` verbatim as the branded companion feature name (or pair cleanly with localized descriptor if grammar requires).                                                                                                                                                          |
| `VietOCR`                        | OCR Engine                | Proper engine name (`VietOCR`, `VietOCR V2`); never translate.                                                                                                                                                                                                                           |
| `PaddleOCR`                      | OCR Engine                | Proper engine name (`PaddleOCR`); never translate.                                                                                                                                                                                                                                       |
| `Tesseract`                      | OCR Engine                | Proper engine name (`Tesseract`); never translate.                                                                                                                                                                                                                                       |
| `Supabase`                       | Platform / Auth / Storage | Proper vendor name (`Supabase`, `Supabase Auth`, `Supabase Storage`); never translate.                                                                                                                                                                                                   |
| `HTTPS`                          | Protocol                  | Keep `HTTPS` (and `HTTP`, `URL`, `API`, `WebSocket`, `REST`) uppercase verbatim.                                                                                                                                                                                                         |
| `APK`                            | Android Package Format    | Keep `APK` uppercase verbatim.                                                                                                                                                                                                                                                           |
| Technical / File / Metric Tokens | Formats & Metrics         | Keep verbatim: `PDF`, `DOCX`, `PNG`, `JPEG`, `JPG`, `WebP`, `MP3`, `WAV`, `JSON`, `YAML`, `CER`, `WER`, `ISBN`, `PIN`, `OTP`, `TTS`, `STT`, `WASM`, `WebAssembly SIMD`, `IndexedDB`, `Karaoke`, `Google`, `Facebook`, `Email`, `ADMIN`, `vi-VN`, `vireadforyou@gmail.com`, `0905373633`. |

---

## 3. Canonical Product Terminology (Translated Consistently in Context)

Translate the concepts below into natural, concise, child-and-parent-friendly UI phrasing in each target language, keeping tone consistent with ViRead's warm parent/child experience and clear admin tooling.

| Canonical English Term | Vietnamese Reference (`vi`)               | Context & Usage Notes                                                                                                                                                          |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Reading session**    | `Buổi đọc` / `Phiên đọc`                  | A single timed/tracked child reading activity on a book or page. Avoid overly clinical words where parent/child UI appears.                                                    |
| **Difficult words**    | `Từ khó` / `Từ cần luyện`                 | Words the child misread, skipped, or marked for targeted phonics/retry practice.                                                                                               |
| **Phonics**            | `Đánh vần` / `Âm vần`                     | Letter-sound / syllable breakdown cues used to help children sound out Vietnamese words. Note: the Vietnamese letters/syllables themselves stay in Vietnamese.                 |
| **Pronunciation**      | `Phát âm`                                 | Spoken articulation quality, sample TTS audio playback, or pronunciation feedback.                                                                                             |
| **Reading progress**   | `Tiến độ đọc` / `Tiến bộ`                 | Longitudinal metrics across sessions, pages read, accuracy, fluency, and streaks.                                                                                              |
| **Parent**             | `Phụ huynh` / `Ba mẹ`                     | Account holder managing children, books, schedules, and reports. Keep warm family register where appropriate in UI (`Parent` in `en`, polite parent term in target languages). |
| **Child**              | `Bé` / `Trẻ` / `Hồ sơ bé`                 | Learner profile associated with a parent account. Use warm, respectful child/learner phrasing.                                                                                 |
| **Administrator**      | `Quản trị viên` / `Quản trị`              | Internal staff managing book catalog, OCR verification, safety review, and model training (`Admin` badge stays `ADMIN` where space-constrained).                               |
| **Word recognition**   | `Nhận diện từ`                            | Visual OCR token detection or live spoken-word matching against target text on the page.                                                                                       |
| **Voice recognition**  | `Nhận diện giọng nói`                     | Speech-to-Text (`STT`) capture and verification of the child's reading voice.                                                                                                  |
| **Training dataset**   | `Tập dữ liệu huấn luyện`                  | Curated OCR/VietOCR sample crops and verified labels used for Flow 1 / Flow 2 training.                                                                                        |
| **Model checkpoint**   | `Checkpoint mô hình`                      | Saved model weights snapshot (`model checkpoint` / `checkpoint`) evaluated before activation.                                                                                  |
| **Safety review**      | `Kiểm duyệt an toàn` / `Đánh giá an toàn` | Automated and admin-confirmed child-safety suitability check (`GRADE_1_TO_5`) on book content.                                                                                 |

---

## 4. Formatting, Placeholders & ICU Pluralization Rules

1. **Exact Placeholder Preservation**:
   - Every `{variable}` placeholder (e.g., `{name}`, `{alias}`, `{count}`, `{page}`, `{totalPages}`, `{email}`, `{maxMb}`, `{duration}`) MUST appear with the exact ASCII variable name and braces in every translation.
   - Never translate variable names inside `{...}`.
   - Never drop, duplicate unexpectedly, or corrupt `{...}` into full-width braces (`｛｝`).
2. **ICU-Subset Pluralization (`plural`)**:
   - ViRead's `formatMessage` (`frontend/lib/i18n/formatter.ts`) uses `Intl.PluralRules(bcp47)` and supports `=0`, `zero`, `one`, `two`, `few`, `many`, `other`, plus `#` inside plural branches (replaced by locale-formatted count).
   - Every plural template in `vi` (`{count, plural, =0 {...} other {...}}`) MUST remain a valid `{count, plural, ...}` block containing at least an `other {...}` branch (plus `=0` / `one` / `few` / `many` where natural for the target language's CLDR plural rules).
   - Keep `=0 {...}` and `one {...}` concise; use `#` where the numeric count should render.
3. **Plain-Text Safety & Typography**:
   - Translations are pure plain text (never insert raw HTML tags or markdown links).
   - Preserve explicit punctuation semantics (e.g., `…` ellipsis, `·` middle dot separators in breadcrumbs/metadata lines, units like `ms`, `MB`, `KB`, `B`, `px`).
   - Keep button and tab labels concise so layouts from `320px` to `1920px` do not wrap awkwardly or overflow (especially in verbose languages like `de`, `fr`, `es`, `ru`, `uk`, `el`).
4. **RTL (`ar`, `he`) Rules**:
   - Translate UI strings naturally in Arabic/Hebrew while keeping brand/technical tokens (`ViRead`, `OCR`, `VietOCR`, `Supabase`, `HTTPS`, `APK`, `{placeholder}`) in their standard LTR inline order.
   - Never embed manual Unicode directional override characters (`\u202a`–`\u202e`) inside dictionary values unless strictly needed; layout isolation (`dir="ltr"` on `.viread-learning-content`) is handled by React/CSS.

---

## 5. Untranslated Allowlist Policy (`check-i18n.mjs`)

`frontend/scripts/check-i18n.mjs` flags values that are identical to the `vi` reference or contain Vietnamese diacritics (`--strict` turns these into build-failing errors). Only pure brand names, acronyms, technical labels, contact literals (`vireadforyou@gmail.com`, `0905373633`), or pure punctuation/unit templates (`—`, `?`, `{value} ms`, `{width} × {height} px`) belong in `UNTRANSLATED_ALLOWLIST` or symbol exemptions. Real UI prose must be translated in every published locale.
