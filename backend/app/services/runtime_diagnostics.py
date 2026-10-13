"""Internal, read-only diagnostics for Supabase Storage and local OCR configuration."""
from __future__ import annotations

import os
import shutil

import pytesseract

from app.database.config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
)


def runtime_configuration_diagnostics(*, include_ocr: bool = True) -> dict[str, bool | None]:
    """Return booleans only; never return URLs, bucket names, commands, or keys."""
    configured_command = (os.getenv("TESSERACT_CMD") or "").strip()
    executable_available: bool | None = None
    language_available: bool | None = None
    if include_ocr:
        binary = configured_command or pytesseract.pytesseract.tesseract_cmd
        executable_available = bool(os.path.isfile(binary) or shutil.which(binary))

    # Use the configured binary while probing its language data, then restore
    # pytesseract's process-global value so diagnostics do not alter OCR behavior.
    if executable_available and include_ocr:
        original_command = pytesseract.pytesseract.tesseract_cmd
        try:
            if configured_command:
                pytesseract.pytesseract.tesseract_cmd = configured_command
            language_available = "vie" in set(pytesseract.get_languages(config=""))
        except Exception:
            language_available = False
        finally:
            pytesseract.pytesseract.tesseract_cmd = original_command

    return {
        "supabase_url_configured": bool(SUPABASE_URL),
        "supabase_storage_bucket_configured": bool(SUPABASE_STORAGE_BUCKET),
        "server_side_key_configured": bool(SUPABASE_ADMIN_KEY),
        "tesseract_command_configured": bool(configured_command),
        "tesseract_executable_available": executable_available,
        "vietnamese_language_available": language_available,
    }
