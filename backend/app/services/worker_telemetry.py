"""Lightweight in-process worker liveness & error telemetry (zero ML imports)."""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any

_LOCK = threading.Lock()
_TELEMETRY: dict[str, dict[str, Any]] = {}


def _safe_error_label(exc_or_code: BaseException | str) -> str:
    if isinstance(exc_or_code, BaseException):
        label = getattr(exc_or_code, "code", None) or type(exc_or_code).__name__
    else:
        label = str(exc_or_code)
    cleaned = "".join(
        ch if (ch.isalnum() or ch in {"_", "-", "."}) else "_"
        for ch in str(label).strip()
    )
    return (cleaned or "UNKNOWN_ERROR")[:64]


def record_worker_success(worker_id: str, *, at: datetime | None = None) -> None:
    now = at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    with _LOCK:
        entry = _TELEMETRY.setdefault(worker_id, {})
        entry["last_success_at"] = now
        entry["last_error"] = None


def record_worker_error(
    worker_id: str, exc_or_code: BaseException | str, *, at: datetime | None = None
) -> None:
    now = at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    label = _safe_error_label(exc_or_code)
    with _LOCK:
        entry = _TELEMETRY.setdefault(worker_id, {})
        entry["last_error"] = label
        entry["last_error_at"] = now


def get_worker_telemetry(worker_id: str) -> dict[str, Any]:
    with _LOCK:
        entry = _TELEMETRY.get(worker_id)
        if not entry:
            return {"last_success_at": None, "last_error": None}
        return {
            "last_success_at": entry.get("last_success_at"),
            "last_error": entry.get("last_error"),
        }


def clear_worker_telemetry() -> None:
    with _LOCK:
        _TELEMETRY.clear()
