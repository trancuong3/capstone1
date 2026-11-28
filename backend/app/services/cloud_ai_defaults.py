"""Single source of truth for ViRead Cloud AI models, env parsing, and runtime health telemetry.

All cloud LLM/VLM callers (Child Progress, Tutor Questions, OCR AI, Picture
Description, Phonics AI, Memory Game, Book Style Bible, and AI Capability Router)
import their default model IDs, env helpers, Gemini 3.x compatibility helpers,
and safe health telemetry from this module so model retirements never cause
silent multi-service outages again.
"""

from __future__ import annotations

import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

# Live-verified active zero-cost / Free-Tier model defaults (verified 2026-11-28).
DEFAULT_GEMINI_PRIMARY_MODEL = "gemini-3.1-flash-lite"
DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite"
DEFAULT_GEMINI_ALIAS_MODEL = "gemini-flash-lite-latest"

DEFAULT_GROQ_MULTIMODAL_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_TEXT_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_TEXT_FALLBACK_MODEL = "openai/gpt-oss-120b"

# Known retired/removed model IDs that return HTTP 404.
RETIRED_CLOUD_AI_MODELS: frozenset[str] = frozenset(
    {
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "llama-3.3-70b-versatile",
    }
)

MODEL_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}")
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_MARKDOWN_FENCE_RE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.IGNORECASE | re.DOTALL)

_MODEL_COOLDOWN_BY_CODE_SECONDS: dict[str, float] = {
    "MODEL_UNAVAILABLE": 600.0,
    "PROVIDER_UNAVAILABLE": 30.0,
    "PROVIDER_TIMEOUT": 45.0,
    "PROVIDER_QUOTA": 60.0,
}

_TELEMETRY_LOCK = threading.Lock()
_MODEL_COOLDOWN_UNTIL: dict[tuple[str, str], float] = {}
_SERVICE_TELEMETRY: dict[str, dict[str, Any]] = {}


def strip_env_value(raw: str | None) -> str:
    """Trim whitespace and one pair of matching surrounding quotes."""
    value = (raw or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1].strip()
    return value


def read_secret_env(
    *names: str,
    env: Mapping[str, str] | None = None,
) -> str | None:
    """Return the first non-empty stripped secret env value (never logged)."""
    source = os.environ if env is None else env
    for name in names:
        value = strip_env_value(source.get(name))
        if value:
            return value
    return None


def read_model_env(
    *names: str,
    default: str,
    env: Mapping[str, str] | None = None,
    strict: bool = False,
) -> str:
    """Resolve the first configured valid model ID from env names, or return default.

    When strict=True and a non-empty value fails MODEL_NAME_PATTERN, raises
    ValueError("INVALID_CLOUD_MODEL") so callers like OCR config can reject bad config.
    """
    source = os.environ if env is None else env
    for name in names:
        raw = source.get(name)
        if raw is None:
            continue
        value = strip_env_value(raw)
        if not value:
            continue
        if MODEL_NAME_PATTERN.fullmatch(value):
            return value
        if strict:
            raise ValueError("INVALID_CLOUD_MODEL")
    return default


def build_gemini_model_chain(
    primary: str,
    fallback: str | None = None,
    extras: Iterable[str] = (),
    *,
    include_defaults: bool = True,
) -> tuple[str, ...]:
    """Build a deduplicated Gemini model chain with self-healing defaults appended."""
    candidates: list[str] = []
    seen: set[str] = set()
    tail: tuple[str, ...] = (
        (
            DEFAULT_GEMINI_ALIAS_MODEL,
            DEFAULT_GEMINI_PRIMARY_MODEL,
            DEFAULT_GEMINI_FALLBACK_MODEL,
        )
        if include_defaults
        else ()
    )
    for raw in (primary, fallback, *extras, *tail):
        cleaned = strip_env_value(raw)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            candidates.append(cleaned)
    return tuple(candidates)


def build_groq_model_chain(
    primary: str,
    *,
    multimodal: bool = False,
    include_defaults: bool = True,
) -> tuple[str, ...]:
    """Build a deduplicated Groq model chain with verified active fallbacks."""
    candidates: list[str] = []
    seen: set[str] = set()
    tail: tuple[str, ...] = ()
    if include_defaults:
        tail = (
            (DEFAULT_GROQ_MULTIMODAL_MODEL,)
            if multimodal
            else (DEFAULT_GROQ_TEXT_MODEL, DEFAULT_GROQ_TEXT_FALLBACK_MODEL)
        )
    for raw in (primary, *tail):
        cleaned = strip_env_value(raw)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            candidates.append(cleaned)
    return tuple(candidates)


def gemini_thinking_config(model: str) -> dict[str, str] | None:
    """Return low-latency thinkingConfig only for Gemini 3.x Flash-Lite / latest alias."""
    lower = strip_env_value(model).lower()
    if "flash-lite" in lower and ("gemini-3" in lower or "latest" in lower):
        return {"thinkingLevel": "MINIMAL"}
    return None


def extract_gemini_text(payload: Any) -> str | None:
    """Extract non-thought text parts from a Gemini generateContent JSON payload."""
    if not isinstance(payload, dict):
        return None
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return None
    first = candidates[0]
    if not isinstance(first, dict):
        return None
    content = first.get("content")
    if not isinstance(content, dict):
        return None
    parts = content.get("parts")
    if not isinstance(parts, list) or not parts:
        return None

    non_thought: list[str] = []
    all_text: list[str] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if not isinstance(text, str) or not text:
            continue
        all_text.append(text)
        if not part.get("thought"):
            non_thought.append(text)

    joined = "".join(non_thought if non_thought else all_text).strip()
    return joined or None


def strip_think_tags(text: str) -> str:
    """Remove <think>...</think> reasoning blocks and outer markdown code fences."""
    cleaned = _THINK_BLOCK_RE.sub("", text).strip()
    fenced = _MARKDOWN_FENCE_RE.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    return cleaned


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_cloud_ai_outcome(
    service: str,
    provider: str,
    model: str,
    *,
    ok: bool,
    error_code: str | None = None,
    http_status: int | None = None,
    track_cooldown: bool = True,
) -> None:
    """Record sanitized non-secret outcome metrics and short-lived dead-model cooldowns."""
    now_mono = time.monotonic()
    now_iso = _now_iso()
    norm_provider = strip_env_value(provider).lower() or "unknown"
    norm_model = strip_env_value(model) or "unknown"
    norm_service = strip_env_value(service) or "unknown"
    code = strip_env_value(error_code).upper() or None

    with _TELEMETRY_LOCK:
        entry = _SERVICE_TELEMETRY.setdefault(
            norm_service,
            {
                "last_ok_at": None,
                "last_error_at": None,
                "last_error_code": None,
                "last_http_status": None,
                "last_provider": None,
                "last_model": None,
                "consecutive_failures": 0,
            },
        )
        entry["last_provider"] = norm_provider
        entry["last_model"] = norm_model
        if ok:
            entry["last_ok_at"] = now_iso
            entry["last_error_code"] = None
            entry["last_http_status"] = http_status or 200
            entry["consecutive_failures"] = 0
            _MODEL_COOLDOWN_UNTIL.pop((norm_provider, norm_model), None)
            return

        entry["last_error_at"] = now_iso
        entry["last_error_code"] = code or "UNKNOWN"
        entry["last_http_status"] = http_status
        entry["consecutive_failures"] = int(entry.get("consecutive_failures") or 0) + 1

        if track_cooldown and code in _MODEL_COOLDOWN_BY_CODE_SECONDS:
            ttl = _MODEL_COOLDOWN_BY_CODE_SECONDS[code]
            _MODEL_COOLDOWN_UNTIL[(norm_provider, norm_model)] = max(
                _MODEL_COOLDOWN_UNTIL.get((norm_provider, norm_model), 0.0),
                now_mono + ttl,
            )


def is_model_in_cooldown(provider: str, model: str) -> bool:
    """Return True if (provider, model) is currently in a temporary dead/overload cooldown."""
    key = (strip_env_value(provider).lower(), strip_env_value(model))
    now_mono = time.monotonic()
    with _TELEMETRY_LOCK:
        until = _MODEL_COOLDOWN_UNTIL.get(key)
        if until is None:
            return False
        if until <= now_mono:
            _MODEL_COOLDOWN_UNTIL.pop(key, None)
            return False
        return True


def reset_cloud_ai_telemetry() -> None:
    """Reset in-memory Cloud AI telemetry and cooldowns (for isolated tests)."""
    with _TELEMETRY_LOCK:
        _MODEL_COOLDOWN_UNTIL.clear()
        _SERVICE_TELEMETRY.clear()


def get_cloud_ai_health_snapshot(env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Return a non-secret runtime health summary for Cloud AI providers and services."""
    gemini_key = read_secret_env("GEMINI_API_KEY", env=env)
    groq_key = read_secret_env("GROQ_API_KEY", env=env)
    now_mono = time.monotonic()

    with _TELEMETRY_LOCK:
        active_cooldowns = [
            {"provider": prov, "model": mdl, "remaining_seconds": round(until - now_mono, 1)}
            for (prov, mdl), until in list(_MODEL_COOLDOWN_UNTIL.items())
            if until > now_mono
        ]
        services_copy = {svc: dict(meta) for svc, meta in _SERVICE_TELEMETRY.items()}

    failing_services = [
        (svc, meta)
        for svc, meta in services_copy.items()
        if int(meta.get("consecutive_failures") or 0) >= 2
    ]
    configured_any = bool(gemini_key or groq_key)
    last_error: str | None = None
    if failing_services:
        failing_services.sort(key=lambda item: int(item[1].get("consecutive_failures") or 0), reverse=True)
        last_error = str(failing_services[0][1].get("last_error_code") or "CLOUD_AI_UNAVAILABLE")

    status = "HEALTHY"
    if not configured_any:
        status = "DEGRADED"
        last_error = "AI_NOT_CONFIGURED"
    elif failing_services:
        status = "DEGRADED"

    return {
        "status": status,
        "configured_providers": {
            "gemini": bool(gemini_key),
            "groq": bool(groq_key),
        },
        "default_models": {
            "gemini_primary": read_model_env(
                "GEMINI_PRIMARY_MODEL",
                "GEMINI_OCR_PRIMARY_MODEL",
                default=DEFAULT_GEMINI_PRIMARY_MODEL,
                env=env,
            ),
            "gemini_fallback": read_model_env(
                "GEMINI_FALLBACK_MODEL",
                "GEMINI_OCR_FALLBACK_MODEL",
                default=DEFAULT_GEMINI_FALLBACK_MODEL,
                env=env,
            ),
            "gemini_alias": DEFAULT_GEMINI_ALIAS_MODEL,
            "groq_primary": read_model_env(
                "GROQ_PRIMARY_MODEL",
                "GROQ_OCR_MODEL",
                default=DEFAULT_GROQ_TEXT_MODEL,
                env=env,
            ),
        },
        "active_cooldowns": active_cooldowns,
        "services": services_copy,
        "last_error": last_error,
    }
