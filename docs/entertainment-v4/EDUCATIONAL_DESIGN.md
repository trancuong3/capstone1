# ViRead Play & Learn V4.0 — Educational & Child-First UX Design (G04)

- **Last Updated**: 2026-11-25
- **Target Learners**: Vietnamese primary school students, Grades 1–5 (ages 6–11)
- **Curriculum Alignment**: MOET GDPT 2018 Vietnamese Language + Dialogic Reading (PEER/CROWD) + Working Memory Capacity Limits

---

## 1. Four-Zone Play & Learn Architecture

The Entertainment Hub (`frontend/components/entertainment/entertainment-screen.tsx`) organizes entertainment into four balanced cognitive and expressive zones:

1. **Thế giới kể chuyện** (`Kể chuyện qua tranh` — `/entertainment/picture-description`):
   - Dialogic visual storytelling with AI Teacher V4.0 across 6 scaffolding modes (`OBSERVE`, `VOCABULARY`, `SENTENCE`, `STORY`, `INFER`, `CREATE`).
   - Grade-fading hints (prominent audio/visual cues for Grades 1–2; collapsed optional hints for Grades 4–5).
2. **Phiêu lưu cùng chữ** (`Xạ thủ ghép câu` — `/entertainment/sentence-shooter`):
   - Instant tactile cannon firing (`<100ms` visual response decoupled from server RTT) across 3 modes (`WORD_ORDER`, `FILL_BLANK`, `GRAMMAR_FOCUS`), integrating difficult words from the child's reading books.
3. **Sân khấu âm nhạc** (`Hát vui cùng bé` — `/karaoke`):
   - True musical DSP feedback (rhythm + octave-invariant pitch/melody + lyrics + fluency), supporting headphones and speaker modes, `RHYTHM_TAP`, `LINE_PRACTICE`, and `0.85x` focused segment looping.
4. **Khám phá trí nhớ** (`Bé nhớ được gì?` — `/entertainment/memory-game`):
   - Deterministic Vietnamese SVG scenes with grade-capped object complexity (`G1 <= 4`, `G2–3 <= 6`, `G4–5 <= 9`), child-selected observation timers (starting strictly post-render, including `UNLIMITED`), progressive hints, separate factual vs creative scoring, and interactive bounding-box reveal spotlights.

---

## 2. Anti-Dark-Pattern & Sensory Comfort Commitments

- **Zero manipulative retention mechanics**: No punishing streak loss, no artificial energy lives, no loot boxes, no flashing countdown anxiety.
- **Natural healthy break cues**: `Cú Mèo ViRead` mascot gently reminds children to rest their eyes after 10–15 minutes or 4 daily activities.
- **Touch & Sensory Accessibility (WCAG 2.2 AA / COGA)**:
  - Minimum `48px` (`min-h-12`) interactive tap targets on hub controls and game buttons.
  - Persistent 1-tap `Giảm chuyển động` (`prefers-reduced-motion` aware) and `Âm thanh dịu` controls.
  - Calm 3-step interactive onboarding on first visit, re-openable anytime via `Hướng dẫn chơi`.
- **Voice Lifecycle Safety**: Whenever TTS speaks, active microphone recognition pauses immediately so AI instructions are never captured as child speech; backgrounding (`visibilitychange` / `viread:android-background`) releases mic and audio cleanly.
