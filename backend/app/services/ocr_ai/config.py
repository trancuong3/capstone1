from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError


_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}")


def _optional_secret(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise OcrConfigurationError("INVALID_CLOUD_ENABLEMENT")


def _read_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise OcrConfigurationError("INVALID_CLOUD_TIMEOUT") from exc
    if not minimum <= value <= maximum:
        raise OcrConfigurationError("INVALID_CLOUD_TIMEOUT")
    return value


def _read_model(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    if not _MODEL_PATTERN.fullmatch(value):
        raise OcrConfigurationError("INVALID_CLOUD_MODEL")
    if value != default:
        raise OcrConfigurationError("UNSUPPORTED_CLOUD_MODEL")
    return value


@dataclass(frozen=True)
class OcrCorrectionConfig:
    """Backend-only configuration. Secret values are excluded from repr()."""

    cloud_enabled: bool = False
    gemini_api_key: str | None = field(default=None, repr=False)
    groq_api_key: str | None = field(default=None, repr=False)
    gemini_primary_model: str = "gemini-3.5-flash-lite"
    gemini_fallback_model: str = "gemini-3.1-flash-lite"
    groq_model: str = "qwen/qwen3.8-27b"
    cloud_timeout_seconds: int = 60
    total_timeout_seconds: int = 7200
    local: LocalOcrConfig = field(default_factory=LocalOcrConfig, repr=False)

    @property
    def gemini_enabled(self) -> bool:
        return self.cloud_enabled and self.gemini_api_key is not None

    @property
    def groq_enabled(self) -> bool:
        return self.cloud_enabled and self.groq_api_key is not None

    @classmethod
    def from_environment(cls) -> "OcrCorrectionConfig":
        try:
            local = LocalOcrConfig.from_environment()
        except LocalCorrectionError as exc:
            raise OcrConfigurationError("INVALID_LOCAL_OCR_CONFIGURATION") from exc
        return cls(
            cloud_enabled=_read_bool("OCR_CLOUD_CORRECTION_ENABLED", False),
            gemini_api_key=_optional_secret("GEMINI_API_KEY"),
            groq_api_key=_optional_secret("GROQ_API_KEY"),
            gemini_primary_model=_read_model(
                "GEMINI_OCR_PRIMARY_MODEL", "gemini-3.5-flash-lite"
            ),
            gemini_fallback_model=_read_model(
                "GEMINI_OCR_FALLBACK_MODEL", "gemini-3.1-flash-lite"
            ),
            groq_model=_read_model("GROQ_OCR_MODEL", "qwen/qwen3.8-27b"),
            cloud_timeout_seconds=_read_int(
                "OCR_CLOUD_TIMEOUT_SECONDS", 60, 1, 300
            ),
            total_timeout_seconds=_read_int(
                "OCR_CORRECTION_TOTAL_TIMEOUT_SECONDS",
                local.total_timeout_seconds,
                1,
                14400,
            ),
            local=local,
        )
