from __future__ import annotations

import asyncio
import atexit
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math
import weakref

import httpx

from app.services.ai_capability_router import (
    AiErrorKind,
    reset_shared_ai_circuit_breaker,
)


_OCR_AI_HTTP_CLIENTS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = (
    weakref.WeakKeyDictionary()
)

_PROVIDER_ID_ALIAS: dict[str, str] = {
    "gemini_3_5": "gemini_primary",
    "gemini_3_1": "gemini_fallback",
}


def _cleanup_clients_at_exit() -> None:
    _OCR_AI_HTTP_CLIENTS.clear()


atexit.register(_cleanup_clients_at_exit)


def get_shared_ocr_ai_http_client() -> httpx.AsyncClient:
    """Return a shared, loop-scoped AsyncClient for OCR/Child-Safety cloud calls."""
    loop = asyncio.get_running_loop()
    client = _OCR_AI_HTTP_CLIENTS.get(loop)
    if client is not None and not getattr(client, "is_closed", False):
        return client
    client = httpx.AsyncClient(
        http2=True,
        timeout=httpx.Timeout(60.0, connect=5.0),
        trust_env=False,
        follow_redirects=False,
        limits=httpx.Limits(
            max_connections=20,
            max_keepalive_connections=10,
            keepalive_expiry=30.0,
        ),
    )
    _OCR_AI_HTTP_CLIENTS[loop] = client
    return client


async def aclose_ocr_ai_http_clients() -> None:
    """Close pooled OCR AI HTTP clients on application shutdown or test teardown."""
    clients = list(_OCR_AI_HTTP_CLIENTS.values())
    _OCR_AI_HTTP_CLIENTS.clear()
    for client in clients:
        aclose = getattr(client, "aclose", None)
        if callable(aclose) and not getattr(client, "is_closed", False):
            try:
                await aclose()
            except Exception:
                pass


def reset_ocr_ai_runtime() -> None:
    """Reset pooled OCR AI HTTP clients and shared circuit breaker state (for tests)."""
    _OCR_AI_HTTP_CLIENTS.clear()
    reset_shared_ai_circuit_breaker()


def parse_retry_after_seconds(header_value: str | None) -> float | None:
    """Parse Retry-After numeric seconds or HTTP-date into a bounded [1.0, 900.0] delay."""
    if not isinstance(header_value, str):
        return None
    raw = header_value.strip()
    if not raw:
        return None
    try:
        numeric = float(raw)
        if math.isfinite(numeric) and numeric > 0:
            return min(900.0, max(1.0, numeric))
        return None
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = (dt - datetime.now(timezone.utc)).total_seconds()
    if delta <= 0:
        return None
    return min(900.0, max(1.0, delta))


def detect_limit_zero(response: httpx.Response | None) -> bool:
    """Detect upstream free-tier limit: 0 responses without retaining response bodies."""
    if response is None:
        return False
    try:
        snippet = (response.text or "")[:1024].lower()
    except Exception:
        return False
    return "limit: 0" in snippet or "limit:0" in snippet


def is_cloud_family(family: str) -> bool:
    return family in {"google", "groq"}


def provider_circuit_key(name: str) -> str:
    return f"provider:{_PROVIDER_ID_ALIAS.get(name, name)}"


def quota_circuit_key(family: str) -> str | None:
    if family == "google":
        return "quota_group:gemini_free_shared"
    if family == "groq":
        return "quota_group:groq_free_shared"
    return None


def classify_ocr_provider_error(
    code: str | None, upstream_status_code: int | None
) -> tuple[AiErrorKind | None, bool]:
    """Map OCR/Child-Safety errors to (AiErrorKind | None, trips_quota_group)."""
    normalized = str(code or "").strip().upper()
    if upstream_status_code == 403:
        return AiErrorKind.PERMISSION_FAILURE, True
    if upstream_status_code == 401 or normalized == "PROVIDER_AUTHENTICATION":
        return AiErrorKind.AUTH_FAILURE, True
    if upstream_status_code == 404 or normalized == "MODEL_UNAVAILABLE":
        return AiErrorKind.UNSUPPORTED_CAPABILITY, False
    if upstream_status_code == 429 or normalized == "PROVIDER_QUOTA":
        return AiErrorKind.QUOTA_EXHAUSTED, True
    if normalized == "PROVIDER_TIMEOUT" or upstream_status_code == 504:
        return AiErrorKind.TIMEOUT, False
    if (
        normalized in {"PROVIDER_NETWORK", "PROVIDER_UNAVAILABLE"}
        or (isinstance(upstream_status_code, int) and upstream_status_code >= 500)
    ):
        return AiErrorKind.NETWORK_ERROR, False
    return None, False
