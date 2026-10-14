"""Safe structured diagnostic logging; never log exception messages or credentials."""
from __future__ import annotations

import json
import logging
import re
import traceback
from typing import Any

from app.request_context import get_request_id


def _safe_error_code(exc: BaseException) -> str | None:
    code = getattr(exc, "code", None)
    if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", code):
        return code
    return None


def _safe_status(exc: BaseException) -> int | None:
    value = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if value is None:
        response = getattr(exc, "response", None)
        value = getattr(response, "status_code", None)
    try:
        number = int(value)
    except (TypeError, ValueError):
        if isinstance(value, str):
            match = re.match(r"^\s*(\d{3})\b", value)
            if not match:
                return None
            number = int(match.group(1))
        else:
            return None
    return number if 100 <= number <= 599 else None


def log_diagnostic(
    logger: logging.Logger,
    level: int,
    *,
    event: str,
    stage: str,
    exception: BaseException | None = None,
    include_traceback: bool = False,
    **fields: Any,
) -> None:
    """Emit JSON key/value fields from explicitly supplied safe metadata only.

    The exception message is deliberately not serialized. A traceback can be
    enabled only at an unexpected-error boundary for private server-side logs.
    """
    payload: dict[str, Any] = {
        "event": event,
        "stage": stage,
        "request_id": get_request_id(),
    }
    for key, value in fields.items():
        if value is None or not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", key):
            continue
        if isinstance(value, (str, int, float, bool)):
            payload[key] = value
        else:
            payload[key] = str(value)
    if exception is not None:
        payload["exception_type"] = type(exception).__name__
        payload["http_status"] = _safe_status(exception)
        payload["error_code"] = _safe_error_code(exception)
        if include_traceback and exception.__traceback__:
            # Log stack frames but not str(exception) or chained exception text,
            # which can contain SQL parameters, provider responses, or credentials.
            payload["stack_trace"] = "".join(traceback.format_tb(exception.__traceback__))
    logger.log(
        level,
        "readalong_diagnostic %s",
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )
