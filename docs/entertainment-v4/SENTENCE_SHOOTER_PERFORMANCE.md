# Real-Time Sentence Shooter V4.0 — Architecture, Performance & Verification (G06)

- **Date:** 2026-11-25
- **Branch:** `feature/viread-intelligent-play-learn-v4`
- **Owner:** `eng-shooter` (Track C / G06)
- **ADR Reference:** `docs/entertainment-v4/research/ARCHITECTURE_DECISION_RECORDS.md` (ADR-03)

---

## 1. Executive Summary

Sentence Shooter V4.0 eliminates tap-blocking HTTP round-trip latency and forced synchronous layout reflows while preserving 100% server-authoritative scoring, idempotency, and backward compatibility.

| Metric / Capability | BEFORE (V3 Baseline) | AFTER (V4.0 Verified) | Improvement |
| --- | --- | --- | --- |
| **Tap-to-visible-feedback (under 500ms RTT)** | Blocked on full HTTP RTT (`500ms+`, up to `20,000ms` timeout) | **13.69–19.96 ms** (max `19.96 ms` measured across 3 rapid taps; `<30 ms` target, `<100 ms` p95 budget) | **~25×–36× faster** perceived response |
| **Rapid consecutive taps during slow network** | Dropped / blocked globally (`actionLockRef` + `disabled={isBusy}` on all tokens) | **Non-blocking bounded FIFO queue** (`MAX_QUEUED_SHOTS = 6`); only the tapped bubble locks (`in-flight`), all other bubbles stay interactive | **Zero UI freeze** |
| **Forced synchronous layout reflows per tap** | `2×` `getBoundingClientRect()` pairs (`selectToken` + `animateShot`) | **`0` calls** on cached taps (`StageLayoutCache` via `ResizeObserver` + `rAF` + stable per-round ref callbacks) | **100% eliminated** on tap path |
| **Web Audio `AudioContext` allocations** | `new AudioContext()` + `close()` on every single SFX; muted by default | **1 lazy singleton `AudioContext`** reused across all shots; clean `suspend()` on `viread:android-background`/`visibilitychange` and `close()` on unmount | **O(1) lifecycle** |
| **Server idempotency & anti-double-score** | `request_id` UUID only | Deterministic UUID resolution supporting both `client_shot_id` and `request_id` (`uq_gameattempts_session_request`) | Retries never double-score |
| **Pedagogical modes** | `WORD_ORDER` only | **`WORD_ORDER`**, **`FILL_BLANK`** (1–2 blanks + distractors), **`GRAMMAR_FOCUS`** (punctuation / connectors / action words + post-round Vietnamese `grammar_tip`) | 3 adaptive GDPT 2018 modes |
| **Difficult-word integration & evidence** | Isolated from reading history | Prioritizes sentences with active difficult words (`difficult_word_practice_attempts` + `focus_words`), exposes `practiced_difficult_words`, writes `learning_skill_evidence` gracefully | Closed-loop Play & Learn |

---

## 2. Frontend Real-Time Architecture

### 2.1 Decoupled Input vs. Server Reconciliation (`shot-queue.ts`)

```text
Child taps word bubble
  ├─ Synchronous (< 20 ms, 0 reflows, 0 HTTP wait)
  │    ├─ OrderedShotQueue.enqueue(sessionId, roundId, token)
  │    │    ├─ Blocks duplicate taps on the SAME bubble (in-flight guard)
  │    │    ├─ Assigns (roundEpoch, clientShotId)
  │    │    └─ Emits pendingShots -> optimistic slot preview + bubble in-flight state
  │    ├─ StageLayoutCache.getTrajectory(token.id)  [O(1) cached coords, 0 getBoundingClientRect()]
  │    ├─ Aim ToyCannon + spawn GPU transform projectile & burst particles (respects prefers-reduced-motion)
  │    └─ playShooterSound("shot") via singleton AudioContext
  │
  └─ Asynchronous Ordered FIFO Worker (1 HTTP POST /shots on wire at a time)
       ├─ Sends { round_id, token_id, request_id: clientShotId, client_shot_id: clientShotId }
       ├─ Stale epoch? (round completed / next round / exit / unmount) -> Discard silently
       ├─ is_correct === true  -> Promote token to server-confirmed placedTokens, update score/stars, prefetch next_round
       │    └─ round_completed === true -> Increment roundEpoch, cancel trailing queued shots (zero 409s!)
       ├─ is_correct === false -> Shift head shot only, wobble bubble, roll back optimistic slot, immediately drain next queued shot
       └─ Network error        -> Preserve clientShotId in pendingRetry for exact idempotent retry on same bubble
```

### 2.2 Zero-Reflow Coordinate Caching (`stage-layout-cache.ts`)

- Observes `arena` and `cannon` via `ResizeObserver` plus passive `resize`/`scroll` listeners, batching all geometry reads into a single `requestAnimationFrame` callback (`measureNow()`).
- Uses memoized per-round `tokenRefCallbacks` (`useMemo` keyed on `[layoutCache, round]`) so React re-renders during rapid tapping never detach/re-attach button refs or invalidate cached coordinates.
- Verified in Vitest via `vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")`: **0 calls** across 3 rapid consecutive taps.

### 2.3 Singleton Web Audio Engine (`sound-engine.ts`)

- Single lazily created `AudioContext` reused across `shot`, `correct`, `wrong`, and `celebrate` cues.
- Disconnects finished oscillator/gain nodes on `onended`.
- Respects mute toggle (`soundEnabled`) and `prefers-reduced-motion`.
- Listens to `document` `"viread:android-background"` (Android WebView `MainActivity.onStop()`) and `"visibilitychange"` to suspend cleanly, and closes the singleton on component unmount.

---

## 3. Backend Modes, Difficult Words & Evidence Architecture

### 3.1 Owned Backend Files Modified

- `backend/app/schemas/sentence_shooter.py`: Additive optional fields (`learning_mode`, `focus_words`, `prompt_slots`, `practiced_difficult_words`, `prompt_hint`, `client_shot_id`, `grammar_tip`, `score`, `is_difficult_word`). Zero breaking changes to legacy payloads.
- `backend/app/services/games/sentence_shooter_service.py`:
  - **Difficult-Word Prioritization:** Merges explicit `focus_words` with active unmastered child words from `difficult_word_practice_attempts` and prioritizes candidate sentences by difficult-word match count before shuffling within equal-priority tiers.
  - **`WORD_ORDER`:** Full backward compatibility with verified sentence extraction, token shuffling, and zero answer-order leakage.
  - **`FILL_BLANK`:** Selects 1 blank (`easy` / `<5` tokens) or 2 blanks (`medium`/`challenge`), prioritizing difficult words first, generates grade-appropriate book/Vietnamese distractors, and validates blanks left-to-right.
  - **`GRAMMAR_FOCUS`:** Targets Vietnamese terminal punctuation (`.`, `!`, `?`), connectors (`và`, `nhưng`, `vì`, `nên`, `đang`, `đã`, `sẽ`, ...), or primary action words (`đọc`, `viết`, `học`, ...) with contrasting distractors and a child-friendly 1-sentence Vietnamese `grammar_tip` revealed **only after round completion**.
  - **Zero-Migration Metadata Storage:** Stores additive `_v4_meta` inside existing `GameRound.TokensSnapshot` JSONB without modifying `GameSession`/`GameRound` table DDL.
  - **Idempotent Anti-Double-Score:** `resolve_shot_request_uuid(request_id, client_shot_id)` maps `client_shot_id` deterministically onto `GameAttempt.RequestId` (`uq_gameattempts_session_request`) so network retries with the same `client_shot_id` (even without or with different `request_id`) return the exact cached snapshot without re-scoring.
- `backend/app/repositories/sentence_shooter_repository.py`:
  - `active_difficult_words(child_id)`: Reads recent `difficult_word_practice_attempts` safely; gracefully rolls back and returns `[]` if table is absent.
  - `record_learning_evidence(entries)`: Writes compact `LearningSkillEvidence` rows (`sentence_ordering`, `sentence_cloze`, `grammar_awareness`, and `difficult_word_mastery` when difficult words were practiced) in an isolated post-commit step so unmigrated environments or duplicate dedupe keys never disrupt gameplay.
- `backend/app/api/routes/sentence_shooter.py`: Forwards `payload.effective_request_id` and `client_shot_id` to `SentenceShooterService.shoot`.

---

## 4. Verification & Measured Test Proof

### 4.1 Backend Verification (`pytest`)

Command:
```powershell
backend\.venv\Scripts\python.exe -m pytest backend/test_sentence_shooter.py -v
```

Result (**2026-11-25**):
- **38 / 38 tests PASSED** in **2.77s** (`0 failed`, `0 skipped`).
- Verified coverage:
  - All 31 legacy regression tests (extraction, Unicode tones, shuffling, expiration safety, auth, concurrency, single-query lock bundle, prefetched `next_round`).
  - `WORD_ORDER` backward compatibility + `sentence_ordering` evidence.
  - `FILL_BLANK` 2-blank medium round, distractors rejected without advancing position, `sentence_cloze` + `difficult_word_mastery` evidence.
  - `GRAMMAR_FOCUS` punctuation/connector/action focus, `grammar_tip` withheld until completion, `grammar_awareness` evidence.
  - Difficult-word sentence prioritization & exposure on session, round, shot, and result.
  - Duplicate `client_shot_id` deduplication (with differing or omitted `request_id`) — zero double-scoring.
  - Graceful fallback when `difficult_word_practice_attempts` or `learning_skill_evidence` tables do not exist.

### 4.2 Frontend Verification (`Vitest`, `ESLint`, `Prettier`)

Commands:
```powershell
Set-Location frontend
npx prettier --write types/sentence-shooter.ts lib/api/sentence-shooter-service.ts components/entertainment/sentence-shooter/sentence-shooter-screen.tsx components/entertainment/sentence-shooter/shot-queue.ts components/entertainment/sentence-shooter/sound-engine.ts components/entertainment/sentence-shooter/stage-layout-cache.ts test/sentence-shooter-ui.test.tsx
npx eslint types/sentence-shooter.ts lib/api/sentence-shooter-service.ts components/entertainment/sentence-shooter/sentence-shooter-screen.tsx components/entertainment/sentence-shooter/shot-queue.ts components/entertainment/sentence-shooter/sound-engine.ts components/entertainment/sentence-shooter/stage-layout-cache.ts test/sentence-shooter-ui.test.tsx
npx vitest run test/sentence-shooter-ui.test.tsx
```

Results (**2026-11-25**):
- **Prettier:** All 7 touched frontend files formatted cleanly.
- **ESLint:** **0 errors, 0 warnings** (including strict React 19 `react-hooks/refs` compliance).
- **Vitest:** **10 / 10 tests PASSED** in **9.19s**:
  - All 5 baseline regression tests preserved.
  - **500ms slow-network stress test:** Rapidly tapped 3 consecutive words while Shot 1 was still pending on a 500ms network delay; measured tap-to-visible-feedback timings:
    - Tap 1: **`13.69 ms`**
    - Tap 2: **`16.71 ms`**
    - Tap 3: **`19.96 ms`**
    - Max observed: **`19.96 ms`** (well below `<30 ms` visual goal and `<100 ms` p95 budget).
    - `getBoundingClientRect()` calls during all 3 cached taps: **`0`**.
    - Max concurrent `/shots` HTTP requests: **`1`** (strict FIFO ordering verified).
  - **Surgical rollback test:** Wrong tap followed immediately by right tap rolled back only the wrong bubble with wobble animation while cleanly validating the queued right tap next.
  - **Stale-epoch cancellation test:** Completing a round immediately cancelled trailing queued taps so they were never dispatched.
  - **Singleton `AudioContext` test:** Constructed **1 time** across multiple shots + verdict cues, honored mute, called `suspend()` on `viread:android-background`, and called `close()` on unmount.
  - **Learning modes & post-round pedagogy test:** Verified 3-mode lobby selector, `GRAMMAR_FOCUS` prompt slots, subtle difficult-word badge, `grammar_tip` pill, and `Nghe lại câu hoàn chỉnh` TTS readout button.
