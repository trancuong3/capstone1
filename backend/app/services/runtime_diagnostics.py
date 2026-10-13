"""Internal, read-only diagnostics for Supabase Storage and local OCR configuration."""
from __future__ import annotations

import os
import shutil
from typing import Any

import pytesseract

from app.database.config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
)


def runtime_configuration_diagnostics() -> dict[str, bool | None]:
    """Return booleans only; never return URLs, bucket names, commands, or keys."""
    configured_command = (os.getenv("TESSERACT_CMD") or "").strip()
    binary = configured_command or pytesseract.pytesseract.tesseract_cmd
    executable_available = bool(os.path.isfile(binary) or shutil.which(binary))
    language_available: bool | None = None
    if executable_available:
        try:
            language_available = "vie" in set(pytesseract.get_languages(config=""))
        except Exception:
            language_available = False
    return {
        "supabase_url_configured": bool(SUPABASE_URL),
        "supabase_storage_bucket_configured": bool(SUPABASE_STORAGE_BUCKET),
        "server_side_key_configured": bool(SUPABASE_ADMIN_KEY),
        "tesseract_command_configured": bool(configured_command),
        "tesseract_executable_available": executable_available,
        "vietnamese_language_available": language_available,
    }
