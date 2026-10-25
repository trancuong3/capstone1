"""Internal, read-only diagnostics for Supabase Storage and Dual-Engine OCR configuration."""
from __future__ import annotations

import importlib.util

from app.database.config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
)


def runtime_configuration_diagnostics(*, include_ocr: bool = True) -> dict[str, bool | None]:
    """Return booleans only; never return URLs, bucket names, commands, or keys."""
    ocr_available: bool | None = None

    if include_ocr:
        # Kiểm tra tính sẵn sàng của Dual-Engine (PaddleOCR + VietOCR) trong môi trường runtime
        paddle_ready = importlib.util.find_spec("paddleocr") is not None
        vietocr_ready = importlib.util.find_spec("vietocr") is not None
        ocr_available = bool(paddle_ready and vietocr_ready)

    return {
        "supabase_url_configured": bool(SUPABASE_URL),
        "supabase_storage_bucket_configured": bool(SUPABASE_STORAGE_BUCKET),
        "server_side_key_configured": bool(SUPABASE_ADMIN_KEY),
        "ocr_engine_available": ocr_available,
        "vietnamese_language_available": ocr_available,
        # Giữ lại các key cũ làm shim tương thích ngược để không làm vỡ các schema API hiện hữu
        "tesseract_command_configured": ocr_available,
        "tesseract_executable_available": ocr_available,
    }