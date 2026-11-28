"""Capability-aware deadline AI router with quota-group circuit breakers & tenant-isolated cache.

Implements ADR-04 / ADR-07 for ViRead AI Smart Book Studio V2:
- Explicit per-provider capability matrix (prevents calling Groq/Ollama for unsupported image_gen).
- Per-attempt deadline + total task budget (never stacks multiple long cloud timeouts).
- Per-provider AND per-quota-group circuit breakers with exponential cooldown & half-open recovery
  (including Groq 429/5xx family/quota-group tripping and Gemini 429 `limit:0` long cooldown).
- Strict error taxonomy with zero retries on 401/403/404/UNSUPPORTED_CAPABILITY/UNSAFE_OUTPUT.
- Tenant-isolated versioned deterministic cache (never shares private parent data across accounts;
  never caches provider errors).
- Real capability-checked image generation dispatch for Cloudflare Workers AI Free FLUX,
  Local Diffusers HTTP, and Gemini Image (billing opt-in, circuit-broken on `limit:0`).
"""

from __future__ import annotations

import asyncio
import base64
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
import hashlib
import json
import logging
import os
import threading
import time
from typing import Any, Generic, TypeVar
from urllib.parse import urlparse

import httpx

from app.services.cloud_ai_defaults import (
    DEFAULT_GEMINI_ALIAS_MODEL,
    DEFAULT_GEMINI_FALLBACK_MODEL,
    DEFAULT_GEMINI_PRIMARY_MODEL,
    DEFAULT_GROQ_MULTIMODAL_MODEL,
    strip_env_value,
)
from app.services.smart_studio_flags import SmartStudioFlags

logger = logging.getLogger(__name__)

T = TypeVar("T")


class AiCapability(str, Enum):
    TEXT_ANALYSIS = "text_analysis"
    VISION_ANALYSIS = "vision_analysis"
    STRUCTURED_JSON = "structured_json"
    LAYOUT_CLASSIFICATION = "layout_classification"
    OCR_PROOFREADING = "ocr_proofreading"
    CHILD_SAFETY = "child_safety"
    ILLUSTRATION_PLANNING = "illustration_planning"
    IMAGE_GENERATION = "image_generation"
    IMAGE_EDITING = "image_editing"
    INPAINTING = "inpainting"


ALL_TEXT_VISION_CAPABILITIES: frozenset[AiCapability] = frozenset(
    {
        AiCapability.TEXT_ANALYSIS,
        AiCapability.VISION_ANALYSIS,
        AiCapability.STRUCTURED_JSON,
        AiCapability.LAYOUT_CLASSIFICATION,
        AiCapability.OCR_PROOFREADING,
        AiCapability.CHILD_SAFETY,
        AiCapability.ILLUSTRATION_PLANNING,
    }
)


class AiErrorKind(str, Enum):
    UNSUPPORTED_CAPABILITY = "UNSUPPORTED_CAPABILITY"
    AUTH_FAILURE = "AUTH_FAILURE"
    PERMISSION_FAILURE = "PERMISSION_FAILURE"
    QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"
    RATE_LIMIT = "RATE_LIMIT"
    TIMEOUT = "TIMEOUT"
    INVALID_OUTPUT = "INVALID_OUTPUT"
    UNSAFE_OUTPUT = "UNSAFE_OUTPUT"
    NETWORK_ERROR = "NETWORK_ERROR"
    OUT_OF_MEMORY = "OUT_OF_MEMORY"


NON_RETRYABLE_ERROR_KINDS: frozenset[AiErrorKind] = frozenset(
    {
        AiErrorKind.UNSUPPORTED_CAPABILITY,
        AiErrorKind.AUTH_FAILURE,
        AiErrorKind.PERMISSION_FAILURE,
        AiErrorKind.UNSAFE_OUTPUT,
    }
)

# Errors that trip the shared quota_group circuit in addition to the single provider circuit.
QUOTA_GROUP_TRIPPING_ERRORS: frozenset[AiErrorKind] = frozenset(
    {
        AiErrorKind.AUTH_FAILURE,
        AiErrorKind.PERMISSION_FAILURE,
        AiErrorKind.QUOTA_EXHAUSTED,
        AiErrorKind.RATE_LIMIT,
    }
)

# Errors that trip at least the provider circuit breaker (including 429 & 5xx on Groq/Gemini).
PROVIDER_CIRCUIT_TRIPPING_ERRORS: frozenset[AiErrorKind] = frozenset(
    {
        AiErrorKind.AUTH_FAILURE,
        AiErrorKind.PERMISSION_FAILURE,
        AiErrorKind.QUOTA_EXHAUSTED,
        AiErrorKind.RATE_LIMIT,
        AiErrorKind.TIMEOUT,
        AiErrorKind.NETWORK_ERROR,
        AiErrorKind.OUT_OF_MEMORY,
        AiErrorKind.UNSUPPORTED_CAPABILITY,
    }
)


class CircuitState(str, Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class AiProviderCallError(RuntimeError):
    """Classified provider invocation error containing zero secrets or raw bodies."""

    def __init__(
        self,
        *,
        provider_id: str,
        kind: AiErrorKind,
        code: str | None = None,
        http_status: int | None = None,
        limit_zero: bool = False,
        retry_after_seconds: float | None = None,
        trips_quota_group: bool | None = None,
        safe_message: str | None = None,
    ) -> None:
        resolved_code = code or kind.value
        super().__init__(safe_message or resolved_code)
        self.provider_id = provider_id
        self.kind = kind
        self.code = resolved_code
        self.http_status = http_status
        self.limit_zero = limit_zero
        self.retry_after_seconds = retry_after_seconds
        self.trips_quota_group = (
            trips_quota_group
            if trips_quota_group is not None
            else (kind in QUOTA_GROUP_TRIPPING_ERRORS)
        )
        self.safe_message = safe_message or resolved_code


@dataclass(frozen=True)
class AttemptRecord:
    provider_id: str
    model_id: str
    family: str
    quota_group: str | None
    outcome: str
    error_kind: AiErrorKind | None = None
    http_status: int | None = None
    latency_ms: int = 0
    circuit_tripped: bool = False
    quota_group_tripped: bool = False


class AiRoutingError(RuntimeError):
    """Raised when capability routing exhausts all eligible providers, budget, or safety fails."""

    def __init__(
        self,
        *,
        kind: AiErrorKind,
        code: str,
        capability: AiCapability,
        attempts: Sequence[AttemptRecord] = (),
        safe_message: str | None = None,
    ) -> None:
        super().__init__(safe_message or code)
        self.kind = kind
        self.code = code
        self.capability = capability
        self.attempts = tuple(attempts)
        self.safe_message = safe_message or code


@dataclass(frozen=True)
class ProviderSpec:
    """Declarative capability & budget metadata for a single provider/model route."""

    provider_id: str
    family: str
    model_id: str
    capabilities: frozenset[AiCapability]
    quota_group: str | None = None
    is_local: bool = False
    enabled: bool = True
    max_attempt_timeout_seconds: float = 15.0
    priority_order: int = 100
    notes: str = ""

    def supports(self, capability: AiCapability) -> bool:
        return capability in self.capabilities


@dataclass(frozen=True)
class RouteResult(Generic[T]):
    value: T
    provider_id: str
    model_id: str
    family: str
    capability: AiCapability
    latency_ms: int
    cached: bool = False
    cache_key: str | None = None
    attempts: tuple[AttemptRecord, ...] = ()


@dataclass
class _CircuitEntry:
    state: CircuitState = CircuitState.CLOSED
    consecutive_failures: int = 0
    open_until: float = 0.0
    last_error_kind: AiErrorKind | None = None
    last_http_status: int | None = None
    last_failure_at: float | None = None
    last_success_at: float | None = None
    half_open_probe_in_flight: bool = False


class CircuitBreakerRegistry:
    """Thread-safe per-provider and per-quota-group circuit breaker with exponential cooldown."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        base_cooldown_seconds: float = 30.0,
        max_cooldown_seconds: float = 900.0,
        auth_cooldown_seconds: float = 3600.0,
        limit_zero_cooldown_seconds: float = 21600.0,
        deprecated_cooldown_seconds: float = 86400.0,
    ) -> None:
        self._clock = clock
        self._base_cooldown = max(0.01, float(base_cooldown_seconds))
        self._max_cooldown = max(self._base_cooldown, float(max_cooldown_seconds))
        self._auth_cooldown = max(self._base_cooldown, float(auth_cooldown_seconds))
        self._limit_zero_cooldown = max(self._base_cooldown, float(limit_zero_cooldown_seconds))
        self._deprecated_cooldown = max(self._base_cooldown, float(deprecated_cooldown_seconds))
        self._lock = threading.Lock()
        self._entries: dict[str, _CircuitEntry] = {}

    def _entry(self, key: str) -> _CircuitEntry:
        entry = self._entries.get(key)
        if entry is None:
            entry = _CircuitEntry()
            self._entries[key] = entry
        return entry

    def get_state(self, key: str) -> CircuitState:
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return CircuitState.CLOSED
            if entry.state == CircuitState.OPEN and now >= entry.open_until:
                return CircuitState.HALF_OPEN
            return entry.state

    def allow_request(self, key: str) -> tuple[bool, CircuitState]:
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry.state == CircuitState.CLOSED:
                return True, CircuitState.CLOSED
            if entry.state == CircuitState.OPEN:
                if now < entry.open_until:
                    return False, CircuitState.OPEN
                entry.state = CircuitState.HALF_OPEN
                entry.half_open_probe_in_flight = True
                return True, CircuitState.HALF_OPEN
            # HALF_OPEN: allow only one concurrent probe to avoid thundering herd.
            if entry.half_open_probe_in_flight:
                return False, CircuitState.HALF_OPEN
            entry.half_open_probe_in_flight = True
            return True, CircuitState.HALF_OPEN

    def record_success(self, key: str) -> None:
        now = self._clock()
        with self._lock:
            entry = self._entry(key)
            entry.state = CircuitState.CLOSED
            entry.consecutive_failures = 0
            entry.open_until = 0.0
            entry.last_error_kind = None
            entry.last_http_status = None
            entry.last_success_at = now
            entry.half_open_probe_in_flight = False

    def release_half_open_probe(self, key: str) -> None:
        """Release an acquired HALF_OPEN probe lock on non-circuit-tripping failures/cancellations."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None and entry.half_open_probe_in_flight:
                entry.half_open_probe_in_flight = False

    def record_failure(
        self,
        key: str,
        *,
        kind: AiErrorKind,
        http_status: int | None = None,
        limit_zero: bool = False,
        retry_after_seconds: float | None = None,
    ) -> float:
        now = self._clock()
        with self._lock:
            entry = self._entry(key)
            entry.consecutive_failures += 1
            entry.last_error_kind = kind
            entry.last_http_status = http_status
            entry.last_failure_at = now
            entry.half_open_probe_in_flight = False

            if limit_zero:
                cooldown = self._limit_zero_cooldown
            elif kind in (AiErrorKind.AUTH_FAILURE, AiErrorKind.PERMISSION_FAILURE):
                cooldown = self._auth_cooldown
            elif kind == AiErrorKind.UNSUPPORTED_CAPABILITY or http_status == 404:
                cooldown = self._deprecated_cooldown
            else:
                exp_cooldown = self._base_cooldown * (2 ** max(0, entry.consecutive_failures - 1))
                cooldown = min(self._max_cooldown, exp_cooldown)
                if retry_after_seconds is not None and retry_after_seconds > 0:
                    cooldown = max(cooldown, min(self._max_cooldown, float(retry_after_seconds)))

            entry.state = CircuitState.OPEN
            entry.open_until = now + cooldown
            return cooldown

    def reset(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._entries.clear()
            else:
                self._entries.pop(key, None)

    def snapshot(self) -> dict[str, dict[str, Any]]:
        now = self._clock()
        out: dict[str, dict[str, Any]] = {}
        with self._lock:
            for key, entry in sorted(self._entries.items()):
                effective_state = entry.state
                remaining_cooldown = 0.0
                if entry.state == CircuitState.OPEN:
                    if now >= entry.open_until:
                        effective_state = CircuitState.HALF_OPEN
                    else:
                        remaining_cooldown = round(max(0.0, entry.open_until - now), 2)
                out[key] = {
                    "state": effective_state.value,
                    "consecutive_failures": entry.consecutive_failures,
                    "cooldown_remaining_seconds": remaining_cooldown,
                    "last_error_kind": entry.last_error_kind.value if entry.last_error_kind else None,
                    "last_http_status": entry.last_http_status,
                }
        return out


@dataclass(frozen=True)
class CacheKeySpec:
    """Versioned, tenant-isolated cache key inputs. Never omits tenant_scope."""

    source_hash: str
    revision: str
    model_version: str
    prompt_version: str
    algorithm_version: str
    policy_version: str
    tenant_scope: str
    capability: str = ""

    def to_cache_key(self) -> str:
        clean_scope = self.tenant_scope.strip()
        if not clean_scope:
            raise ValueError("tenant_scope must be non-empty for AI cache isolation")
        canonical = json.dumps(
            {
                "source_hash": self.source_hash,
                "revision": self.revision,
                "model_version": self.model_version,
                "prompt_version": self.prompt_version,
                "algorithm_version": self.algorithm_version,
                "policy_version": self.policy_version,
                "tenant_scope": clean_scope,
                "capability": self.capability,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return f"{clean_scope}:{digest}"


def build_tenant_cache_key(
    *,
    source_hash: str,
    revision: str,
    model_version: str,
    prompt_version: str,
    algorithm_version: str,
    policy_version: str,
    tenant_scope: str,
    capability: AiCapability | str = "",
) -> str:
    cap_str = capability.value if isinstance(capability, AiCapability) else str(capability)
    return CacheKeySpec(
        source_hash=source_hash,
        revision=revision,
        model_version=model_version,
        prompt_version=prompt_version,
        algorithm_version=algorithm_version,
        policy_version=policy_version,
        tenant_scope=tenant_scope,
        capability=cap_str,
    ).to_cache_key()


@dataclass
class _CacheRecord:
    value: Any
    provider_id: str
    model_id: str
    family: str
    tenant_scope: str
    expires_at: float


class TenantAiCache:
    """Bounded in-memory LRU cache isolated by tenant_scope. Never stores provider errors."""

    def __init__(
        self,
        *,
        max_entries: int = 256,
        default_ttl_seconds: float = 3600.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_entries = max(1, int(max_entries))
        self._default_ttl = max(1.0, float(default_ttl_seconds))
        self._clock = clock
        self._lock = threading.Lock()
        self._store: OrderedDict[str, _CacheRecord] = OrderedDict()

    def get(self, key: str, *, expected_tenant_scope: str | None = None) -> _CacheRecord | None:
        now = self._clock()
        with self._lock:
            rec = self._store.get(key)
            if rec is None:
                return None
            if now >= rec.expires_at:
                self._store.pop(key, None)
                return None
            if expected_tenant_scope is not None and rec.tenant_scope != expected_tenant_scope:
                return None
            self._store.move_to_end(key)
            return rec

    def put(
        self,
        key: str,
        *,
        value: Any,
        provider_id: str,
        model_id: str,
        family: str,
        tenant_scope: str,
        ttl_seconds: float | None = None,
    ) -> None:
        # Never cache exceptions / error markers.
        if isinstance(value, BaseException):
            return
        ttl = self._default_ttl if ttl_seconds is None else max(1.0, float(ttl_seconds))
        expires_at = self._clock() + ttl
        with self._lock:
            if key in self._store:
                self._store.pop(key, None)
            while len(self._store) >= self._max_entries:
                self._store.popitem(last=False)
            self._store[key] = _CacheRecord(
                value=value,
                provider_id=provider_id,
                model_id=model_id,
                family=family,
                tenant_scope=tenant_scope,
                expires_at=expires_at,
            )

    def clear_tenant(self, tenant_scope: str) -> int:
        removed = 0
        with self._lock:
            for key in [k for k, rec in self._store.items() if rec.tenant_scope == tenant_scope]:
                self._store.pop(key, None)
                removed += 1
        return removed

    def clear_all(self) -> None:
        with self._lock:
            self._store.clear()

    def size(self) -> int:
        with self._lock:
            return len(self._store)


def _env_bool(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = env.get(key)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _has_secret(env: Mapping[str, str], key: str) -> bool:
    return bool(strip_env_value(env.get(key)))


_MAX_IMAGE_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MiB hard cap on generated image responses


def build_default_provider_registry(
    env: Mapping[str, str] | None = None,
) -> tuple[ProviderSpec, ...]:
    """Build the capability matrix grounded in empirical 2025/2026 zero-cost probe findings."""
    source_env: Mapping[str, str] = os.environ if env is None else env
    cloud_ocr_enabled = _env_bool(source_env, "OCR_CLOUD_CORRECTION_ENABLED", False)
    ai_image_enabled = _env_bool(source_env, "SMART_AI_IMAGE_GEN_ENABLED", True)
    gemini_key_present = _has_secret(source_env, "GEMINI_API_KEY")
    groq_key_present = _has_secret(source_env, "GROQ_API_KEY")
    cloudflare_ready = (
        ai_image_enabled
        and _has_secret(source_env, "CLOUDFLARE_ACCOUNT_ID")
        and _has_secret(source_env, "CLOUDFLARE_API_TOKEN")
    )
    local_diffusers_ready = ai_image_enabled and _has_secret(source_env, "LOCAL_IMAGE_GEN_URL")
    # Strict 0 VND invariant: Gemini Image / Imagen is PAID-ONLY (limit: 0 on free tier)
    # and stays disabled unless an explicit paid opt-in flag is set.
    gemini_image_paid_opt_in = _env_bool(
        source_env, "GEMINI_IMAGE_GEN_PAID_OPT_IN", False
    ) or _env_bool(source_env, "GEMINI_IMAGE_BILLING_ENABLED", False)

    gemini_primary = (
        strip_env_value(source_env.get("GEMINI_OCR_PRIMARY_MODEL"))
        or strip_env_value(source_env.get("GEMINI_PRIMARY_MODEL"))
        or DEFAULT_GEMINI_PRIMARY_MODEL
    )
    gemini_fallback = (
        strip_env_value(source_env.get("GEMINI_OCR_FALLBACK_MODEL"))
        or strip_env_value(source_env.get("GEMINI_FALLBACK_MODEL"))
        or DEFAULT_GEMINI_FALLBACK_MODEL
    )
    groq_model = (
        strip_env_value(source_env.get("GROQ_OCR_MODEL"))
        or strip_env_value(source_env.get("GROQ_PRIMARY_MODEL"))
        or DEFAULT_GROQ_MULTIMODAL_MODEL
    )
    ollama_model = strip_env_value(source_env.get("LOCAL_OCR_MODEL")) or "qwen3-vl:4b-instruct-q4_K_M"
    cloudflare_model = (
        strip_env_value(source_env.get("CLOUDFLARE_IMAGE_MODEL"))
        or "@cf/black-forest-labs/flux-1-schnell"
    )
    local_diffusers_model = (
        strip_env_value(source_env.get("LOCAL_IMAGE_GEN_MODEL"))
        or "Lykon/dreamshaper-8+lcm-lora-sdv1-5"
    )
    gemini_image_model = (
        strip_env_value(source_env.get("GEMINI_IMAGE_MODEL")) or "gemini-2.5-flash-image"
    )

    return (
        ProviderSpec(
            provider_id="gemini_primary",
            family="google",
            model_id=gemini_primary,
            capabilities=ALL_TEXT_VISION_CAPABILITIES,
            quota_group="gemini_free_shared",
            is_local=False,
            enabled=cloud_ocr_enabled and gemini_key_present,
            max_attempt_timeout_seconds=12.0,
            priority_order=10,
            notes="Verified fast primary Gemini Free Tier model for text/vision/JSON.",
        ),
        ProviderSpec(
            provider_id="gemini_fallback",
            family="google",
            model_id=gemini_fallback,
            capabilities=ALL_TEXT_VISION_CAPABILITIES,
            quota_group="gemini_free_shared",
            is_local=False,
            enabled=cloud_ocr_enabled and gemini_key_present,
            max_attempt_timeout_seconds=12.0,
            priority_order=20,
            notes="Secondary Gemini Free Tier model (shares gemini_free_shared quota group).",
        ),
        ProviderSpec(
            provider_id="gemini_alias",
            family="google",
            model_id=DEFAULT_GEMINI_ALIAS_MODEL,
            capabilities=ALL_TEXT_VISION_CAPABILITIES,
            quota_group="gemini_free_shared",
            is_local=False,
            enabled=cloud_ocr_enabled and gemini_key_present,
            max_attempt_timeout_seconds=12.0,
            priority_order=25,
            notes="Gemini Flash-Lite alias (shares gemini_free_shared quota group).",
        ),
        ProviderSpec(
            provider_id="groq_qwen",
            family="groq",
            model_id=groq_model,
            capabilities=ALL_TEXT_VISION_CAPABILITIES,
            quota_group="groq_free_shared",
            is_local=False,
            enabled=cloud_ocr_enabled and groq_key_present,
            max_attempt_timeout_seconds=12.0,
            priority_order=30,
            notes="Groq LPU fallback for text/vision/JSON; explicitly no image generation.",
        ),
        ProviderSpec(
            provider_id="ollama_local",
            family="ollama",
            model_id=ollama_model,
            capabilities=ALL_TEXT_VISION_CAPABILITIES,
            quota_group=None,
            is_local=True,
            enabled=True,
            max_attempt_timeout_seconds=45.0,
            priority_order=40,
            notes="100% local loopback privacy fallback for text/vision/JSON.",
        ),
        ProviderSpec(
            provider_id="cloudflare_flux",
            family="cloudflare",
            model_id=cloudflare_model,
            capabilities=frozenset({AiCapability.IMAGE_GENERATION}),
            quota_group="cloudflare_workers_ai_daily",
            is_local=False,
            enabled=cloudflare_ready,
            max_attempt_timeout_seconds=25.0,
            priority_order=50,
            notes="Cloudflare Workers AI Free FLUX (10,000 Neurons/day).",
        ),
        ProviderSpec(
            provider_id="local_diffusers",
            family="local_diffusers",
            model_id=local_diffusers_model,
            capabilities=frozenset(
                {
                    AiCapability.IMAGE_GENERATION,
                    AiCapability.IMAGE_EDITING,
                    AiCapability.INPAINTING,
                }
            ),
            quota_group=None,
            is_local=True,
            enabled=local_diffusers_ready,
            max_attempt_timeout_seconds=35.0,
            priority_order=60,
            notes="Isolated local low-VRAM Diffusers HTTP sidecar worker.",
        ),
        ProviderSpec(
            provider_id="gemini_image",
            family="google",
            model_id=gemini_image_model,
            capabilities=frozenset(
                {
                    AiCapability.IMAGE_GENERATION,
                    AiCapability.IMAGE_EDITING,
                }
            ),
            quota_group="gemini_image_free",
            is_local=False,
            enabled=ai_image_enabled and gemini_key_present and gemini_image_paid_opt_in,
            max_attempt_timeout_seconds=20.0,
            priority_order=70,
            notes="Gemini native image model (disabled on Free Tier limit:0 unless paid opt-in).",
        ),
    )


def classify_http_error(
    *,
    provider_id: str,
    status_code: int,
    body_text: str = "",
    retry_after_header: str | None = None,
) -> AiProviderCallError:
    """Classify upstream HTTP failures into the canonical error taxonomy without leaking secrets."""
    lowered = body_text.lower()
    retry_after: float | None = None
    if retry_after_header:
        try:
            retry_after = max(1.0, float(retry_after_header.strip()))
        except ValueError:
            retry_after = None

    if status_code == 401:
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.AUTH_FAILURE,
            http_status=401,
            trips_quota_group=True,
        )
    if status_code == 403:
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.PERMISSION_FAILURE,
            http_status=403,
            trips_quota_group=True,
        )
    if status_code == 404:
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.UNSUPPORTED_CAPABILITY,
            code="MODEL_OR_CAPABILITY_NOT_FOUND",
            http_status=404,
            trips_quota_group=False,
        )
    if status_code == 429:
        is_limit_zero = "limit: 0" in lowered or "limit:0" in lowered
        is_quota = (
            is_limit_zero
            or "quota" in lowered
            or "resource_exhausted" in lowered
            or "daily" in lowered
            or "neuron" in lowered
        )
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.QUOTA_EXHAUSTED if is_quota else AiErrorKind.RATE_LIMIT,
            http_status=429,
            limit_zero=is_limit_zero,
            retry_after_seconds=retry_after,
            trips_quota_group=True,
        )
    if status_code in (500, 502, 503, 504):
        kind = AiErrorKind.TIMEOUT if status_code == 504 else AiErrorKind.NETWORK_ERROR
        return AiProviderCallError(
            provider_id=provider_id,
            kind=kind,
            code=f"HTTP_{status_code}",
            http_status=status_code,
            retry_after_seconds=retry_after,
            trips_quota_group=False,
        )
    if status_code in (400, 422):
        if "safety" in lowered or "unsafe" in lowered or "blocked" in lowered:
            return AiProviderCallError(
                provider_id=provider_id,
                kind=AiErrorKind.UNSAFE_OUTPUT,
                http_status=status_code,
                trips_quota_group=False,
            )
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.INVALID_OUTPUT,
            http_status=status_code,
            trips_quota_group=False,
        )
    return AiProviderCallError(
        provider_id=provider_id,
        kind=AiErrorKind.NETWORK_ERROR,
        code=f"HTTP_{status_code}",
        http_status=status_code,
        trips_quota_group=False,
    )


def classify_exception(provider_id: str, exc: BaseException) -> AiProviderCallError:
    """Normalize arbitrary exceptions from provider adapters into AiProviderCallError."""
    if isinstance(exc, AiProviderCallError):
        return exc
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException)):
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.TIMEOUT,
            http_status=504,
            trips_quota_group=False,
        )
    if isinstance(exc, MemoryError) or "out of memory" in str(exc).lower() or "cuda oom" in str(exc).lower():
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.OUT_OF_MEMORY,
            trips_quota_group=False,
        )
    if isinstance(exc, httpx.HTTPStatusError):
        return classify_http_error(
            provider_id=provider_id,
            status_code=exc.response.status_code,
            body_text=exc.response.text[:1024] if exc.response is not None else "",
            retry_after_header=(
                exc.response.headers.get("retry-after") if exc.response is not None else None
            ),
        )
    if isinstance(exc, httpx.RequestError):
        return AiProviderCallError(
            provider_id=provider_id,
            kind=AiErrorKind.NETWORK_ERROR,
            http_status=503,
            trips_quota_group=False,
        )
    # Compat with ocr_ai.exceptions.OcrProviderError
    upstream_status = getattr(exc, "upstream_status_code", None)
    if isinstance(upstream_status, int) and 400 <= upstream_status <= 599:
        return classify_http_error(
            provider_id=provider_id,
            status_code=upstream_status,
            body_text=str(getattr(exc, "code", "") or ""),
        )
    return AiProviderCallError(
        provider_id=provider_id,
        kind=AiErrorKind.NETWORK_ERROR,
        code=type(exc).__name__,
        trips_quota_group=False,
    )


@dataclass(frozen=True)
class ImageGenerationRequest:
    prompt: str
    negative_prompt: str = "text, letters, watermark, signature, logo, typography, captions"
    width: int = 512
    height: int = 512
    steps: int = 4
    seed: int | None = None
    tenant_scope: str = "admin:catalog"
    allow_cloud: bool = True
    source_hash: str | None = None
    revision: str = "v1"
    prompt_version: str = "v2.0"
    algorithm_version: str = "studio-v2"
    policy_version: str = "grade-1-5-safe"
    total_budget_seconds: float = 30.0


@dataclass(frozen=True)
class ImageGenerationResult:
    image_bytes: bytes
    mime_type: str
    provider_id: str
    model_id: str
    width: int
    height: int
    latency_ms: int
    cached: bool = False
    attempts: tuple[AttemptRecord, ...] = ()


def _validate_local_worker_url(
    raw_url: str,
    *,
    env: Mapping[str, str] | None = None,
) -> str:
    cleaned = raw_url.strip()
    parsed = urlparse(cleaned)
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not hostname:
        raise AiProviderCallError(
            provider_id="local_diffusers",
            kind=AiErrorKind.UNSUPPORTED_CAPABILITY,
            code="INVALID_LOCAL_IMAGE_URL",
        )
    allowed_hosts = {"127.0.0.1", "localhost", "::1"}
    source_env: Mapping[str, str] = os.environ if env is None else env
    allow_lan = _env_bool(source_env, "LOCAL_IMAGE_GEN_ALLOW_LAN", False)
    if hostname not in allowed_hosts and not allow_lan:
        raise AiProviderCallError(
            provider_id="local_diffusers",
            kind=AiErrorKind.PERMISSION_FAILURE,
            code="LOCAL_IMAGE_URL_NON_LOOPBACK",
        )
    normalized = cleaned.rstrip("/")
    if normalized.lower().endswith("/generate"):
        normalized = normalized[: -len("/generate")].rstrip("/")
    return normalized


class AiCapabilityRouter:
    """Capability-aware deadline router with circuit breakers & tenant-isolated cache."""

    def __init__(
        self,
        *,
        providers: Sequence[ProviderSpec] | None = None,
        circuit_breaker: CircuitBreakerRegistry | None = None,
        cache: TenantAiCache | None = None,
        clock: Callable[[], float] = time.monotonic,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self._env = env
        self._clock = clock
        self._explicit_providers: tuple[ProviderSpec, ...] | None = (
            tuple(sorted(providers, key=lambda item: item.priority_order))
            if providers is not None
            else None
        )
        self._static_env_providers: tuple[ProviderSpec, ...] | None = (
            tuple(
                sorted(
                    build_default_provider_registry(env=env),
                    key=lambda item: item.priority_order,
                )
            )
            if providers is None and env is not None
            else None
        )
        self.circuit_breaker = circuit_breaker or CircuitBreakerRegistry(clock=clock)
        self.cache = cache or TenantAiCache(clock=clock)

    @property
    def providers(self) -> tuple[ProviderSpec, ...]:
        if self._explicit_providers is not None:
            return self._explicit_providers
        if self._static_env_providers is not None:
            return self._static_env_providers
        return tuple(
            sorted(
                build_default_provider_registry(env=os.environ),
                key=lambda item: item.priority_order,
            )
        )

    @staticmethod
    def _provider_circuit_key(provider: ProviderSpec) -> str:
        return f"provider:{provider.provider_id}"

    @staticmethod
    def _quota_circuit_key(provider: ProviderSpec) -> str | None:
        return f"quota_group:{provider.quota_group}" if provider.quota_group else None

    def eligible_providers(
        self,
        capability: AiCapability,
        *,
        allow_cloud: bool = True,
        preferred_providers: Sequence[str] | None = None,
    ) -> list[ProviderSpec]:
        candidates = list(self.providers)
        if preferred_providers:
            rank = {pid: idx for idx, pid in enumerate(preferred_providers)}
            candidates.sort(key=lambda p: (rank.get(p.provider_id, 10_000), p.priority_order))
        result: list[ProviderSpec] = []
        for spec in candidates:
            if not spec.enabled:
                continue
            if not spec.supports(capability):
                continue
            if not allow_cloud and not spec.is_local:
                continue
            result.append(spec)
        return result

    async def route_and_execute(
        self,
        capability: AiCapability,
        handler: Callable[[ProviderSpec, float], Awaitable[T]],
        *,
        total_budget_seconds: float = 18.0,
        per_attempt_timeout_seconds: float | None = None,
        allow_cloud: bool = True,
        preferred_providers: Sequence[str] | None = None,
        cache_key: str | None = None,
        tenant_scope: str | None = None,
        cache_ttl_seconds: float | None = None,
        fail_closed_on_unsafe: bool = True,
    ) -> RouteResult[T]:
        """Route a capability call across eligible providers within strict deadline & circuit bounds."""
        started_total = self._clock()

        # 1. Tenant-isolated cache lookup (only when both cache_key and tenant_scope are supplied).
        if cache_key and tenant_scope:
            cached = self.cache.get(cache_key, expected_tenant_scope=tenant_scope)
            if cached is not None:
                return RouteResult(
                    value=cached.value,
                    provider_id=cached.provider_id,
                    model_id=cached.model_id,
                    family=cached.family,
                    capability=capability,
                    latency_ms=0,
                    cached=True,
                    cache_key=cache_key,
                    attempts=(),
                )

        task_deadline = started_total + max(0.01, float(total_budget_seconds))
        attempts: list[AttemptRecord] = []

        ordered = list(self.providers)
        if preferred_providers:
            rank = {pid: idx for idx, pid in enumerate(preferred_providers)}
            ordered.sort(key=lambda p: (rank.get(p.provider_id, 10_000), p.priority_order))

        last_error_kind: AiErrorKind | None = None
        last_error_code = "NO_ELIGIBLE_PROVIDER"
        eligible_seen = False

        for idx, provider in enumerate(ordered):
            if not provider.supports(capability):
                attempts.append(
                    AttemptRecord(
                        provider_id=provider.provider_id,
                        model_id=provider.model_id,
                        family=provider.family,
                        quota_group=provider.quota_group,
                        outcome="SKIPPED_UNSUPPORTED_CAPABILITY",
                        error_kind=AiErrorKind.UNSUPPORTED_CAPABILITY,
                    )
                )
                continue

            if not allow_cloud and not provider.is_local:
                attempts.append(
                    AttemptRecord(
                        provider_id=provider.provider_id,
                        model_id=provider.model_id,
                        family=provider.family,
                        quota_group=provider.quota_group,
                        outcome="SKIPPED_PRIVACY_POLICY",
                    )
                )
                continue

            if not provider.enabled:
                attempts.append(
                    AttemptRecord(
                        provider_id=provider.provider_id,
                        model_id=provider.model_id,
                        family=provider.family,
                        quota_group=provider.quota_group,
                        outcome="SKIPPED_UNCONFIGURED",
                    )
                )
                continue

            eligible_seen = True

            # Check shared quota-group circuit BEFORE individual provider circuit so sibling models
            # (e.g., gemini_fallback after gemini_primary hit 429) skip instantaneously!
            quota_key = self._quota_circuit_key(provider)
            quota_probe_acquired = False
            if quota_key is not None:
                allowed_group, group_state = self.circuit_breaker.allow_request(quota_key)
                if not allowed_group:
                    last_error_kind = AiErrorKind.QUOTA_EXHAUSTED
                    last_error_code = f"QUOTA_GROUP_CIRCUIT_{group_state.value}"
                    attempts.append(
                        AttemptRecord(
                            provider_id=provider.provider_id,
                            model_id=provider.model_id,
                            family=provider.family,
                            quota_group=provider.quota_group,
                            outcome="SKIPPED_QUOTA_GROUP_CIRCUIT_OPEN",
                            error_kind=AiErrorKind.QUOTA_EXHAUSTED,
                        )
                    )
                    continue
                quota_probe_acquired = group_state == CircuitState.HALF_OPEN

            provider_key = self._provider_circuit_key(provider)
            allowed_prov, prov_state = self.circuit_breaker.allow_request(provider_key)
            if not allowed_prov:
                if quota_key is not None and quota_probe_acquired:
                    self.circuit_breaker.release_half_open_probe(quota_key)
                last_error_kind = last_error_kind or AiErrorKind.NETWORK_ERROR
                last_error_code = f"PROVIDER_CIRCUIT_{prov_state.value}"
                attempts.append(
                    AttemptRecord(
                        provider_id=provider.provider_id,
                        model_id=provider.model_id,
                        family=provider.family,
                        quota_group=provider.quota_group,
                        outcome="SKIPPED_CIRCUIT_OPEN",
                    )
                )
                continue
            prov_probe_acquired = prov_state == CircuitState.HALF_OPEN

            remaining_budget = task_deadline - self._clock()
            if remaining_budget <= 0.001:
                if prov_probe_acquired:
                    self.circuit_breaker.release_half_open_probe(provider_key)
                if quota_key is not None and quota_probe_acquired:
                    self.circuit_breaker.release_half_open_probe(quota_key)
                attempts.append(
                    AttemptRecord(
                        provider_id=provider.provider_id,
                        model_id=provider.model_id,
                        family=provider.family,
                        quota_group=provider.quota_group,
                        outcome="SKIPPED_DEADLINE_EXHAUSTED",
                        error_kind=AiErrorKind.TIMEOUT,
                    )
                )
                raise AiRoutingError(
                    kind=AiErrorKind.TIMEOUT,
                    code="TASK_DEADLINE_EXHAUSTED",
                    capability=capability,
                    attempts=attempts,
                )

            # Fair-share deadline partitioning so slow Cloud 1 never starves fallback providers.
            remaining_candidates = [
                cand
                for cand in ordered[idx:]
                if cand.enabled
                and cand.supports(capability)
                and (allow_cloud or cand.is_local)
            ]
            has_remaining_local = any(c.is_local for c in remaining_candidates)
            cap_timeout = (
                float(per_attempt_timeout_seconds)
                if per_attempt_timeout_seconds is not None
                else float(provider.max_attempt_timeout_seconds)
            )
            if not provider.is_local and len(remaining_candidates) > 1:
                if has_remaining_local:
                    # Reserve at least 35% of remaining budget for local fallback when available.
                    cloud_slice = (remaining_budget * 0.65) / max(
                        1, sum(1 for c in remaining_candidates if not c.is_local)
                    )
                    attempt_timeout = min(remaining_budget, cap_timeout, max(0.05, cloud_slice))
                else:
                    attempt_timeout = min(remaining_budget, cap_timeout)
            else:
                attempt_timeout = min(remaining_budget, cap_timeout)

            attempt_start = self._clock()
            prov_finalized = False
            quota_finalized = False
            try:
                value = await asyncio.wait_for(
                    handler(provider, attempt_timeout),
                    timeout=attempt_timeout,
                )
            except BaseException as exc:
                if isinstance(exc, asyncio.CancelledError):
                    raise
                classified = classify_exception(provider.provider_id, exc)
                elapsed_ms = max(0, int((self._clock() - attempt_start) * 1000))
                last_error_kind = classified.kind
                last_error_code = classified.code

                circuit_tripped = False
                quota_tripped = False

                if classified.kind in PROVIDER_CIRCUIT_TRIPPING_ERRORS:
                    self.circuit_breaker.record_failure(
                        provider_key,
                        kind=classified.kind,
                        http_status=classified.http_status,
                        limit_zero=classified.limit_zero,
                        retry_after_seconds=classified.retry_after_seconds,
                    )
                    circuit_tripped = True
                    prov_finalized = True

                if quota_key is not None and classified.trips_quota_group:
                    self.circuit_breaker.record_failure(
                        quota_key,
                        kind=classified.kind,
                        http_status=classified.http_status,
                        limit_zero=classified.limit_zero,
                        retry_after_seconds=classified.retry_after_seconds,
                    )
                    quota_tripped = True
                    quota_finalized = True

                attempts.append(
                    AttemptRecord(
                        provider_id=provider.provider_id,
                        model_id=provider.model_id,
                        family=provider.family,
                        quota_group=provider.quota_group,
                        outcome="FAILED",
                        error_kind=classified.kind,
                        http_status=classified.http_status,
                        latency_ms=elapsed_ms,
                        circuit_tripped=circuit_tripped,
                        quota_group_tripped=quota_tripped,
                    )
                )

                # Unsafe output fails closed immediately — NEVER bypass child safety by trying another model!
                if classified.kind == AiErrorKind.UNSAFE_OUTPUT and fail_closed_on_unsafe:
                    raise AiRoutingError(
                        kind=AiErrorKind.UNSAFE_OUTPUT,
                        code=classified.code,
                        capability=capability,
                        attempts=attempts,
                    ) from None
                continue
            finally:
                if prov_probe_acquired and not prov_finalized:
                    self.circuit_breaker.release_half_open_probe(provider_key)
                if quota_key is not None and quota_probe_acquired and not quota_finalized:
                    self.circuit_breaker.release_half_open_probe(quota_key)

            # Provider succeeded! Reset circuits & populate tenant-isolated cache (never caching errors).
            elapsed_ms = max(0, int((self._clock() - attempt_start) * 1000))
            self.circuit_breaker.record_success(provider_key)
            if quota_key is not None:
                self.circuit_breaker.record_success(quota_key)
            attempts.append(
                AttemptRecord(
                    provider_id=provider.provider_id,
                    model_id=provider.model_id,
                    family=provider.family,
                    quota_group=provider.quota_group,
                    outcome="SUCCEEDED",
                    latency_ms=elapsed_ms,
                )
            )
            if cache_key and tenant_scope:
                self.cache.put(
                    cache_key,
                    value=value,
                    provider_id=provider.provider_id,
                    model_id=provider.model_id,
                    family=provider.family,
                    tenant_scope=tenant_scope,
                    ttl_seconds=cache_ttl_seconds,
                )
            return RouteResult(
                value=value,
                provider_id=provider.provider_id,
                model_id=provider.model_id,
                family=provider.family,
                capability=capability,
                latency_ms=elapsed_ms,
                cached=False,
                cache_key=cache_key,
                attempts=tuple(attempts),
            )

        if not eligible_seen:
            raise AiRoutingError(
                kind=AiErrorKind.UNSUPPORTED_CAPABILITY,
                code="NO_PROVIDER_AVAILABLE_FOR_CAPABILITY",
                capability=capability,
                attempts=attempts,
            )
        raise AiRoutingError(
            kind=last_error_kind or AiErrorKind.NETWORK_ERROR,
            code=last_error_code,
            capability=capability,
            attempts=attempts,
        )

    async def generate_image(
        self,
        request: ImageGenerationRequest,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> ImageGenerationResult:
        """Real capability-checked image generation dispatch across Cloudflare / Local Diffusers / Gemini."""
        source_hash = request.source_hash or hashlib.sha256(
            f"{request.prompt}|{request.negative_prompt}|{request.width}x{request.height}|{request.steps}|{request.seed}".encode(
                "utf-8"
            )
        ).hexdigest()
        cache_key = build_tenant_cache_key(
            source_hash=source_hash,
            revision=request.revision,
            model_version="image-gen-auto",
            prompt_version=request.prompt_version,
            algorithm_version=request.algorithm_version,
            policy_version=request.policy_version,
            tenant_scope=request.tenant_scope,
            capability=AiCapability.IMAGE_GENERATION,
        )
        source_env: Mapping[str, str] = os.environ if self._env is None else self._env

        async def _dispatch(provider: ProviderSpec, timeout_s: float) -> tuple[bytes, str]:
            if provider.family == "cloudflare":
                return await self._call_cloudflare_flux(
                    provider=provider,
                    request=request,
                    timeout_seconds=timeout_s,
                    env=source_env,
                    transport=transport,
                )
            if provider.family == "local_diffusers":
                return await self._call_local_diffusers(
                    provider=provider,
                    request=request,
                    timeout_seconds=timeout_s,
                    env=source_env,
                    transport=transport,
                )
            if provider.family == "google":
                return await self._call_gemini_image(
                    provider=provider,
                    request=request,
                    timeout_seconds=timeout_s,
                    env=source_env,
                    transport=transport,
                )
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.UNSUPPORTED_CAPABILITY,
                code="IMAGE_ADAPTER_NOT_IMPLEMENTED",
            )

        routed = await self.route_and_execute(
            AiCapability.IMAGE_GENERATION,
            _dispatch,
            total_budget_seconds=request.total_budget_seconds,
            allow_cloud=request.allow_cloud,
            cache_key=cache_key,
            tenant_scope=request.tenant_scope,
        )
        image_bytes, mime_type = routed.value
        return ImageGenerationResult(
            image_bytes=image_bytes,
            mime_type=mime_type,
            provider_id=routed.provider_id,
            model_id=routed.model_id,
            width=request.width,
            height=request.height,
            latency_ms=routed.latency_ms,
            cached=routed.cached,
            attempts=routed.attempts,
        )

    async def _call_cloudflare_flux(
        self,
        *,
        provider: ProviderSpec,
        request: ImageGenerationRequest,
        timeout_seconds: float,
        env: Mapping[str, str],
        transport: httpx.AsyncBaseTransport | None,
    ) -> tuple[bytes, str]:
        account_id = (env.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
        api_token = (env.get("CLOUDFLARE_API_TOKEN") or "").strip()
        if not account_id or not api_token:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.AUTH_FAILURE,
                code="CLOUDFLARE_CREDENTIALS_MISSING",
            )
        url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{provider.model_id}"
        payload: dict[str, Any] = {
            "prompt": request.prompt,
            "num_steps": max(1, min(8, int(request.steps))),
            "width": request.width,
            "height": request.height,
        }
        if request.seed is not None:
            payload["seed"] = int(request.seed)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {api_token}"},
                json=payload,
            )
        if response.status_code != 200:
            raise classify_http_error(
                provider_id=provider.provider_id,
                status_code=response.status_code,
                body_text=response.text[:1024],
                retry_after_header=response.headers.get("retry-after"),
            )
        if len(response.content) > _MAX_IMAGE_RESPONSE_BYTES:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="IMAGE_RESPONSE_TOO_LARGE",
            )
        content_type = (response.headers.get("content-type") or "").lower()
        if content_type.startswith("image/"):
            if not response.content:
                raise AiProviderCallError(
                    provider_id=provider.provider_id,
                    kind=AiErrorKind.INVALID_OUTPUT,
                    code="EMPTY_IMAGE_BODY",
                )
            return response.content, content_type.split(";")[0].strip()
        try:
            body = response.json()
            b64_img = body.get("result", {}).get("image") if isinstance(body, dict) else None
            if not isinstance(b64_img, str) or not b64_img.strip():
                raise ValueError("missing image")
            decoded = base64.b64decode(b64_img)
            if not decoded or len(decoded) > _MAX_IMAGE_RESPONSE_BYTES:
                raise ValueError("decoded image size invalid")
            return decoded, "image/jpeg"
        except Exception as exc:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="INVALID_CLOUDFLARE_IMAGE_RESPONSE",
            ) from exc

    async def _call_local_diffusers(
        self,
        *,
        provider: ProviderSpec,
        request: ImageGenerationRequest,
        timeout_seconds: float,
        env: Mapping[str, str],
        transport: httpx.AsyncBaseTransport | None,
    ) -> tuple[bytes, str]:
        raw_url = (env.get("LOCAL_IMAGE_GEN_URL") or "").strip()
        if not raw_url:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.UNSUPPORTED_CAPABILITY,
                code="LOCAL_IMAGE_WORKER_UNCONFIGURED",
            )
        base_url = _validate_local_worker_url(raw_url, env=env)
        payload: dict[str, Any] = {
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt,
            "width": request.width,
            "height": request.height,
            "steps": max(1, min(12, int(request.steps))),
            "seed": int(request.seed) if request.seed is not None else None,
        }
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.post(f"{base_url.rstrip('/')}/generate", json=payload)
        if response.status_code != 200:
            raise classify_http_error(
                provider_id=provider.provider_id,
                status_code=response.status_code,
                body_text=response.text[:1024],
                retry_after_header=response.headers.get("retry-after"),
            )
        if len(response.content) > _MAX_IMAGE_RESPONSE_BYTES:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="IMAGE_RESPONSE_TOO_LARGE",
            )
        content_type = (response.headers.get("content-type") or "").lower()
        if content_type.startswith("image/"):
            if not response.content:
                raise AiProviderCallError(
                    provider_id=provider.provider_id,
                    kind=AiErrorKind.INVALID_OUTPUT,
                    code="EMPTY_IMAGE_BODY",
                )
            return response.content, content_type.split(";")[0].strip()
        try:
            body = response.json()
            b64_img = body.get("image_base64") or body.get("image")
            mime = str(body.get("mime_type") or "image/png")
            if not isinstance(b64_img, str) or not b64_img.strip():
                raise ValueError("missing image_base64")
            decoded = base64.b64decode(b64_img)
            if not decoded or len(decoded) > _MAX_IMAGE_RESPONSE_BYTES:
                raise ValueError("decoded image size invalid")
            return decoded, mime
        except Exception as exc:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="INVALID_LOCAL_DIFFUSERS_RESPONSE",
            ) from exc

    async def _call_gemini_image(
        self,
        *,
        provider: ProviderSpec,
        request: ImageGenerationRequest,
        timeout_seconds: float,
        env: Mapping[str, str],
        transport: httpx.AsyncBaseTransport | None,
    ) -> tuple[bytes, str]:
        api_key = (env.get("GEMINI_API_KEY") or "").strip()
        if not api_key:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.AUTH_FAILURE,
                code="GEMINI_API_KEY_MISSING",
            )
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{provider.model_id}:generateContent"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": request.prompt}]}],
            "generationConfig": {"responseModalities": ["IMAGE"]},
        }
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.post(
                url,
                headers={"x-goog-api-key": api_key},
                json=payload,
            )
        if response.status_code != 200:
            raise classify_http_error(
                provider_id=provider.provider_id,
                status_code=response.status_code,
                body_text=response.text[:1024],
                retry_after_header=response.headers.get("retry-after"),
            )
        if len(response.content) > _MAX_IMAGE_RESPONSE_BYTES:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="IMAGE_RESPONSE_TOO_LARGE",
            )
        try:
            data = response.json()
            candidates = data.get("candidates") if isinstance(data, dict) else None
            parts = candidates[0]["content"]["parts"] if candidates else []
            for part in parts:
                inline = part.get("inlineData") or part.get("inline_data")
                if isinstance(inline, dict) and inline.get("data"):
                    mime = str(inline.get("mimeType") or inline.get("mime_type") or "image/png")
                    decoded = base64.b64decode(inline["data"])
                    if not decoded or len(decoded) > _MAX_IMAGE_RESPONSE_BYTES:
                        raise ValueError("decoded image size invalid")
                    return decoded, mime
            raise ValueError("no image inline data")
        except Exception as exc:
            raise AiProviderCallError(
                provider_id=provider.provider_id,
                kind=AiErrorKind.INVALID_OUTPUT,
                code="INVALID_GEMINI_IMAGE_RESPONSE",
            ) from exc

    def get_capabilities_snapshot(self) -> dict[str, Any]:
        """Return safe public capability matrix & circuit health (ZERO secrets/keys!)."""
        circuits = self.circuit_breaker.snapshot()
        providers_payload = []
        for spec in self.providers:
            prov_key = self._provider_circuit_key(spec)
            quota_key = self._quota_circuit_key(spec)
            prov_state = self.circuit_breaker.get_state(prov_key).value
            quota_state = (
                self.circuit_breaker.get_state(quota_key).value
                if quota_key is not None
                else CircuitState.CLOSED.value
            )
            providers_payload.append(
                {
                    "provider_id": spec.provider_id,
                    "family": spec.family,
                    "model_id": spec.model_id,
                    "quota_group": spec.quota_group,
                    "is_local": spec.is_local,
                    "enabled": spec.enabled,
                    "capabilities": sorted(cap.value for cap in spec.capabilities),
                    "max_attempt_timeout_seconds": spec.max_attempt_timeout_seconds,
                    "provider_circuit_state": prov_state,
                    "quota_group_circuit_state": quota_state,
                    "available_now": bool(
                        spec.enabled
                        and prov_state != CircuitState.OPEN.value
                        and quota_state != CircuitState.OPEN.value
                    ),
                    "notes": spec.notes,
                }
            )
        return {
            "feature_flags": SmartStudioFlags.from_environment().as_public_dict(),
            "providers": providers_payload,
            "circuit_breakers": circuits,
            "cache_entries": self.cache.size(),
        }


_SHARED_CIRCUIT_BREAKER_LOCK = threading.Lock()
_SHARED_CIRCUIT_BREAKER: CircuitBreakerRegistry | None = None

_DEFAULT_ROUTER_LOCK = threading.Lock()
_DEFAULT_ROUTER: AiCapabilityRouter | None = None


def get_shared_ai_circuit_breaker() -> CircuitBreakerRegistry:
    global _SHARED_CIRCUIT_BREAKER
    with _SHARED_CIRCUIT_BREAKER_LOCK:
        if _SHARED_CIRCUIT_BREAKER is None:
            _SHARED_CIRCUIT_BREAKER = CircuitBreakerRegistry()
        return _SHARED_CIRCUIT_BREAKER


def reset_shared_ai_circuit_breaker() -> None:
    global _SHARED_CIRCUIT_BREAKER
    with _SHARED_CIRCUIT_BREAKER_LOCK:
        if _SHARED_CIRCUIT_BREAKER is not None:
            _SHARED_CIRCUIT_BREAKER.reset()
        _SHARED_CIRCUIT_BREAKER = None


def get_default_ai_router() -> AiCapabilityRouter:
    global _DEFAULT_ROUTER
    with _DEFAULT_ROUTER_LOCK:
        if _DEFAULT_ROUTER is None:
            _DEFAULT_ROUTER = AiCapabilityRouter(
                circuit_breaker=get_shared_ai_circuit_breaker()
            )
        return _DEFAULT_ROUTER


def reset_default_ai_router() -> None:
    global _DEFAULT_ROUTER
    with _DEFAULT_ROUTER_LOCK:
        _DEFAULT_ROUTER = None
    reset_shared_ai_circuit_breaker()
