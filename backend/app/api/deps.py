import logging
from collections.abc import AsyncGenerator
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.session import AsyncSessionLocal
from app.database.supabase_client import get_supabase_client
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


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Dependency Injection để lấy Database Session.
    Mỗi request dùng một session và tự động đóng khi xử lý xong.
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


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

    try:
        supabase = get_supabase_client()
        response = supabase.auth.get_user(token)
    except Exception as error:
        provider_status = _auth_provider_status(error)
        if provider_status in (400, 401):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
            ) from None

        # A timeout, provider outage, rate limit, or server configuration error
        # is not proof that the user's JWT is invalid. Preserve that distinction
        # so clients do not discard a valid Supabase session on transient failures.
        log_diagnostic(
            logger,
            logging.WARNING,
            event="supabase_auth_verification_unavailable",
            stage="supabase_auth_provider",
            exception=error,
            provider_status=provider_status,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service temporarily unavailable",
        ) from None

    if not response.user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )

    try:
        return UUID(str(response.user.id))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authenticated user ID",
        )