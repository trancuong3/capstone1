"""Lightweight single-worker executor for CPU/GPU bound in-process OCR inference.

Kept dependency-free (no torch/paddle/cv2/ocr_engine imports) so lightweight web
processes can dispatch mocked or local OCR calls without eagerly importing ML
frameworks at startup.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import threading

_executor_lock = threading.Lock()
_ocr_executor: ThreadPoolExecutor | None = None


def get_ocr_executor() -> ThreadPoolExecutor:
    """Return the shared single-worker OCR executor (max_workers=1)."""
    global _ocr_executor
    with _executor_lock:
        if _ocr_executor is None:
            _ocr_executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="viread-ocr",
            )
        return _ocr_executor


def shutdown_ocr_executor(*, wait: bool = False) -> None:
    """Tear down the shared OCR executor during process shutdown or test cleanup."""
    global _ocr_executor
    with _executor_lock:
        executor = _ocr_executor
        _ocr_executor = None
    if executor is not None:
        executor.shutdown(wait=wait)
