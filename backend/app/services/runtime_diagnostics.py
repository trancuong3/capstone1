"""Internal, read-only diagnostics for storage, OCR, and local model configuration."""
from __future__ import annotations

import importlib.util

from app.database.config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
)
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig


def runtime_configuration_diagnostics(*, include_ocr: bool = True) -> dict[str, bool | None]:
    """Return booleans only; never return URLs, bucket names, commands, or keys."""
    ocr_available: bool | None = None

    if include_ocr:
        paddle_ready = importlib.util.find_spec("paddleocr") is not None
        vietocr_ready = importlib.util.find_spec("vietocr") is not None
        ocr_available = bool(paddle_ready and vietocr_ready)

    try:
        LocalOcrConfig.from_environment()
        local_ocr_config_valid = True
    except LocalCorrectionError:
        local_ocr_config_valid = False

    return {
        "supabase_url_configured": bool(SUPABASE_URL),
        "supabase_storage_bucket_configured": bool(SUPABASE_STORAGE_BUCKET),
        "server_side_key_configured": bool(SUPABASE_ADMIN_KEY),
        "local_ocr_config_valid": local_ocr_config_valid,
        "ocr_engine_available": ocr_available,
        "vietnamese_language_available": ocr_available,
        "tesseract_command_configured": ocr_available,
        "tesseract_executable_available": ocr_available,
    }
