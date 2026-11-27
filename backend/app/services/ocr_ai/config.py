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
    local_enabled: bool = True
    local: LocalOcrConfig = field(default_factory=LocalOcrConfig, repr=False)

    @property
    def gemini_enabled(self) -> bool:
        return self.cloud_enabled and self.gemini_api_key is not None

    @property
    def groq_enabled(self) -> bool:
        return self.cloud_enabled and self.groq_api_key is not None

    def local_only_copy(self) -> "OcrCorrectionConfig":
        """Return a config with cloud providers disabled, preserving local_enabled."""
        return OcrCorrectionConfig(
            cloud_enabled=False,
            gemini_api_key=None,
            groq_api_key=None,
            gemini_primary_model=self.gemini_primary_model,
            gemini_fallback_model=self.gemini_fallback_model,
            groq_model=self.groq_model,
            cloud_timeout_seconds=self.cloud_timeout_seconds,
            total_timeout_seconds=self.total_timeout_seconds,
            local_enabled=self.local_enabled,
            local=self.local,
        )

    @staticmethod
    def local_ollama_enabled() -> bool:
        """Detect whether a local Ollama daemon is expected on this runtime.

        Disabled automatically on Render / remote-worker web dynos unless
        `LOCAL_OCR_ENABLED=true` is explicitly set (ignoring copied loopback
        `LOCAL_OCR_BASE_URL` defaults).
        """
        explicit = os.getenv("LOCAL_OCR_ENABLED")
        if explicit is not None and explicit.strip() != "":
            return _read_bool("LOCAL_OCR_ENABLED", True)
        render_flag = (os.getenv("RENDER") or "").strip().lower() in {"1", "true", "yes", "on"}
        disable_heavy = (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        remote_ocr = (os.getenv("VIREAD_OCR_MODE") or "").strip().lower() == "remote_worker"
        if render_flag or disable_heavy or remote_ocr:
            return False
        if (os.getenv("LOCAL_OCR_BASE_URL") or "").strip():
            return True
        return True

    @staticmethod
    def _resolve_cloud_enabled(
        *,
        local_enabled: bool,
        gemini_api_key: str | None,
        groq_api_key: str | None,
    ) -> bool:
        raw_cloud = os.getenv("OCR_CLOUD_CORRECTION_ENABLED")
        if raw_cloud is not None and raw_cloud.strip() != "":
            return _read_bool("OCR_CLOUD_CORRECTION_ENABLED", False)
        return (not local_enabled) and bool(gemini_api_key or groq_api_key)

    @staticmethod
    def private_book_allow_cloud_ai() -> bool:
        """Honor explicit PRIVATE_BOOK_ALLOW_CLOUD_AI; auto-allow on hosted Render when cloud AI is enabled and local Ollama is disabled."""
        explicit = os.getenv("PRIVATE_BOOK_ALLOW_CLOUD_AI")
        if explicit is not None and explicit.strip() != "":
            return _read_bool("PRIVATE_BOOK_ALLOW_CLOUD_AI", False)
        if not OcrCorrectionConfig.local_ollama_enabled():
            try:
                return OcrCorrectionConfig._resolve_cloud_enabled(
                    local_enabled=False,
                    gemini_api_key=_optional_secret("GEMINI_API_KEY"),
                    groq_api_key=_optional_secret("GROQ_API_KEY"),
                )
            except OcrConfigurationError:
                return False
        return False

    @classmethod
    def from_environment_for_private_book(cls) -> "OcrCorrectionConfig":
        config = cls.from_environment()
        if not cls.private_book_allow_cloud_ai():
            return config.local_only_copy()
        return config

    @classmethod
    def from_environment(cls) -> "OcrCorrectionConfig":
        local_enabled = cls.local_ollama_enabled()
        gemini_api_key = _optional_secret("GEMINI_API_KEY")
        groq_api_key = _optional_secret("GROQ_API_KEY")
        try:
            local = LocalOcrConfig.from_environment()
        except LocalCorrectionError as exc:
            if not local_enabled and not (os.getenv("LOCAL_OCR_BASE_URL") or "").strip():
                local = LocalOcrConfig()
            else:
                raise OcrConfigurationError("INVALID_LOCAL_OCR_CONFIGURATION") from exc
        return cls(
            cloud_enabled=cls._resolve_cloud_enabled(
                local_enabled=local_enabled,
                gemini_api_key=gemini_api_key,
                groq_api_key=groq_api_key,
            ),
            gemini_api_key=gemini_api_key,
            groq_api_key=groq_api_key,
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
            local_enabled=local_enabled,
            local=local,
        )
