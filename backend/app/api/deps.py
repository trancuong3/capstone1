import asyncio
import base64
import hashlib
import inspect
import json
import logging
import os
import threading
import time
import weakref
from uuid import UUID

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import APP_ENVIRONMENT, SUPABASE_KEY, SUPABASE_URL
from app.database.role_cache import (
    _MISSING as _ROLE_CACHE_MISSING,
    get_cached_profile_active_role,
    get_cached_profile_role,
    peek_cached_profile_role,
)
from app.database.session import get_db, sqlalchemy_database_url
from app.database.supabase_client import get_supabase_client, reset_supabase_client
from app.diagnostic_logging import log_diagnostic


logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)

_ORIG_GET_SUPABASE_CLIENT = get_supabase_client
_REAL_HTTPX_ASYNC_CLIENT = httpx.AsyncClient
_AUTH_HTTP_TIMEOUT = httpx.Timeout(8.0, connect=4.0, read=8.0, write=4.0, pool=4.0)
_AUTH_HTTP_LIMITS = httpx.Limits(
    max_connections=20,
    max_keepalive_connections=10,
    keepalive_expiry=30.0,
)
_AUTH_HTTP_CLIENTS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = (
    weakref.WeakKeyDictionary()
)


class _AuthProviderStatusError(Exception):
    """Internal marker preserving provider HTTP status without secret details."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"provider_status_{status_code}")
        self.status_code = status_code


def _is_retryable_auth_http_status(status_code: int) -> bool:
    return status_code in {408, 429, 502, 503, 504} or 520 <= status_code <= 530


def _build_auth_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        http2=True,
        trust_env=False,
        timeout=_AUTH_HTTP_TIMEOUT,
        limits=_AUTH_HTTP_LIMITS,
    )


def _get_auth_http_client() -> httpx.AsyncClient | None:
    if httpx.AsyncClient is not _REAL_HTTPX_ASYNC_CLIENT:
        return None
    loop = asyncio.get_running_loop()
    client = _AUTH_HTTP_CLIENTS.get(loop)
    if client is not None and not getattr(client, "is_closed", False):
        return client
    client = _build_auth_http_client()
    _AUTH_HTTP_CLIENTS[loop] = client
    return client


async def _evict_auth_http_client(
    expected_client: httpx.AsyncClient | None = None,
) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if expected_client is not None and _AUTH_HTTP_CLIENTS.get(loop) is not expected_client:
        return
    client = _AUTH_HTTP_CLIENTS.pop(loop, None)
    if client is not None and not getattr(client, "is_closed", False):
        aclose = getattr(client, "aclose", None)
        if callable(aclose):
            try:
                await aclose()
            except Exception:
                pass


async def aclose_auth_http_clients() -> None:
    """Close pooled async HTTP clients used for Supabase Auth verification on shutdown."""
    clients = list(_AUTH_HTTP_CLIENTS.values())
    _AUTH_HTTP_CLIENTS.clear()
    for client in clients:
        aclose = getattr(client, "aclose", None)
        if callable(aclose) and not getattr(client, "is_closed", False):
            try:
                await aclose()
            except Exception:
                pass

_AUTH_CACHE_LOCK = threading.Lock()
_AUTH_CACHE_MAX_ENTRIES = 512
_AUTH_CACHE: dict[str, tuple[UUID, float]] = {}


def clear_auth_token_cache() -> None:
    """Clear the short-lived in-memory Supabase token verification cache."""
    with _AUTH_CACHE_LOCK:
        _AUTH_CACHE.clear()


def invalidate_auth_cache_for_actor(actor_id: UUID) -> int:
    """Evict all cached bearer tokens belonging to `actor_id`."""
    removed = 0
    with _AUTH_CACHE_LOCK:
        stale_keys = [
            key
            for key, (cached_actor_id, _) in _AUTH_CACHE.items()
            if cached_actor_id == actor_id
        ]
        for key in stale_keys:
            _AUTH_CACHE.pop(key, None)
            removed += 1
    return removed


def _auth_token_cache_ttl_seconds() -> float:
    raw = os.getenv("AUTH_TOKEN_CACHE_TTL_SECONDS")
    if raw is not None and raw.strip() != "":
        try:
            return max(0.0, min(300.0, float(raw.strip())))
        except ValueError:
            return 0.0
    return 0.0 if APP_ENVIRONMENT == "test" else 180.0


def _jwt_exp_epoch(token: str) -> float | None:
    """Extract unverified `exp` claim strictly to cap cache TTL (never trusted for auth)."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")))
        exp = payload.get("exp")
        return float(exp) if isinstance(exp, (int, float)) else None
    except Exception:
        return None


def _get_cached_actor_id(token_digest: str) -> UUID | None:
    now = time.monotonic()
    with _AUTH_CACHE_LOCK:
        entry = _AUTH_CACHE.get(token_digest)
        if entry is None:
            return None
        actor_id, expires_at = entry
        if now >= expires_at:
            _AUTH_CACHE.pop(token_digest, None)
            return None
        return actor_id


def _put_cached_actor_id(token_digest: str, actor_id: UUID, ttl_seconds: float, jwt_exp: float | None) -> None:
    effective_ttl = ttl_seconds
    if jwt_exp is not None:
        remaining = jwt_exp - time.time() - 5.0
        if remaining <= 0:
            return
        effective_ttl = min(effective_ttl, remaining)
    if effective_ttl <= 0:
        return
    now = time.monotonic()
    expires_at = now + effective_ttl
    with _AUTH_CACHE_LOCK:
        if len(_AUTH_CACHE) >= _AUTH_CACHE_MAX_ENTRIES:
            expired = [k for k, (_, exp) in _AUTH_CACHE.items() if now >= exp]
            for k in expired:
                _AUTH_CACHE.pop(k, None)
            if len(_AUTH_CACHE) >= _AUTH_CACHE_MAX_ENTRIES:
                oldest_key = next(iter(_AUTH_CACHE))
                _AUTH_CACHE.pop(oldest_key, None)
        _AUTH_CACHE[token_digest] = (actor_id, expires_at)


def _auth_provider_status(error: BaseException) -> int | None:
    value = getattr(error, "status", None)
    if value is None:
        value = getattr(error, "status_code", None)
    try:
        status_code = int(value)
    except (TypeError, ValueError):
        return None
    return status_code if 100 <= status_code <= 599 else None


def _is_transient_network_error(error: BaseException) -> bool:
    """Kiểm tra xem lỗi có phải do đứt kết nối mạng hoặc socket keep-alive bị đóng hay không."""
    error_name = type(error).__name__
    if error_name in (
        "RemoteProtocolError",
        "ConnectError",
        "ReadError",
        "WriteError",
        "ConnectTimeout",
        "ReadTimeout",
        "PoolTimeout",
        "BrokenPipeError",
        "ConnectionResetError",
    ):
        return True
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "server disconnected",
            "remoteprotocolerror",
            "connection reset",
            "broken pipe",
            "connection closed",
        )
    )


async def _verify_token_via_supabase_client(token: str) -> UUID:
    response = None
    last_error: Exception | None = None

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            supabase = get_supabase_client()
            raw_response = supabase.auth.get_user(token)
            response = (
                await raw_response
                if inspect.isawaitable(raw_response)
                else raw_response
            )
            last_error = None
            break
        except Exception as error:
            provider_status = _auth_provider_status(error)
            if provider_status in (400, 401):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid authentication credentials",
                ) from None

            last_error = error
            # Nếu gặp lỗi ngắt kết nối giao thức mạng do socket cũ, reset pool và thử lại
            if _is_transient_network_error(error) and attempt < max_attempts:
                reset_supabase_client()
                await asyncio.sleep(0.04 * attempt)
                continue
            break

    if last_error is not None:
        provider_status = _auth_provider_status(last_error)
        log_diagnostic(
            logger,
            logging.WARNING,
            event="supabase_auth_verification_unavailable",
            stage="supabase_auth_provider",
            exception=last_error,
            provider_status=provider_status,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service temporarily unavailable",
        ) from None

    if not response or not getattr(response, "user", None):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )

    try:
        return UUID(str(response.user.id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authenticated user ID",
        ) from None


async def _verify_token_via_http(token: str) -> UUID:
    supabase_url = (SUPABASE_URL or "").rstrip("/")
    supabase_key = SUPABASE_KEY or ""
    auth_url = f"{supabase_url}/auth/v1/user"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {token}",
    }

    last_error: Exception | None = None
    resp: httpx.Response | None = None
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        pooled_client: httpx.AsyncClient | None = None
        try:
            pooled_client = _get_auth_http_client()
            if pooled_client is not None:
                resp = await pooled_client.get(auth_url, headers=headers)
            else:
                async with httpx.AsyncClient(
                    trust_env=False,
                    timeout=_AUTH_HTTP_TIMEOUT,
                ) as ephemeral_client:
                    resp = await ephemeral_client.get(auth_url, headers=headers)

            if resp.status_code == 200:
                last_error = None
                break
            if resp.status_code in (400, 401):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid authentication credentials",
                ) from None

            last_error = _AuthProviderStatusError(resp.status_code)
            if _is_retryable_auth_http_status(resp.status_code) and attempt < max_attempts:
                await asyncio.sleep(0.04 * attempt)
                continue
            break
        except HTTPException:
            raise
        except Exception as error:
            provider_status = _auth_provider_status(error)
            if provider_status in (400, 401):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid authentication credentials",
                ) from None

            last_error = error
            if (
                isinstance(error, httpx.TransportError)
                or _is_transient_network_error(error)
            ) and attempt < max_attempts:
                if pooled_client is not None:
                    await _evict_auth_http_client(pooled_client)
                await asyncio.sleep(0.04 * attempt)
                continue
            break

    if last_error is not None:
        provider_status = _auth_provider_status(last_error)
        log_diagnostic(
            logger,
            logging.WARNING,
            event="supabase_auth_verification_unavailable",
            stage="supabase_auth_provider",
            exception=last_error,
            provider_status=provider_status,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service temporarily unavailable",
        ) from None

    try:
        payload = resp.json() if resp is not None else None
    except ValueError:
        payload = None

    raw_user_id = None
    if isinstance(payload, dict):
        raw_user_id = payload.get("id")
        if raw_user_id is None and isinstance(payload.get("user"), dict):
            raw_user_id = payload["user"].get("id")

    if not raw_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )

    try:
        return UUID(str(raw_user_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authenticated user ID",
        ) from None


async def get_current_parent_id(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> UUID:
    """
    Xác thực Supabase access token và lấy ID của authenticated user.

    profiles.id trong project hiện tại liên kết với auth.users.id,
    nên user.id là parent/profile ID hiện tại.
    """

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    token = credentials.credentials
    cache_ttl = _auth_token_cache_ttl_seconds()
    token_digest = (
        hashlib.sha256(token.encode("utf-8")).hexdigest() if cache_ttl > 0 else ""
    )
    if cache_ttl > 0:
        cached = _get_cached_actor_id(token_digest)
        if cached is not None:
            return cached

    if get_supabase_client is not _ORIG_GET_SUPABASE_CLIENT:
        actor_id = await _verify_token_via_supabase_client(token)
    else:
        actor_id = await _verify_token_via_http(token)

    if cache_ttl > 0:
        _put_cached_actor_id(token_digest, actor_id, cache_ttl, _jwt_exp_epoch(token))
    return actor_id

async def _require_database_role(actor_id: UUID, db: AsyncSession, expected_role: str) -> UUID:
    """Authorize against the active database profile, never untrusted JWT role claims."""
    from app.database.role_cache import get_cached_profile_role

    role = await get_cached_profile_role(db, actor_id)
    if role != expected_role:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )
    return actor_id


async def require_parent_id(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> UUID:
    """Require a verified Supabase user with an active parent profile."""
    return await _require_database_role(actor_id, db, "parent")


async def require_admin_id(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> UUID:
    """Require a verified Supabase user with an active admin profile."""
    return await _require_database_role(actor_id, db, "admin")


async def require_active_profile_id(
    request: Request,
    actor_id: UUID = Depends(get_current_parent_id),
) -> UUID:
    """Verify the authenticated profile has Active == 1 using the cached role lookup.

    Checks `request.app.dependency_overrides[get_db]` when overridden (such as test fakes)
    and otherwise resolves via the 60s TTL cache + lazy `AsyncSessionLocal()` on miss.
    """
    try:
        actor_uuid = actor_id if isinstance(actor_id, UUID) else UUID(str(actor_id))
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authenticated user ID",
        )

    overrides = getattr(getattr(request, "app", None), "dependency_overrides", None) or {}
    db_override = overrides.get(get_db)
    role: str | None
    if db_override is not None:
        produced = db_override()
        if inspect.isasyncgen(produced):
            try:
                db_session = await produced.__anext__()
                role = await get_cached_profile_role(db_session, actor_uuid)
            finally:
                await produced.aclose()
        elif inspect.isgenerator(produced):
            try:
                db_session = next(produced)
                role = await get_cached_profile_role(db_session, actor_uuid)
            finally:
                produced.close()
        elif inspect.isawaitable(produced):
            db_session = await produced
            role = await get_cached_profile_role(db_session, actor_uuid)
        else:
            role = await get_cached_profile_role(produced, actor_uuid)
    elif (
        APP_ENVIRONMENT == "test"
        and sqlalchemy_database_url.port == 1
        and sqlalchemy_database_url.host in ("127.0.0.1", "localhost")
    ):
        cached = peek_cached_profile_role(actor_uuid)
        if cached is _ROLE_CACHE_MISSING:
            return actor_uuid
        role = cached  # type: ignore[assignment]
    else:
        role = await get_cached_profile_active_role(actor_uuid)

    if role not in ("parent", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is inactive or unavailable",
        )
    return actor_uuid
