---
name: viread-architecture
description: >-
  Use this skill first when navigating the ViRead (ReadAlong Vision) repository, planning multi-layer changes across Next.js, FastAPI, Supabase, OCR, or Speech/AI modules, or locating exact files to edit without scanning the whole codebase.
---

# ViRead Architecture & Fast File Routing

ViRead (`ReadAlong Vision`) helps Vietnamese children practice reading with Dual-Engine OCR and live Speech-to-Text alignment.

## 1. Progressive Context Discovery (Save Tokens)

Before running broad `grep` or reading many source files in `F:\c1\capstone1`:

1. **Query Graphify first** if `graphify-out/graph.json` exists:
   ```powershell
   Set-Location "F:\c1\capstone1"
   .\.venv\Scripts\python.exe -m graphify query "<focused question>" --budget 1200
   .\.venv\Scripts\python.exe -m graphify explain "<ModuleOrClass>"
   .\.venv\Scripts\python.exe -m graphify path "<SourceNode>" "<TargetNode>"
   ```
2. **Consult authoritative docs only as needed**:
   - System & guardrails: [Agent.md](../../../Agent.md)
   - Backend layering contract: [BACKEND_FLOW_STANDARD.md](../../../BACKEND_FLOW_STANDARD.md)
   - Next.js 16 breaking rules: [frontend/AGENTS.md](../../../frontend/AGENTS.md)
   - OCR & Supabase storage setup: [backend/ADMIN_BOOKS_OCR_SETUP.md](../../../backend/ADMIN_BOOKS_OCR_SETUP.md)
   - Figma tokens & route inventory: [frontend/FIGMA_ALIGNMENT_AUDIT.md](../../../frontend/FIGMA_ALIGNMENT_AUDIT.md)

## 2. Critical Guardrails (Never Violate)

- **FastAPI entrypoint spelling**: `backend/app/sever.py` (`app.sever:app`). **Never** rename `sever.py` to `server.py`.
- **Locked Python ABI dependencies** in `backend/requirements.txt`:
  - Keep `numpy==1.26.4` (never 2.x), `protobuf==3.20.2` (`<4.0.0`), `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`.
- **Backend layered flow** (`BACKEND_FLOW_STANDARD.md`):
  `Router -> Request Schema -> Service -> Repository -> Model/ORM -> PostgreSQL -> Response Schema`.
  Routers must not query `AsyncSession` or contain business logic; Services must not write raw SQL/ORM queries directly.
- **Supabase private storage & secrets**:
  - Store only relative object paths in `bookpages.imagepath` (never temporary signed URLs).
  - Keep `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY` strictly on Backend; never expose in `NEXT_PUBLIC_*` or commit `.env*`.
  - Map external provider failures to safe error codes (`SPEECH_UNAVAILABLE`, `STT_QUOTA_EXCEEDED`, `UNSUPPORTED_AUDIO`).

## 3. Domain-to-File Map

| Domain | Frontend (`frontend/`) | Backend (`backend/app/`) |
| :--- | :--- | :--- |
| **App Entry & Auth** | `app/(auth)/*`, `proxy.ts`, `lib/api/*` | `sever.py`, `api/deps.py`, `api/routes/profile.py` |
| **Book Catalog & Admin OCR** | `app/admin/books/*`, `app/books/*` | `api/routes/admin_ocr.py`, `api/routes/book.py`, `services/admin_ocr_service.py`, `services/ocr_engine.py` |
| **Live Child Reading** | `components/reading/reading-screen.tsx`, `book-page-viewer.tsx`, `book-page-content.tsx`, `lib/reading/realtime-alignment.ts` | `api/routes/voice.py`, `api/routes/reading.py`, `providers/*` |
| **Assessment & Reports** | `app/sessions/[sessionId]/report/*`, `components/reading/ReadingReport.tsx`, `lib/api/comparison-service.ts` | `services/text_alignment.py`, `services/reading_comparison_service.py`, `services/reading_assessment.py` |
| **Reading Management & Progress** | `app/reading-management/*`, `app/reports/*` | `api/routes/reading_management.py`, `api/routes/child_progress.py`, `services/child_progress_service.py` |
| **Entertainment & Tutor** | `app/karaoke/*`, `app/entertainment/*` | `api/routes/karaoke.py`, `api/routes/picture_description.py`, `api/routes/sentence_shooter.py`, `api/routes/tutor_question.py` |

## 4. Post-Edit Maintenance

When modifying source code in `capstone1`, update the AST graph incrementally (zero API cost):
```powershell
Set-Location "F:\c1\capstone1"
.\.venv\Scripts\python.exe -m graphify update .
```
