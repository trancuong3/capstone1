from __future__ import annotations

import os
from dataclasses import dataclass, field

from app.services.cloud_ai_defaults import (
    DEFAULT_GEMINI_FALLBACK_MODEL,
    DEFAULT_GEMINI_PRIMARY_MODEL,
    DEFAULT_GROQ_TEXT_MODEL,
    read_model_env,
    read_secret_env,
)


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def _int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, ""))
    except ValueError:
        return default
    return value if minimum <= value <= maximum else default


def _secret(name: str) -> str | None:
    return read_secret_env(name)


def _model(name: str, default: str) -> str:
    return read_model_env(name, default=default)


@dataclass(frozen=True)
class TutorQuestionConfig:
    """Backend-only configuration. API keys are excluded from repr()."""

    enabled: bool = True
    ai_enabled: bool = True
    gemini_api_key: str | None = field(default=None, repr=False)
    groq_api_key: str | None = field(default=None, repr=False)
    gemini_model: str = DEFAULT_GEMINI_PRIMARY_MODEL
    gemini_fallback_model: str = DEFAULT_GEMINI_FALLBACK_MODEL
    groq_model: str = DEFAULT_GROQ_TEXT_MODEL
    timeout_seconds: int = 12
    # Each lesson gets a random number of questions in [min, max], limited by
    # how much text the child actually read.
    min_questions: int = 5
    max_questions: int = 10
    max_source_chars: int = 6000

    @classmethod
    def from_environment(cls) -> "TutorQuestionConfig":
        minimum = _int("TUTOR_QUESTIONS_MIN_COUNT", 5, 1, 15)
        maximum = max(minimum, _int("TUTOR_QUESTIONS_MAX_COUNT", 10, 1, 15))
        return cls(
            enabled=_bool("TUTOR_QUESTIONS_ENABLED", True),
            ai_enabled=_bool("TUTOR_QUESTIONS_AI_ENABLED", True),
            gemini_api_key=_secret("GEMINI_API_KEY"),
            groq_api_key=_secret("GROQ_API_KEY"),
            gemini_model=read_model_env(
                "TUTOR_QUESTIONS_GEMINI_MODEL",
                "GEMINI_PRIMARY_MODEL",
                "GEMINI_OCR_PRIMARY_MODEL",
                default=DEFAULT_GEMINI_PRIMARY_MODEL,
            ),
            gemini_fallback_model=read_model_env(
                "TUTOR_QUESTIONS_GEMINI_FALLBACK_MODEL",
                "GEMINI_FALLBACK_MODEL",
                "GEMINI_OCR_FALLBACK_MODEL",
                default=DEFAULT_GEMINI_FALLBACK_MODEL,
            ),
            groq_model=read_model_env(
                "TUTOR_QUESTIONS_GROQ_MODEL",
                "GROQ_PRIMARY_MODEL",
                "GROQ_OCR_MODEL",
                default=DEFAULT_GROQ_TEXT_MODEL,
            ),
            timeout_seconds=_int("TUTOR_QUESTIONS_TIMEOUT_SECONDS", 12, 1, 120),
            min_questions=minimum,
            max_questions=maximum,
            max_source_chars=_int("TUTOR_QUESTIONS_MAX_SOURCE_CHARS", 6000, 500, 20000),
        )
