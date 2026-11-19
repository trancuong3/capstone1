# Backend invariants

- Entrypoint is `backend/app/sever.py` (`app.sever:app`); never rename it to `server.py`.
- For new or deliberately refactored backend flow, follow `BACKEND_FLOW_STANDARD.md`: Router → Schema → Service → Repository → Model/ORM → PostgreSQL. First trace the actual imports/calls. Do not widen a focused fix into an unrelated architecture refactor merely to enforce the standard; preserve existing API behavior unless the task asks for architectural change.
- Preserve locked OCR ABI pins in `requirements.txt` unless the task explicitly changes them: `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`.
- Keep heavy OCR imports lazy/guarded in `app/services/ocr_engine.py`; map external-provider failures to safe application errors.
- Supabase service-role/secret keys stay backend-only; store relative object paths, not signed URLs.
