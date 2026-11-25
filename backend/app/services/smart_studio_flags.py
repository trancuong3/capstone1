"""Feature flags for ViRead AI Smart Book Studio V2 (safe rollout & shadow mode)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

OcrFilterMode = Literal["off", "shadow", "active"]


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class SmartStudioFlags:
    ocr_filter_mode: OcrFilterMode
    semantic_layout_enabled: bool
    cover_studio_enabled: bool
    illustration_extract_enabled: bool
    ai_image_gen_enabled: bool
    global_task_center_enabled: bool
    local_image_worker_url: str | None

    @classmethod
    def from_environment(cls) -> "SmartStudioFlags":
        raw_mode = (os.getenv("SMART_OCR_FILTER_MODE") or "active").strip().lower()
        mode: OcrFilterMode = (
            raw_mode if raw_mode in ("off", "shadow", "active") else "active"  # type: ignore[assignment]
        )
        local_url = (os.getenv("LOCAL_IMAGE_GEN_URL") or "").strip() or None
        return cls(
            ocr_filter_mode=mode,
            semantic_layout_enabled=_env_bool("SMART_SEMANTIC_LAYOUT_ENABLED", True),
            cover_studio_enabled=_env_bool("SMART_COVER_STUDIO_ENABLED", True),
            illustration_extract_enabled=_env_bool("SMART_ILLUSTRATION_EXTRACT_ENABLED", True),
            ai_image_gen_enabled=_env_bool("SMART_AI_IMAGE_GEN_ENABLED", True),
            global_task_center_enabled=_env_bool("SMART_GLOBAL_TASK_CENTER_ENABLED", True),
            local_image_worker_url=local_url,
        )

    def as_public_dict(self) -> dict[str, object]:
        return {
            "ocr_filter_mode": self.ocr_filter_mode,
            "semantic_layout_enabled": self.semantic_layout_enabled,
            "cover_studio_enabled": self.cover_studio_enabled,
            "illustration_extract_enabled": self.illustration_extract_enabled,
            "ai_image_gen_enabled": self.ai_image_gen_enabled,
            "global_task_center_enabled": self.global_task_center_enabled,
            "local_image_worker_configured": self.local_image_worker_url is not None,
        }
