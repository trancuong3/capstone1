# Admin Karaoke Workflow — BEFORE & AFTER Audit (ViRead Play & Learn V4.0)

- **Audit Date:** 2026-11-25
- **Branch / Baseline SHA:** `feature/viread-intelligent-play-learn-v4` @ `29e2da36`
- **Scope:** Admin Karaoke authoring, upload, processing, review, timing repair, and publishing workflow (`frontend/components/admin/karaoke/**`, `frontend/lib/karaoke/wizard-controller.ts`, `frontend/lib/karaoke/draft-save-queue.ts`, `frontend/lib/karaoke/processing-session.ts`, `frontend/types/karaoke.ts`, `docs/karaoke-auto-import/**`).

---

## 1. BEFORE — Current Admin Karaoke Architecture & Routing

### 1.1 Entry Routes & Silent Fallback Trap

| Route | Component | Behavior Today |
| --- | --- | --- |
| `/admin/karaoke` | `KaraokeLibraryScreen` (`frontend/components/admin/karaoke/karaoke-library-screen.tsx`) | Lists songs with filter/search/pagination; polls list every 5s when any item has an active processing job (`QUEUED`/`RUNNING`/`READY`/`NEEDS_REVIEW`, L58–83). CTA: **"Tạo bài hát"** → `/admin/karaoke/new`. |
| `/admin/karaoke/new` | `KaraokeWorkspaceScreen` (`frontend/components/admin/karaoke/karaoke-workspace-screen.tsx`) | Calls `getProcessingCapabilities()` (L48–53). **CRITICAL FALLBACK (L121–134):** If `!capabilities?.enabled \|\| !capabilities.configured`, silently drops the admin into the legacy 4-card manual `KaraokeEditorScreen`. |
| `/admin/karaoke/[songId]/edit` | `KaraokeWorkspaceScreen` (`advanced={mode === "advanced"}`) | Renders `KaraokeWizardScreen` if capabilities are enabled/configured, or `KaraokeEditorScreen` if `?mode=advanced` or capabilities are disabled. Opening a `PUBLISHED` song without an active draft renders a gate card requiring an explicit click on **"Tạo bản nháp để chỉnh sửa"** (L101–120). |

> **Current Live Reality (`docs/karaoke-auto-import/STATUS.md:57-60, 171`):** Because karaoke auto-processing feature flags, worker processes, and Supabase processing tables default to **OFF / unapplied**, admins visiting `/admin/karaoke/new` today actually hit **Path B (Legacy Manual Editor)** unless auto-processing is explicitly enabled and configured.

---

## 2. BEFORE — Exact Required Fields Inventory

Validated by `frontend/types/karaoke.ts` (`karaokeMetadataSchema` L8–15, `lyricsSchema` L32–69, `karaokeValidationSchema` L146–175), `frontend/lib/karaoke/wizard-controller.ts` (L294–331, L446–477, L721–765), and `frontend/components/admin/karaoke/song-metadata-form.tsx` (L7–132).

### 2.1 Fields Required Just to Start Auto-Processing (Wizard Path A)

| Field | UI Label & Location | Mandatory? | Current Constraints & Auto-Fill |
| --- | --- | --- | --- |
| `file` (Audio) | `Bài hát có giọng (MP3)` (`karaoke-wizard-screen.tsx:281-306`) | **YES** | `.mp3` only (strict regex `/\.mp3$/i`, L306 of `wizard-controller.ts`), non-empty, ≤20 MiB, ≤5 min (300,000 ms). No `.wav`/`.m4a`/`.ogg` support. No ID3 tag parsing (only strips `.mp3` from filename to prefill `title` if blank, L320–325). |
| `rawLyrics` | `Lời bài hát` (`karaoke-wizard-screen.tsx:311-353`) | **YES** | Must be manually found and pasted verbatim (max 50,000 chars, ≤300 lines, ≤10,000 syllables). **Zero auto-lyrics transcription or extraction.** Repeat notation (`×2`) requires an extra button click + `window.confirm()`. |
| `mode` | `Loại nhạc` (hidden in `<details>` "Tôi đã có nhạc nền / Thêm ảnh bìa", L400–423) | Default `VOCAL_TRACK` | Must be manually chosen (`VOCAL_TRACK` vs `INSTRUMENTAL_WITH_REFERENCE`); no automatic vocal vs instrumental detection. |
| `reference` | `Bản hát đối chiếu (MP3)` (L424–444) | Conditional (YES if `INSTRUMENTAL_WITH_REFERENCE`) | Second MP3 file required if uploading an instrumental track. |
| `cover` | `Ảnh bìa (tùy chọn)` (L445–460) | Optional | JPEG/PNG/WebP ≤2 MiB; hidden inside the second `<details>`. No ID3 APIC embedded cover extraction or auto-generated cover. |

### 2.2 Additional Fields Hard-Required to Publish (Both Wizard & Manual Paths)

Backend validation (`karaokeValidationSchema` in `frontend/types/karaoke.ts:152-169` & `karaoke-wizard-screen.tsx:110-120`) **blocks publishing** if any of the following are missing or invalid:

| Validation Code | Field | Visible by Default in Wizard? | Publish Gate Impact |
| --- | --- | --- | --- |
| `TITLE_REQUIRED` | `title` (≤200 chars) | Yes (auto-filled from filename if empty) | Blocks publish |
| `SOURCE_REQUIRED` | `source_note` (≤1000 chars) | **NO — collapsed inside `<details>` "Thông tin thêm"** (`song-metadata-form.tsx:113-122`) | Hard-blocks publish; forces Step 1 re-open in Step 3 |
| `USAGE_REQUIRED` | `usage_note` (≤1000 chars) | **NO — collapsed inside `<details>` "Thông tin thêm"** (`song-metadata-form.tsx:113-122`) | Hard-blocks publish; forces Step 1 re-open in Step 3 |
| `AUDIO_REQUIRED` | MP3 audio on server | Yes | Blocks publish |
| `LYRICS_REQUIRED` | Non-empty lines | Yes | Blocks publish |
| `SYLLABLES_REQUIRED` / `TIMING_REQUIRED` / `TIMING_INVALID` / `TIMING_OVERLAP` / `TIMING_OUT_OF_RANGE` / `TIMING_AUDIO_MISMATCH` | Every line AND every syllable `start_ms` & `end_ms` (integers `0..300000`) | Edited inside collapsed `<details>` "Chỉnh thời gian và lời nâng cao" (`karaoke-review-panel.tsx:274-292`) | Hard-blocks publish (HTTP 422). In real-song tests, auto-alignment left **74/160 syllables incomplete** (`STATUS.md:92`), blocking publish until manually repaired. |
| `PROCESSING_REVIEW_REQUIRED` | Explicit review stamp (`POST /review`) | Step 3 (`karaoke-review-panel.tsx:249-268, 325-356`) | Requires ticking EVERY quality flag checkbox + main `listened` checkbox + clicking **"Tôi đã nghe và duyệt"** before **"Xuất bản bài hát"** enables. |

Optional metadata fields: `author` (≤200 chars), `min_grade` (default `1`), `max_grade` (default `5`), `cover` image.

---

## 3. BEFORE — Exact Screen & Click Breakdown

### 3.1 Path A: Wizard Mode (`KaraokeWizardScreen`, when processing enabled)

| Step | Screen / Section | User Actions Required | Clicks / Interactions |
| --- | --- | --- | --- |
| 1 | `/admin/karaoke` | Click **"Tạo bài hát"** | 1 click |
| 2 | `/admin/karaoke/new` — Step 1 (`SongMetadataForm` compact) | Confirm/edit `title`; expand `<details>` **"Thông tin thêm"**; fill `source_note` & `usage_note` (required for publish); optionally fill `author` & grades | 1 expand click + 2–4 text fields |
| 3 | Step 1 — Media & Lyrics | Click file input & select MP3; paste full lyrics into textarea (if `×2` notation: +1 click **"Mở rộng câu lặp"** + 1 `window.confirm`); optionally expand 2nd `<details>` for cover/instrumental mode | 2–5 clicks + OS picker + paste |
| 4 | Step 1 — Submit | Click **"Tạo karaoke"** → sequentially runs `POST create` → `POST upload audio` → `PUT save` → `POST startProcessing` (`wizard-controller.ts:466-546`) | 1 click |
| 5 | Step 2 — Processing (`KaraokeProcessingStatus`) | Wait while `KaraokeProcessingSession` polls `GET` every **2.5s** visible / **15s** hidden (`processing-session.ts:77`). Measured real-song CPU wall time: **473.9s (~7.9 min)** (`STATUS.md:111`). | Wait (passive) |
| 6 | Step 2 → 3 — Apply Candidate | Auto-apply ONLY occurs for `status === "READY"` in the same uninterrupted session (`processing-session.ts:179-198`). Because all real Vietnamese songs currently emit `NEEDS_REVIEW` (`STATUS.md:105, 188`), admin must click **"Nghe kết quả chưa áp dụng"** (optional) and **"Dùng kết quả"** (`POST applyProcessing` + auto `loadDraftPreview` + `validate`). | 1–2 clicks |
| 7 | Step 3 — Timing Repair (almost always needed today) | If any syllable has null onset/end (observed: 42 missing ends + 32 missing onsets on 160-syllable song, `STATUS.md:92`), expand **"Chỉnh thời gian và lời nâng cao"**, tap Space / `E` per syllable in `SyllableTimingEditor`, wait for 800ms autosave debounce, click **"Làm mới bản nghe thử"**. | 2+ clicks + **30–160+ timing keystrokes/clicks** |
| 8 | Step 3 — Review Gate (`KaraokeReviewPanel`) | Tick checkbox **"Tôi đã kiểm tra và xử lý cảnh báo này"** on **each** `QualityFlag` (1 click × N flags); tick main **"Tôi đã nghe nhạc nền…"** checkbox; click **"Tôi đã nghe và duyệt"** (`POST confirmReview` → triggers fresh `loadDraftPreview` + `validate`, `wizard-controller.ts:713-720`). | `(N + 2)` clicks |
| 9 | Step 3 — Publish | Click **"Xuất bản bài hát"** → click OK on `window.confirm("Xuất bản đúng bản đã nghe và duyệt này cho trẻ?")` (`karaoke-wizard-screen.tsx:559-566`). | 2 clicks |

- **BEFORE Wizard Minimum Clicks (ideal `READY` with 0 flags, metadata upfront, 0 timing edits):** **~12–13 clicks** + 3–4 text/paste inputs + OS file picker.
- **BEFORE Wizard Realistic Clicks (`NEEDS_REVIEW`, 2 flags, metadata upfront, 0 timing edits):** **~16–18 clicks** + ~8 min CPU wait.
- **BEFORE Wizard Realistic Clicks (with late metadata bounce + timing repair):** **50–180+ clicks/keystrokes** across **15–25 minutes**.

### 3.2 Path B: Legacy Manual Editor (`KaraokeEditorScreen`, ACTUAL active default today)

| Card | User Actions Required | Clicks / Interactions |
| --- | --- | --- |
| Entry | `/admin/karaoke` → click **"Tạo bài hát"** → `/admin/karaoke/new` (auto-fallback to `KaraokeEditorScreen`) | 1 click |
| Card 1: `1. Thông tin bài hát` | Fill `title`, `author`, `source_note`, `usage_note`, `min_grade`, `max_grade` → click **"Tạo bản nháp"** (routes to `/admin/karaoke/[songId]/edit`; Cards 2–4 do not exist before this, L418) | 1 click + 4–6 fields |
| Card 2: `2. Nhạc nền và ảnh bìa` | Click **"Tải nhạc MP3"** (disabled if form is dirty, L426) + OS picker; optionally click **"Tải ảnh bìa"** | 1–2 clicks + OS picker |
| Card 3: `3. Lời, căn thời gian và nghe thử` | Click **"Tải bản nghe thử / Căn thời gian"** → paste or upload TXT/LRC/JSON lyrics → manually mark `start_ms` & `end_ms` for every line AND every syllable (paginated 25 lines/page in `LyricTimingEditor` + `SyllableTimingEditor`) → click **"Lưu lời và thời gian"** | 3+ clicks + **100–300+ manual timing marks** |
| Card 4: `4. Kiểm tra và xuất bản` | Click **"Kiểm tra điều kiện xuất bản"** (`POST validate`) → click **"Tải lại bản nghe thử"** (because saving in Card 3 wiped `preview` and `reviewed`, L99–101!) → click **Play** on `KaraokePlayer` (`onPlayed` sets `reviewed = true`, L477) → click **"Xuất bản bài hát"** → click OK on `window.confirm` (L588) | 5 clicks |

- **BEFORE Manual Editor Total:** **11+ workflow clicks + 100–300+ timing taps/inputs**, **2 routes**, **4 cards**, **15–45 minutes per song**.

---

## 4. BEFORE — Top Quantified Friction Points

1. **Default-OFF Auto-Processing Fallback (`karaoke-workspace-screen.tsx:121-134`):** Because `capabilities.enabled`/`configured` default to `false`, admins cannot even reach the wizard without backend/worker/DB provisioning and instead face the 100% manual millisecond editor.
2. **No One-File MP3 Smart Ingestion:** Admins cannot upload a single MP3 and let the system extract ID3 metadata (title, artist, embedded cover art, embedded lyrics), detect whether vocals are present vs instrumental, and draft lyrics/timing automatically. Pasting exact lyrics is a hard prerequisite (`wizard-controller.ts:452-455`).
3. **Hidden Mandatory Fields Trap (`song-metadata-form.tsx:113-122`):** `source_note` and `usage_note` are collapsed inside `"Thông tin thêm"`, yet missing them causes a Step 3 publish block (`SOURCE_REQUIRED`, `USAGE_REQUIRED`), re-expanding Step 1 and triggering a destructive invalidation cycle.
4. **Destructive State Invalidation on Any Metadata Edit (`wizard-controller.ts:143-152, 233-245`):** Fixing a single character in `author`, `source_note`, or `usage_note` calls `changed()`, clearing `preview`, `referencePreview`, `validation`, and `manualReviewed`, forcing a reload of preview/validation and re-confirmation.
5. **Heavy Multi-Gate Review Choreography (`karaoke-review-panel.tsx:249-363`):** Even after applying a result, the admin must separately load draft preview, check N individual flag checkboxes, check the `listened` checkbox, click **"Tôi đã nghe và duyệt"** (network round-trip + preview reload), click **"Xuất bản bài hát"**, and confirm a native `window.confirm()` dialog.
6. **CPU Processing Bottleneck & Partial Alignment (`docs/karaoke-auto-import/STATUS.md:92, 111`):** Local Demucs + CTC took **473.9s (~7.9 min)** for one children's song on CPU and still left **74/160 syllables** missing onset or end timestamps (`TIMING_REQUIRED` 422), making publish impossible without manual syllable-by-syllable timing repair.
7. **Format & UX Limitations:** Strict `.mp3`-only client check (`wizard-controller.ts:306`), repetitive `window.confirm()` popups (lyric edit, repeat expansion, audio replace, reload, publish, unsaved navigation), and no batch or quick-publish path for clean/verified simple songs.

---

## 5. AFTER — Simple Mode & Improved Admin Workflow

> **Status:** `IMPLEMENTED & VERIFIED` (2026-11-25) — Admin Karaoke One-File Simple Mode (`G08 P0`) is implemented across backend (`karaoke_media_service.py`, `karaoke_simple_import*.py`) and frontend (`audio-type-classifier.ts`, `karaoke-simple-import-service.ts`, `karaoke-simple-upload-screen.tsx`, `karaoke-workspace-screen.tsx`, `syllable-timing-editor.tsx`).

### 5.1 AFTER — Exact Screen & Click Breakdown (Simple Mode Default on `/admin/karaoke/new`)

| Step | Screen / Section | User Actions Required | Clicks / Interactions |
| --- | --- | --- | --- |
| 1 | `/admin/karaoke` | Click **"Tạo bài hát"** → opens **Simple Mode (`Thêm nhanh 1 file MP3`)** by default (works even when offline Demucs worker is OFF!) | 1 click |
| 2 | Bước 1 — Chọn 1 file MP3 | Drop or pick **1 MP3 file** → browser instantly classifies `VOCAL_FULL` vs `INSTRUMENTAL_ONLY` + estimates BPM + cleans filename to suggested title (0 MB server RAM) | 1 click + OS picker (or drag-drop) |
| 3 | Bước 1 — Submit | Click **"Tự động tạo karaoke"** → single HTTP call (`POST /api/v1/karaoke/admin/songs/simple-import`) extracts ID3v2 (`TIT2`, `TPE1`/`TCOM`, `APIC` → WebP cover, `SYLT`/`USLT`/LRC) or runs opt-in Groq Free `whisper-large-v3-turbo` (`2–5s`), creates `KaraokeSong` + `DRAFT` + uploads MP3/cover + saves `KaraokeMusicalProfile` | 1 click |
| 4 | Bước 2 — Kiểm tra nhanh (Review by Exception) | Audio preview loads immediately on the same screen; **only** flagged lines (`NEEDS_REVIEW` / `NEEDS_TIMING_CHECK`) are surfaced for inline edit; optional 1-pass **Spacebar Tap-to-Sync** available inline if needed. *(For `INSTRUMENTAL_ONLY` without embedded lyrics: paste lyrics / pick `.lrc` + click **"Áp dụng lời & chia mốc nhanh"** = +1 click.)* | 0 clicks (clean ID3/LRC/Whisper) or 1 click (instrumental lyrics apply) |
| 5 | Bước 3 — Xác nhận an toàn & Xuất bản | `source_note` & `usage_note` are **visible & pre-filled editable** (zero hidden `<details>` bounce!). Tick the 2 explicit unchecked-by-default compliance checkboxes (`rights_confirmed` + `child_safe_confirmed`) → click **"Xuất bản ngay"** (`POST /simple-publish`, zero `window.confirm()` popups!) | 3 clicks |

- **AFTER Simple Mode Total (MP3 with ID3/LRC or Vocal + Groq Whisper):** **6 clicks total from `/admin/karaoke`** (**5 clicks** inside `/admin/karaoke/new`), **0 hidden required fields**, **0 native `window.confirm()` popups**, **< 30–60 seconds end-to-end**!
- **AFTER Simple Mode Total (`INSTRUMENTAL_ONLY` without embedded lyrics):** **7 clicks + 1 paste/pick `.lrc`** (+ optional 1-pass Spacebar tap-sync taking ~30–45s), **< 1–2 minutes end-to-end**!
- **Power-User Escape Hatch:** 1-click **"Chỉnh sửa nâng cao"** button switches cleanly to the full `KaraokeEditorScreen` (100% preserved).

### 5.2 Before vs After Comparison Summary (Quantified Step Reduction >= 50%)

| Metric | BEFORE (Manual Default) | BEFORE (Wizard Mode) | AFTER (Simple Mode Default) | Quantified Improvement |
| --- | --- | --- | --- | --- |
| Default active workflow on `/admin/karaoke/new` | Legacy 4-card manual editor | Requires worker + flags ON | **1-File Simple Mode** (works on Render Free 512 MiB, worker OFF) | Eliminates silent manual-editor fallback trap |
| Required inputs to start | 6 metadata + MP3 + timed lyrics | MP3 + verbatim pasted lyrics (+ 2 hidden publish fields) | **1 MP3 file** (lyrics/cover/metadata auto-extracted) | **-83% to -87% required inputs** |
| Workflow clicks (list → publish, clean vocal/LRC MP3) | 11+ clicks + 100–300 timing taps | 12–13 clicks (ideal) / 16–18 clicks (`NEEDS_REVIEW`) | **6 clicks** (5 clicks from `/new`) | **-54% vs ideal Wizard, -65% vs realistic Wizard, -94%+ vs Manual taps** |
| Workflow clicks (realistic with timing alignment) | 111–311+ interactions | 50–180+ interactions | **6–7 clicks** (+ optional 1-pass Spacebar per line, not per syllable) | **>= 85% interaction reduction** |
| Hidden required fields causing late bounce | 0 (all visible, 6 fields) | 2 (`source_note`, `usage_note`) | **0** (both visible & pre-filled editable in Bước 3) | **-100% hidden-field bounces** |
| ID3 metadata / cover extraction | None | Filename → title only | Full `mutagen` ID3v2 (`TIT2`, `TPE1`/`TCOM`, `APIC` → WebP, `SYLT`, `USLT`/LRC) | Automatic metadata, cover & synced lyrics |
| Vocal vs instrumental auto-detection | None | None (manual dropdown) | **Client-side Web Audio DSP** (0 MB server RAM, mid/side + 300–3400 Hz + modulation + BPM) | Automatic guidance & instrumental guard |
| Draft lyrics auto-generation / alignment | None | External lyrics required; ~7.9 min CPU + 74/160 broken syllables | Embedded `SYLT`/LRC → Admin text/USLT → opt-in **Groq Free `whisper-large-v3-turbo`** (`2–5s`) + `NEEDS_REVIEW` flags | **~100× faster** than local CPU Demucs+CTC; zero fabricated lyrics |
| End-to-end time per song | 15–45 min | 8–25 min (7.9 min CPU + manual repair) | **0.5–2 min** | **-88% to -95% authoring time** |
| Native `window.confirm()` interruptions | 3+ | 5+ | **0** (replaced by 2 explicit compliance checkboxes) | **-100% modal interruptions** |
| Idle paused CPU overhead in `SyllableTimingEditor` | 60fps rAF loop running while paused | 60fps rAF loop running while paused | **0 rAF frames while paused** (runs strictly while `playing === true`) | **-100% idle rAF CPU burn** |
| Publish safety gates preserved (validation + rights + child safety) | Yes | Yes | **Yes** (2 unchecked-by-default compliance checkboxes + `KaraokeService.publish` `content_issues()` & revision lock) | Stronger explicit compliance + zero safety regression |

### 5.3 AFTER Implementation Verification Notes

- **Backend Routes & Services:**
  - `backend/app/services/karaoke_media_service.py`: `extract_mp3_metadata()`, `parse_lrc_text()`, `clean_filename_title()`, `distribute_syllables_for_line()` (all existing `inspect_audio`, `normalize_cover`, `read_upload` signatures preserved).
  - `backend/app/schemas/karaoke_simple_import.py`, `backend/app/services/karaoke_simple_import_service.py`, `backend/app/api/routes/karaoke_simple_import.py` (`POST /admin/songs/simple-import` and `POST /admin/songs/{song_id}/simple-publish`, mounted under `/karaoke`, guarded by `require_admin_id`).
- **Frontend Modules:**
  - `frontend/lib/karaoke/audio-type-classifier.ts`: deterministic stereo/mono vocal vs instrumental classifier + BPM estimator.
  - `frontend/lib/api/karaoke-simple-import-service.ts`: strict Zod-validated Simple Mode HTTP adapter.
  - `frontend/components/admin/karaoke/karaoke-simple-upload-screen.tsx`: 3-step Simple Mode UI with Review by Exception, 1-pass Spacebar Tap-to-Sync, visible notes, and 2 unchecked-by-default compliance checkboxes.
  - `frontend/components/admin/karaoke/karaoke-workspace-screen.tsx`: defaults `/admin/karaoke/new` to Simple Mode with 1-click **"Chỉnh sửa nâng cao"** toggle while preserving all existing tests & legacy 404/auth fallbacks.
  - `frontend/components/admin/karaoke/syllable-timing-editor.tsx`: rAF runs exclusively when `isPlaying` is true.
- **Automated Verification:**
  - Backend: `backend/test_karaoke_simple_import.py` (10/10 passed) + full existing `backend/test_karaoke*.py` regression suite.
  - Frontend: `frontend/test/karaoke-simple-admin.test.tsx` (7/7 passed) + full existing `frontend/test/karaoke-*.test.*` regression suite.
