"""Read-only, bounded runtime health checks; never start an OCR model.

"Installed" means package presence, not successful OCR inference. Tesseract is
probed independently and its Vietnamese language pack is explicitly checked.
No secret, model path or command line appears in the returned evidence.
"""
from __future__ import annotations

import importlib.util
import httpx
from urllib.parse import quote
import os
import shutil
import subprocess
import sys
import time
from functools import lru_cache
from typing import Any

from app.database.config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
)
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig


def _package_installed(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def _health_item(
    item_id: str, label: str, status: str, detail_status: str, message: str,
) -> dict[str, str]:
    return {
        "id": item_id, "label": label, "status": status,
        "detail_status": detail_status, "safe_message": message,
    }


def _ocr_engine_health(package: str, engine_name: str, status_name: str, label: str) -> dict[str, str]:
    installed = _package_installed(package)
    runtime = sys.modules.get("app.services.ocr_engine")
    engine = getattr(runtime, engine_name, None) if runtime is not None else None
    load_status = getattr(runtime, status_name, None) if runtime is not None else None
    prefix = "_paddle" if package == "paddleocr" else "_vietocr"
    init_error = getattr(runtime, f"{prefix}_initialization_error", None) if runtime is not None else None
    import_error = getattr(runtime, f"{prefix}_import_error", None) if runtime is not None else None
    if engine is not None and load_status == "success":
        return _health_item(package, label, "HEALTHY", "loaded",
                            "Engine đã khởi tạo; Health không chạy nhận diện ảnh.")
    if load_status in {"error", "not_installed"} or init_error is not None or import_error is not None:
        return _health_item(package, label, "UNAVAILABLE", "failed",
                            "Không thể khởi tạo engine OCR này.")
    if engine is not None:
        return _health_item(package, label, "DEGRADED", "initialized",
                            "Engine tồn tại nhưng chưa xác nhận trạng thái nạp.")
    if installed:
        return _health_item(package, label, "DEGRADED", "installed",
                            "Đã cài thư viện; chưa tải model OCR trong tiến trình.")
    return _health_item(package, label, "UNAVAILABLE", "failed",
                        "Thiếu thư viện OCR cần thiết.")


@lru_cache(maxsize=16)
def _cached_tesseract_languages(binary: str, time_bucket: int) -> tuple[bool, frozenset[str]]:
    """A low-cost subprocess check, cached for at most 30 seconds per binary."""
    del time_bucket
    try:
        result = subprocess.run(
            [binary, "--list-langs"], capture_output=True, text=True,
            timeout=2.0, check=False,
        )
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False, frozenset()
    if result.returncode != 0:
        return False, frozenset()
    return True, frozenset(line.strip().lower() for line in
                           (result.stdout + "\n" + result.stderr).splitlines())


def _tesseract_health() -> tuple[dict[str, str], dict[str, str], bool, bool]:
    command = os.environ.get("TESSERACT_CMD", "tesseract").strip()
    binary = shutil.which(command) if command else None
    if binary is None:
        return (
            _health_item("tesseract", "Tesseract", "UNAVAILABLE", "failed",
                         "Không tìm thấy chương trình Tesseract."),
            _health_item("tesseract_vie", "Tesseract tiếng Việt", "UNAVAILABLE", "unknown",
                         "Chưa thể xác nhận dữ liệu tiếng Việt khi thiếu Tesseract."),
            False, False,
        )
    ok, languages = _cached_tesseract_languages(binary, int(time.monotonic() // 30))
    if not ok:
        return (
            _health_item("tesseract", "Tesseract", "UNAVAILABLE", "failed",
                         "Tesseract không phản hồi kiểm tra ngôn ngữ trong giới hạn thời gian."),
            _health_item("tesseract_vie", "Tesseract tiếng Việt", "DEGRADED", "unknown",
                         "Chưa xác minh được dữ liệu nhận diện tiếng Việt."),
            True, False,
        )
    return (
        _health_item("tesseract", "Tesseract", "HEALTHY", "healthy",
                     "Tesseract phản hồi kiểm tra danh sách ngôn ngữ."),
        _health_item(
            "tesseract_vie", "Tesseract tiếng Việt",
            "HEALTHY" if "vie" in languages else "UNAVAILABLE",
            "healthy" if "vie" in languages else "failed",
            "Đã xác nhận dữ liệu nhận diện tiếng Việt."
            if "vie" in languages else "Thiếu dữ liệu nhận diện tiếng Việt (vie).",
        ),
        True, "vie" in languages,
    )


def collect_ocr_health() -> list[dict[str, str]]:
    """Inspection only: no imports of torch/PaddleOCR/VietOCR or model inference."""
    paddle = _ocr_engine_health("paddleocr", "_paddle_engine",
                                "_paddle_initialization_status", "PaddleOCR")
    viet = _ocr_engine_health("vietocr", "_vietocr_engine",
                              "_vietocr_initialization_status", "VietOCR")
    tesseract, vietnamese, _, _ = _tesseract_health()
    return [paddle, viet, tesseract, vietnamese]


async def probe_storage_health() -> dict[str, str]:
    """A read-only HEAD of the configured bucket; no object listing or downloads."""
    if not (SUPABASE_URL and SUPABASE_STORAGE_BUCKET and SUPABASE_ADMIN_KEY):
        return _health_item(
            "storage", "Supabase Storage", "UNAVAILABLE", "failed",
            "Thiếu cấu hình kết nối Supabase Storage.",
        )
    try:
        url = (
            f"{SUPABASE_URL.rstrip('/')}/storage/v1/bucket/"
            f"{quote(SUPABASE_STORAGE_BUCKET, safe='')}"
        )
        headers = {
            "apikey": SUPABASE_ADMIN_KEY,
            "Authorization": f"Bearer {SUPABASE_ADMIN_KEY}",
        }
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(2.5, connect=1.5),
            follow_redirects=False, trust_env=False,
        ) as client:
            response = await client.head(url, headers=headers)
        if response.status_code == 200:
            return _health_item(
                "storage", "Supabase Storage", "HEALTHY", "healthy",
                "Storage phản hồi kiểm tra bucket (không đọc file).",
            )
        if response.status_code in {401, 403}:
            return _health_item(
                "storage", "Supabase Storage", "UNAVAILABLE", "failed",
                "Storage từ chối quyền kiểm tra bucket.",
            )
        if response.status_code == 404:
            return _health_item(
                "storage", "Supabase Storage", "UNAVAILABLE", "failed",
                "Không tìm thấy bucket Storage đã cấu hình.",
            )
        return _health_item(
            "storage", "Supabase Storage", "DEGRADED", "unknown",
            "Storage chưa phản hồi trạng thái bucket hợp lệ.",
        )
    except (httpx.HTTPError, TimeoutError, ValueError, OSError):
        return _health_item(
            "storage", "Supabase Storage", "DEGRADED", "unknown",
            "Chưa xác minh được kết nối Storage; vui lòng thử lại.",
        )


_WORKER_LABELS = {
    "viread_ocr_outbox": "OCR outbox worker",
    "viread_ocr_training": "OCR training worker",
    "book_quality": "Book quality worker",
    "admin_ai_workflow": "Admin AI workflow worker",
    "parent_book_submission": "Parent book submission worker",
    "active_model_registry": "Model registry worker",
    "local_trainer_process": "Local training process",
}


def _worker_state(worker: Any) -> str:
    if worker is None:
        return "disabled"
    try:
        if hasattr(worker, "is_alive"):
            return "running" if worker.is_alive() else "failed"
        if hasattr(worker, "returncode"):
            return "running" if worker.returncode is None else "failed"
        if hasattr(worker, "done"):
            if not worker.done():
                return "running"
            return "failed" if worker.cancelled() or worker.exception() is not None else "stopped"
    except Exception:
        return "unknown"
    return "unknown"


def collect_worker_health(workers: dict[str, Any]) -> list[dict[str, str]]:
    results = []
    for key, label in _WORKER_LABELS.items():
        state = _worker_state(workers.get(key))
        if state == "running":
            results.append(_health_item(key, label, "HEALTHY", "healthy",
                                        "Worker đang chạy trong tiến trình API."))
        elif state == "disabled":
            results.append(_health_item(key, label, "DEGRADED", "disabled",
                                        "Worker không được khởi chạy trong tiến trình này."))
        elif state == "unknown":
            results.append(_health_item(key, label, "DEGRADED", "unknown",
                                        "Chưa thể xác minh trạng thái worker."))
        else:
            results.append(_health_item(key, label, "UNAVAILABLE", "failed",
                                        "Worker đã dừng hoặc gặp lỗi."))
    return results


def runtime_configuration_diagnostics(*, include_ocr: bool = True) -> dict[str, bool | None]:
    """Compatibility booleans backed by independent, real low-cost checks.

    Does not expose URLs, bucket names, commands, checkpoint paths or keys.
    """
    ocr_available = None
    vietnamese_available = None
    tesseract_configured = None
    tesseract_executable = None
    if include_ocr:
        ocr_available = _package_installed("paddleocr") and _package_installed("vietocr")
        _, _, tesseract_executable, vietnamese_available = _tesseract_health()
        tesseract_configured = bool(os.environ.get("TESSERACT_CMD", "tesseract").strip())

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
        "vietnamese_language_available": vietnamese_available,
        "tesseract_command_configured": tesseract_configured,
        "tesseract_executable_available": tesseract_executable,
    }
