# Backend invariants

- Entrypoint is `backend/app/sever.py` (`app.sever:app`); never rename it to `server.py`.
- Follow `BACKEND_FLOW_STANDARD.md`: Router → Schema → Service → Repository → Model/ORM → PostgreSQL. Router does not query DB directly; Service does not write SQL/AsyncSession queries directly.
- Preserve locked OCR ABI pins in `requirements.txt` unless the task explicitly changes them: `numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`.
- Keep heavy OCR imports lazy/guarded in `app/services/ocr_engine.py`; map external-provider failures to safe application errors.
- Supabase service-role/secret keys stay backend-only; store relative object paths, not signed URLs.
