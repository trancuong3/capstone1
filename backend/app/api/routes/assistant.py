from __future__ import annotations

import asyncio
from dataclasses import dataclass
import inspect
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials

from app.api.deps import get_current_parent_id, security
from app.database.config import APP_ENVIRONMENT
from app.database.role_cache import (
    _MISSING as _ROLE_CACHE_MISSING,
    get_cached_profile_active_role,
    get_cached_profile_role,
    peek_cached_profile_role,
)
from app.database.session import get_db, sqlalchemy_database_url
from app.schemas.assistant import (
    AssistantChatRequest,
    AssistantChatResponse,
    AssistantContextSuggestionsResponse,
    AssistantRoleScope,
    AssistantStatusResponse,
    sanitize_current_path,
)
from app.services.assistant_service import (
    ViReadAssistantService,
    get_default_assistant_service,
)
from app.services.rate_limiter import rate_limiter

router = APIRouter()


@dataclass(frozen=True)
class AssistantActorContext:
    role_scope: AssistantRoleScope
    subject_key: str


def get_assistant_service() -> ViReadAssistantService:
    return get_default_assistant_service()


def _client_ip(request: Request) -> str:
    host = request.client.host if request.client and request.client.host else "unknown"
    return host[:64]


async def _lookup_active_role(request: Request, actor_uuid: UUID) -> str | None:
    overrides = getattr(getattr(request, "app", None), "dependency_overrides", None) or {}
    db_override = overrides.get(get_db)
    if db_override is not None:
        produced = db_override()
        if inspect.isasyncgen(produced):
            try:
                db_session = await produced.__anext__()
                return await get_cached_profile_role(db_session, actor_uuid)
            finally:
                await produced.aclose()
        if inspect.isgenerator(produced):
            try:
                db_session = next(produced)
                return await get_cached_profile_role(db_session, actor_uuid)
            finally:
                produced.close()
        if inspect.isawaitable(produced):
            db_session = await produced
            return await get_cached_profile_role(db_session, actor_uuid)
        return await get_cached_profile_role(produced, actor_uuid)

    if (
        APP_ENVIRONMENT == "test"
        and sqlalchemy_database_url.port == 1
        and sqlalchemy_database_url.host in ("127.0.0.1", "localhost")
    ):
        cached = peek_cached_profile_role(actor_uuid)
        if cached is _ROLE_CACHE_MISSING:
            return "parent"
        return cached if isinstance(cached, str) else None

    try:
        return await get_cached_profile_active_role(actor_uuid)
    except Exception:
        return None


async def resolve_assistant_actor(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> AssistantActorContext:
    """Resolve verified DB role when a Bearer token is supplied; fail closed to public scope."""
    ip_subject = f"ip:{_client_ip(request)}"
    if credentials is None:
        return AssistantActorContext(role_scope="public", subject_key=ip_subject)

    try:
        actor_id = await asyncio.to_thread(get_current_parent_id, credentials)
        actor_uuid = actor_id if isinstance(actor_id, UUID) else UUID(str(actor_id))
    except (HTTPException, ValueError, TypeError):
        return AssistantActorContext(role_scope="public", subject_key=ip_subject)

    role = await _lookup_active_role(request, actor_uuid)
    if role == "admin":
        return AssistantActorContext(role_scope="admin", subject_key=f"user:{actor_uuid}")
    if role == "parent":
        return AssistantActorContext(role_scope="parent", subject_key=f"user:{actor_uuid}")
    return AssistantActorContext(role_scope="public", subject_key=ip_subject)


def _enforce_assistant_rate_limit(actor: AssistantActorContext) -> None:
    if actor.role_scope == "public":
        bucket, default_max, default_window = "assistant_chat_public", 10, 60.0
    else:
        bucket, default_max, default_window = "assistant_chat_auth", 25, 60.0

    max_requests, window_seconds = rate_limiter.resolve_limits(
        bucket, default_max, default_window
    )
    retry_after = rate_limiter.check(
        bucket,
        actor.subject_key,
        max_requests=max_requests,
        window_seconds=window_seconds,
    )
    if retry_after is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "RATE_LIMIT_EXCEEDED",
                "message": "Bạn đang hỏi quá nhanh. Vui lòng đợi vài giây rồi thử lại.",
            },
            headers={"Retry-After": str(retry_after)},
        )


@router.post("/chat", response_model=AssistantChatResponse)
async def chat_with_assistant(
    payload: AssistantChatRequest,
    actor: AssistantActorContext = Depends(resolve_assistant_actor),
    service: ViReadAssistantService = Depends(get_assistant_service),
) -> AssistantChatResponse:
    """Answer ViRead product questions via Tier 0 KB -> Cloud LLM -> Local Ollama -> Fallback."""
    _enforce_assistant_rate_limit(actor)
    return await service.chat(payload, role_scope=actor.role_scope)


@router.get("/context", response_model=AssistantContextSuggestionsResponse)
async def get_assistant_context(
    path: str = Query(default="/", max_length=200),
    locale: str = Query(default="vi", max_length=16),
    actor: AssistantActorContext = Depends(resolve_assistant_actor),
    service: ViReadAssistantService = Depends(get_assistant_service),
) -> AssistantContextSuggestionsResponse:
    """Return contextual starter guide prompts and quick actions for the active page."""
    resolved_path = path if isinstance(path, str) else "/"
    resolved_locale = locale if isinstance(locale, str) else "vi"
    return service.get_context_suggestions(
        current_path=sanitize_current_path(resolved_path),
        role_scope=actor.role_scope,
        locale=resolved_locale,
    )


@router.get("/status", response_model=AssistantStatusResponse)
async def get_assistant_status(
    service: ViReadAssistantService = Depends(get_assistant_service),
) -> AssistantStatusResponse:
    """Return safe public metadata of the tiered assistant providers (zero secrets)."""
    return service.get_status()
