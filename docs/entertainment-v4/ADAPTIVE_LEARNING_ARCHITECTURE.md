# ViRead Play & Learn V4.0 — Adaptive Learning Architecture (G03 & G11)

- **Last Updated**: 2026-11-25
- **Branch**: `feature/viread-intelligent-play-learn-v4`
- **Operational Cost**: **0 VND** (100% deterministic server computation, zero paid AI API calls)

---

## 1. Educational Philosophy & Non-Diagnostic Boundary

ViRead Adaptive Learning Engine is explicitly designed as a **formative, supportive practice companion** aligned with Vietnam's **MOET GDPT 2018 Vietnamese Language Curriculum (Grades 1–5)** and WCAG/COGA child-safe cognitive accessibility principles.

- `is_diagnostic` is permanently `False`.
- The engine **never** produces IQ estimates, medical/developmental diagnoses, or competitive child rankings.
- Every skill explicitly separates:
  - **`OBSERVED`**: `>= 2` direct high-confidence (`confidence >= 0.60`) practice observations.
  - **`ESTIMATED`**: `1` observation or low-confidence signal.
  - **`UNKNOWN`**: `0` valid observations (`mastery_pct = null`, displayed as *"Chưa đủ dữ liệu"* — never fabricated).

---

## 2. Canonical 16-Skill Taxonomy

| Domain | Skill Key | Vietnamese Label | Primary Evidence Sources |
|---|---|---|---|
| `READING_WORDS` | `phonics_decoding` | Đánh vần & nhận diện vần | Reading, Difficult Words |
| `READING_WORDS` | `difficult_word_mastery` | Làm chủ từ khó | Difficult Words, Sentence Shooter |
| `READING_WORDS` | `reading_fluency` | Đọc trôi chảy | Reading |
| `READING_WORDS` | `reading_comprehension` | Hiểu nội dung đọc | Reading |
| `LANGUAGE_GRAMMAR` | `vocabulary_naming` | Vốn từ & gọi tên sự vật | Picture Description, Memory Game |
| `LANGUAGE_GRAMMAR` | `sentence_ordering` | Sắp xếp trật tự câu | Sentence Shooter |
| `LANGUAGE_GRAMMAR` | `sentence_cloze` | Điền từ hợp ngữ cảnh | Sentence Shooter (`FILL_BLANK`) |
| `LANGUAGE_GRAMMAR` | `grammar_awareness` | Cảm nhận ngữ pháp & dấu câu | Sentence Shooter (`GRAMMAR_FOCUS`) |
| `OBSERVATION_MEMORY_CREATIVITY` | `visual_observation` | Quan sát chi tiết tranh | Picture Description, Memory Game |
| `OBSERVATION_MEMORY_CREATIVITY` | `visual_memory_recall` | Ghi nhớ hình ảnh có chủ đích | Memory Game |
| `OBSERVATION_MEMORY_CREATIVITY` | `descriptive_speaking` | Diễn đạt & miêu tả câu trọn vẹn | Picture Description |
| `OBSERVATION_MEMORY_CREATIVITY` | `story_creativity` | Tưởng tượng & kể tiếp câu chuyện | Memory Game, Picture Description (`CREATE`) |
| `OBSERVATION_MEMORY_CREATIVITY` | `inferential_thinking` | Suy luận vì sao & cảm xúc | Picture Description (`INFER`) |
| `MUSIC_RHYTHM` | `rhythm_timing` | Cảm thụ nhịp điệu | Karaoke (`FULL_MUSICAL`, `RHYTHM_AND_LYRICS`, `RHYTHM_TAP`) |
| `MUSIC_RHYTHM` | `pitch_melody` | Cảm thụ giai điệu & cao độ | Karaoke (`FULL_MUSICAL` only) |
| `MUSIC_RHYTHM` | `lyric_delivery` | Hát rõ lời & tròn vành | Karaoke |

---

## 3. Multi-Attempt Adaptive Difficulty Rule

Implemented in `backend/app/services/adaptive_learning_service.py` (`compute_adaptive_difficulty`):

1. **Grade Baseline**: `baseline = clamp(child_grade, 1, 5)`.
2. **Noise Filtering**: Only observations with `confidence >= 0.60` count toward difficulty transitions. Karaoke `INSUFFICIENT_EVIDENCE` attempts are strictly excluded.
3. **Minimum Evidence Gate**: Requires **`>= 3` high-confidence observations** before recommending any `INCREASE` or `DECREASE` (`requires_more_evidence = True` otherwise, holding at grade baseline).
4. **Recency-Weighted Average** over the 5 most recent high-confidence observations (`weights = [1, 1/2, 1/3, 1/4, 1/5]`):
   - **`INCREASE` (+1, capped at 5)**: `weighted_avg >= 0.85` AND last 2 consecutive attempts `>= 0.80`.
   - **`DECREASE` (-1, floored at 1)**: `weighted_avg <= 0.45`.
   - **`HOLD`**: All other cases.

---

## 4. Spaced Repetition of Difficult Words Across Games

Implemented in `compute_spaced_difficult_words`:
- Reads active practice history from `difficult_word_practice_attempts` (`90-day` window).
- Computes target interval per word based on mastery repetitions (`1 day -> 3 days -> 7 days`).
- Prioritizes words with past errors (`INCORRECT`/`UNCERTAIN`) and overdue intervals.
- Feeds top focus words seamlessly into:
  - **Entertainment Hub V4.0** (gentle focus badges + primary recommendation),
  - **Sentence Shooter** (prioritizes sentences containing difficult words),
  - **AI Teacher Picture Description** (`target_words` badges & recognition),
  - **AI Memory Game** (scene object bias toward difficult vocabulary),
  - **Parent Learning Analytics** (summary card inside `ProgressReportScreen`).

---

## 5. API Endpoints (`/learning`)

All endpoints require verified parent authentication (`require_parent_id`) and enforce strict ownership (`ChildProfile.ParentId == parent_id`, returning `404` for unauthorized IDs):

- `GET /learning/children/{child_id}/profile?window_days=30`
- `GET /learning/children/{child_id}/recommendations`
- `GET /learning/children/{child_id}/parent-analytics?window_days=30`
- `POST /learning/children/{child_id}/evidence`
