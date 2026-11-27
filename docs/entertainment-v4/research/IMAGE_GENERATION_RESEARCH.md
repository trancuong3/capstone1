# Image & Visual Scene Generation Research — Picture Storytelling & AI Memory Game

**Date:** 2026-11-25  
**Scope:** Zero-cost, child-safe, instant, copyright-clean visual scene generation with **verifiable structured ground truth** for ViRead Play & Learn V4.0's **AI Teacher / Picture Storytelling** and **AI Memory Game** (Vietnamese primary Grades 1–5).  
**Codebase Baseline:** Branch `feature/viread-intelligent-play-learn-v4`, SHA `29e2da36`.

---

## 1. Problem Statement

Both **AI Teacher / Picture Storytelling** and the new **AI Memory Game** depend on rich, diverse, age-appropriate Vietnamese illustrations:
- In **Picture Storytelling**, children quickly memorize the same 3 static sample images, reducing replayability and vocabulary growth.
- In **AI Memory Game** (observe a scene for $N$ seconds → scene hides → answer recall questions about **objects, colors, counts, spatial positions, and actions**), **100% factual ground truth is non-negotiable**:
  - If a generative diffusion model is prompted for *"3 red apples on a wooden table next to a blue cat"*, diffusion models notoriously miscount (rendering 4 apples or a grey cat) or distort hands/text. If a question then asks *"Có bao nhiêu quả táo đỏ?"* expecting `3` when the image actually shows `4`, the child is **unfairly marked wrong** — destroying educational trust!
- Additionally, ViRead must operate at **0 VND / $0/month**, stay within **Supabase Free 1 GB Storage & 5 GB Egress**, avoid slow 8–20 second image-generation loading spinners on mobile, and guarantee **100% child safety** with zero chance of NSFW/disturbing artifacts.

---

## 2. Existing Implementation Audit

A full audit of `backend/app/services/picture_description_service.py` and `backend/app/assets/picture_description/` on SHA `29e2da36` reveals:
1. **Only 3 static sample JPEGs exist** (`backend/app/assets/picture_description/`):
   - `sunny-garden.jpg` (185,544 bytes)
   - `lakeside-picnic.jpg` (214,353 bytes)
   - `happy-classroom.jpg` (183,050 bytes)
2. **Existing `SourceType` enum (`supabase/migrations/20261115120000_picture_description.sql:10`):**
   - `sourcetype varchar(24) not null check (sourcetype in ('BOOK_PAGE', 'CUSTOM_UPLOAD', 'SAMPLE'))`.
   - `SAMPLE` sessions currently still call `ai_client.analyze_picture()` first (`picture_description_service.py:540`) and only fall back to `spec.default_guide` on retryable AI errors!
3. **Existing Book Pages:** `BOOK_PAGE` pulls verified pages from `BookPage` matching `child_grade` and generates Supabase signed URLs (`create_signed_image_url`), which consumes Supabase Storage egress and often shows text-heavy book pages rather than clean visual-memory scenes.
4. **Existing Image Libraries Installed:**
   - Backend (`requirements-web.txt` & `.venv`): `pillow==12.0.0` (can rasterize or serve PNG/WebP if ever needed, though SVG/Canvas runs natively on frontend with ~5–15 KB payloads!).
   - Frontend: Native browser **SVG + HTML5 Canvas** (zero external runtime dependencies, infinite crispness on Retina/Android screens, `< 15 KB` per scene!).

---

## 3. Candidate Visual Generation Approaches

| Candidate | Cost / Free Quota (Verified 2026-11-25) | Ground-Truth Verifiability (Counts, Colors, Positions) | Latency | Child Safety | Supabase Storage & Egress Impact | Replay Variety |
|---|---|---|---|---|---|---|
| **A. Deterministic Parametric SVG / Canvas Scene Composer (Procedural Vector Engine)** | **$0 / Unlimited** (runs in TypeScript/React SVG or Python JSON spec) | **100% Mathematically Exact** — the exact JSON `SceneSpec` drives *both* SVG rendering AND question/answer/rubric generation! | **< 16 ms** (instant, works offline) | **100% Deterministic Safe** (curated kid-friendly vector sprites, zero NSFW/gore risk) | **~2–8 KB JSON** (0 bytes in Supabase Storage bucket!) | **Thousands of unique scenes** via seeded combinations of backdrops, weather/time, characters, animals, objects, colors, counts, positions, and actions |
| **B. Curated Static Illustrated Pack + Hand-Verified Ground-Truth JSON** | **$0** (bundled in `frontend/public/images/` or SVG assets) | **100% Exact** (human-verified JSON per scene), but fixed finite count | **Instant** (CDN/static cached) | **100% Safe** | Static Vercel asset (0 Supabase Storage) | Limited (e.g., 10–20 scenes; child memorizes after 1–2 weeks) |
| **C. Cloudflare Workers AI (`@cf/black-forest-labs/flux-1-schnell`)** | **10,000 Neurons/day free** (~4.8 neurons/512px tile + 9.6/step → ~200–250 small images/day max) | **Low (Unverifiable without VLM re-audit)** — diffusion frequently miscounts objects, swaps colors, or blends spatial relations | 3–8 seconds | Moderate (needs safety classifier + VLM check) | High if cached in Supabase Storage (150 KB × images eats 1 GB cap & 5 GB egress) | High visual richness, inconsistent art style |
| **D. Pollinations AI (`image.pollinations.ai`)** | Free fair-use public endpoint (no SLA) | **Low (Unverifiable)** — same diffusion counting/color hallucination issue | 4–15 seconds (variable) | **Risky for children** (no enterprise SLA, public prompt visibility, occasional distorted anatomy/text) | High if cached; broken images if upstream down | High |
| **E. Hugging Face Serverless Inference API** | **No recurring free monthly credits** for free accounts (restructured to paid PRO / pay-as-you-go credits as of 2025–2026) | Low (Unverifiable) | 5–20 seconds | Moderate | High | Eliminated by 0 VND constraint |
| **F. Paid Image APIs (OpenAI `gpt-image-1`, Imagen 3/4, Midjourney)** | Paid per image ($0.02–$0.08/image) | Low-Medium | 5–12 seconds | High | High | Eliminated by 0 VND constraint |

---

## 4. Pros, Cons, Cost, Risks & Educational Impact

### Deep-Dive on Candidate A: Deterministic Parametric SVG Scene Engine with Verifiable Ground Truth
How it works:
1. A deterministic seeded generator (`seed` + `theme` + `difficulty` + `child_grade`) builds a canonical **`SceneSpec` JSON**:
   - **Backdrop & Atmosphere (Vietnamese cultural & everyday themes):**
     1. *Khu vườn nắng mai* (Sunny Vietnamese garden)
     2. *Lớp học vui vẻ* (Primary classroom)
     3. *Bãi biển mùa hè* (Summer beach)
     4. *Công viên cuối tuần* (Weekend park)
     5. *Gian bếp ấm cúng* (Cozy family kitchen)
     6. *Nông trại xanh* (Green farm / countryside)
     7. *Bầu trời đêm trăng rằm* (Mid-Autumn / starry night sky)
     8. *Thư viện sắc màu* (Colorful school library)
   - **Time / Weather:** sáng nắng vàng, chiều hoàng hôn, trời có mây, đêm trăng sao (with verifiable sky color & celestial count).
   - **Typed Entities (`SceneEntity[]`):** Each entity has `{ id, kind, label_vi, color_key, color_vi, position_zone: 'left'|'center'|'right'|'top'|'bottom', count, action_vi, size, x, y }`, placed with **non-overlapping bounding-box collision checks** so every single object is 100% visible, unoccluded, and unambiguous!
2. **Zero-Hallucination Ground Truth Derivation:**
   - **Counting Questions:** `count(entities where kind == 'apple' && color == 'red')` — guaranteed 100% true to pixels rendered.
   - **Color Recall:** `entity.color_vi` — drawn from an accessible, high-contrast colorblind-safe palette (red, bright blue, sunny yellow, emerald green, orange, purple, brown, white) with distinct shapes.
   - **Spatial Position:** `left` / `center` / `right` / `on top of` / `under` — enforced by strict layout slots with minimum separation margin.
   - **Action / Storytelling Ground Truth:** Feeds directly into Picture Storytelling's `PictureGuideRead` (`scene_title`, `guiding_questions`, `suggested_vocabulary`, `model_sample_sentences`) and lets the evaluator verify every detail the child mentioned without even needing a multimodal image-token upload!
3. **Visual Quality Craft (Not Ugly Geometric Boxes!):**
   - Hand-crafted, warm storybook **vector sprite library** (flat pastel/gouache children's book illustration style with soft gradients, expressive faces, rounded corners, layered shadows, clouds, trees, Vietnamese details like *đèn ông sao*, *nón lá*, *hoa sen*, *mèo cam*, *cún con*, *bảng xanh*, *quả bóng*, *diều giấy*).
   - Optional subtle idle animations (gentle cloud drift, blinking eyes, swaying leaves) that **pause during strict memory freeze** or when `prefers-reduced-motion` is enabled.

### Pros & Cons
- **Pros:**
  - **100% Verifiable Ground Truth** — impossible for the AI Memory Game to contradict the picture.
  - **0 VND forever**, **< 16 ms render**, **works offline**, **0 bytes Supabase Storage**, **0% NSFW risk**.
  - **Adaptive Difficulty Scaling (Grades 1–5):**
    - Level 1 (Grade 1 / Easy): 3–4 distinct large objects, 10s observation, 2–3 simple questions (object presence, primary color, small count 1–3).
    - Level 2 (Grades 2–3 / Medium): 5–6 objects, 8s observation, 4 questions (counts up to 5, color-object binding, left/right position).
    - Level 3 (Grades 4–5 / Challenge): 7–9 objects, 7s observation, 5 questions (multi-attribute conjunction *"con vật nào màu cam ở bên phải?"*, action recall, difference/missing-item recall *"Vật nào vừa biến mất?"*).
  - **Seamless Bridge to Picture Storytelling:** After finishing a Memory round, the child can click **"Kể chuyện về bức tranh này"** (or vice versa), reinforcing vocabulary across retrieval + storytelling!
- **Cons:**
  - Vector storybook illustrations have a distinct stylized aesthetic rather than photorealism.
  - Initial engineering effort to craft ~30–40 charming reusable SVG sprites and 6–8 layered Vietnamese backdrops (well within V4.0 scope and 100% copyright-owned by ViRead).

### Risks & Mitigations
1. **Risk: Visual Clutter / Overlapping Sprites Breaking Count Honesty.**
   - *Mitigation:* Strict slot-based layout grid with bounding-box collision assertions + automated unit test verifying every rendered `SceneEntity` is inside viewport `[0.06..0.94]` and has zero >15% overlap with any other foreground entity.
2. **Risk: Color Ambiguity (e.g., teal vs green/blue, pink vs red).**
   - *Mitigation:* Use a strict **6-color canonical Vietnamese palette** (`đỏ`, `xanh dương`, `vàng`, `xanh lá`, `cam`, `tím`) with large perceptual Delta-E separation and never place two ambiguous shades in the same question's distractors.
3. **Risk: Missing Real-World Photo Variety in Picture Storytelling.**
   - *Mitigation:* Keep existing `SAMPLE` (3 curated JPEGs), `BOOK_PAGE` (verified textbook illustrations), and `CUSTOM_UPLOAD` (parent-uploaded family/book photos) fully intact, and add `PROCEDURAL` scenes as an unlimited zero-cost companion mode!

### Educational Impact (Vietnamese Primary Grades 1–5)
- **Visual Working Memory & Selective Attention:** Scientifically grounded observation → delay → active retrieval (Roediger & Karpicke retrieval practice) with zero cognitive overload (controlled object count 3–9 matching Cowan's working-memory capacity $4 \pm 1$ chunks for young learners).
- **Vietnamese Vocabulary & Descriptive Syntax:** Every entity carries grade-appropriate Vietnamese noun + color + action + spatial prepositions (`bên trái`, `bên phải`, `ở giữa`, `trên`, `dưới`), reinforcing GDPT 2018 primary Vietnamese observation and sentence-building skills.
- **Spotlight-the-Answer Review:** When a child misses a memory question, the SVG highlights the *exact* entity on the scene with a gentle pulse (`entity.id`) so the child visually verifies the honest answer immediately!

---

## 5. Selected Recommendation

Adopt a **Hybrid Visual Scene Architecture** anchored by a **Deterministic Parametric SVG Scene Composer**:

1. **Primary Engine for AI Memory Game & Procedural Storytelling — Deterministic Parametric SVG Composer:**
   - Canonical `SceneSpec` generated deterministically from `(theme, difficulty, seed, child_grade)` (shared schema between backend & frontend, persisted cleanly in PostgreSQL `jsonb` — only ~2–4 KB per session, zero Storage bucket bloat).
   - 6–8 Vietnamese child-friendly layered SVG themes × 35+ handcrafted vector sprites × 6 canonical high-contrast colors × collision-free layout slots = **>10,000 verifiable scenes** with **100% exact ground truth** for counting, color, spatial, action, and "what disappeared?" visual recall.
   - Instant visual spotlight feedback: every question links to `target_entity_ids` so after answering, the exact object(s) glow on the revealed scene.
2. **Retain Existing Real-Image Modes for Picture Storytelling:**
   - Keep `SAMPLE` (3 existing JPEGs — and serve `spec.default_guide` directly on `SAMPLE` session creation instead of burning a redundant Gemini Vision call!), `BOOK_PAGE`, and `CUSTOM_UPLOAD`.
   - Optionally add `PROCEDURAL` (additive DB check constraint update or dedicated memory/procedural scene sessions) so Picture Storytelling also gains unlimited fresh Vietnamese scenes at **$0 cost**.
3. **Explicitly Reject Unverified Free Diffusion APIs (Pollinations, unverified FLUX) for Memory Game:**
   - Never use diffusion-generated images for objective counting/color/position grading; keep Cloudflare Workers AI (`flux-1-schnell`) only as a strictly optional future offline Admin asset-creation tool with human review.

---

## 6. Rollback Strategy

- Procedural SVG scenes and the AI Memory Game are **100% additive** (new routes/tables/components). Existing `SAMPLE`, `BOOK_PAGE`, and `CUSTOM_UPLOAD` flows in `picture_description_service.py` remain untouched in behavior and schema.
- If `PROCEDURAL` mode is toggled off via feature flag, Picture Storytelling continues serving its 3 curated JPEGs, verified book pages, and custom uploads without migration rollback.

---

## 7. Citations & Verification Sources (Accessed 2026-11-25)

1. Cloudflare Workers AI — Models (`@cf/black-forest-labs/flux-1-schnell`) & Pricing (10,000 Neurons/day free tier; 4.80 neurons/tile + 9.60 neurons/step): https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/ and https://developers.cloudflare.com/workers-ai/platform/pricing/ (accessed 2026-11-25).
2. Hugging Face Inference Providers — Pricing & Free Account Credit Policy (no recurring free monthly credits on free tier): https://huggingface.co/docs/inference-providers/pricing (accessed 2026-11-25).
3. Pollinations AI — Public Image Endpoint & Documentation (fair-use free tier without enterprise SLA): https://pollinations.ai/ (accessed 2026-11-25).
4. Supabase Free Tier Limits (500 MB DB, 1 GB Storage, 5 GB Egress): https://supabase.com/pricing (accessed 2026-11-25).
5. Codebase Audit (SHA `29e2da36`): `backend/app/services/picture_description_service.py` (`SAMPLE_CATALOG`, `L83-175`, `create_session`, `L459-607`), `backend/app/assets/picture_description/`, `supabase/migrations/20261115120000_picture_description.sql`.
