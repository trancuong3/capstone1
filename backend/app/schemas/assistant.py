from __future__ import annotations

import re
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

AssistantRoleScope = Literal["public", "parent", "admin"]
BandwidthProfile = Literal["low", "medium", "high"]
AssistantSourceTier = Literal[
    "cache",
    "tier_0_kb",
    "tier_1_cloud",
    "tier_2_ollama",
    "tier_3_fallback",
]

_LOCALE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_SAFE_PATH_RE = re.compile(r"^/[A-Za-z0-9/_-]{0,180}$")


def sanitize_current_path(raw: str | None) -> str:
    """Normalize client pathname into a safe relative path without query/hash/IDs."""
    if not raw or not isinstance(raw, str):
        return "/"
    trimmed = raw.strip().split("?", 1)[0].split("#", 1)[0]
    if not trimmed.startswith("/"):
        trimmed = "/" + trimmed
    collapsed = re.sub(r"/{2,}", "/", trimmed)
    if len(collapsed) > 1 and collapsed.endswith("/"):
        collapsed = collapsed.rstrip("/")
    if not _SAFE_PATH_RE.fullmatch(collapsed):
        return "/"
    return collapsed


class AssistantHistoryTurn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=1000)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        normalized = value.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized:
            raise ValueError("history content must not be empty")
        if any(ord(ch) < 32 and ch not in {"\n", "\t"} for ch in normalized):
            raise ValueError("history content contains unsupported control characters")
        return normalized


class AssistantChatRequest(BaseModel):
    """Client chat prompt for the ViRead tiered support assistant."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message: str = Field(min_length=1, max_length=800)
    current_path: str = Field(default="/", max_length=200)
    locale: str = Field(default="vi", max_length=16)
    bandwidth_profile: BandwidthProfile = "high"
    history: list[AssistantHistoryTurn] = Field(default_factory=list, max_length=8)
    force_llm: bool = False
    selected_child_id: str | None = Field(default=None, max_length=64)

    @field_validator("selected_child_id", mode="before")
    @classmethod
    def validate_selected_child_id(cls, value: Any) -> str | None:
        if value is None or not isinstance(value, str):
            return None
        cleaned = value.strip()
        if not cleaned or len(cleaned) > 64:
            return None
        try:
            return str(UUID(cleaned))
        except (ValueError, TypeError, AttributeError):
            return None

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        normalized = value.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized:
            raise ValueError("message must not be empty")
        if any(ord(ch) < 32 and ch not in {"\n", "\t"} for ch in normalized):
            raise ValueError("message contains unsupported control characters")
        return normalized

    @field_validator("current_path")
    @classmethod
    def validate_current_path(cls, value: str) -> str:
        return sanitize_current_path(value)

    @field_validator("locale")
    @classmethod
    def validate_locale(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned or not _LOCALE_RE.fullmatch(cleaned):
            return "vi"
        return cleaned


class AssistantQuickAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=80)
    href: str = Field(min_length=1, max_length=180)

    @field_validator("href")
    @classmethod
    def validate_internal_href(cls, value: str) -> str:
        if not value.startswith("/") or value.startswith("//") or "://" in value:
            raise ValueError("quick action href must be a safe internal path")
        return value


class AssistantNavigationOffer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=80)
    href: str = Field(min_length=1, max_length=180)
    reason: str | None = Field(default=None, max_length=160)
    requires_child_selection: bool = False
    scenario_id: str | None = Field(default=None, max_length=64)

    @field_validator("href")
    @classmethod
    def validate_internal_href(cls, value: str) -> str:
        if not value.startswith("/") or value.startswith("//") or "://" in value:
            raise ValueError("navigation offer href must be a safe internal path")
        return value


class AssistantChatResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reply: str
    source_tier: AssistantSourceTier
    provider_id: str
    model_id: str | None = None
    bandwidth_applied: BandwidthProfile
    latency_ms: int = Field(ge=0)
    cached: bool = False
    role_scope: AssistantRoleScope
    quick_actions: list[AssistantQuickAction] = Field(default_factory=list, max_length=3)
    suggested_prompts: list[str] = Field(default_factory=list, max_length=3)
    navigation_offer: AssistantNavigationOffer | None = None
    live_grounded: bool = False


class AssistantContextSuggestionsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_path: str
    page_title: str
    greeting: str
    suggested_prompts: list[str] = Field(default_factory=list, max_length=3)
    quick_actions: list[AssistantQuickAction] = Field(default_factory=list, max_length=3)


class AssistantTierStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tier: str
    provider_id: str
    family: str
    model_id: str | None = None
    is_local: bool
    enabled: bool
    available_now: bool
    circuit_state: str
    notes: str = ""


class AssistantStatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    allow_public_llm: bool
    tiers: list[AssistantTierStatus] = Field(default_factory=list)
    cache_entries: int = Field(ge=0)
    kb_article_count: int = Field(ge=0)
    bandwidth_profiles: dict[str, dict[str, Any]] = Field(default_factory=dict)
