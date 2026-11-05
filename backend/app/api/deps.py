import logging
import time
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.database.session import get_db
from app.database.supabase_client import get_supabase_client, reset_supabase_client
from app.diagnostic_logging import log_diagnostic


logger = logging.getLogger(__name__)
security = HTTPBearer(auto_error=False)


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


def get_current_parent_id(
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
    response = None
    last_error: Exception | None = None

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            supabase = get_supabase_client()
            response = supabase.auth.get_user(token)
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
                time.sleep(0.04 * attempt)
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
        )