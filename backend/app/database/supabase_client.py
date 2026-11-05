import logging
import threading
from functools import lru_cache

from supabase import Client, ClientOptions, create_client

# supabase-py 2.x moved `storage` off the base ClientOptions onto the sync/async
# subclasses. `create_client` is the sync entrypoint, so it needs SyncClientOptions.
# Older installs only expose ClientOptions, which still works as a fallback.
try:  # pragma: no cover - depends on the installed supabase-py version
    from supabase.lib.client_options import SyncClientOptions as _AdminClientOptions
except ImportError:  # pragma: no cover - older supabase-py without the subclass
    _AdminClientOptions = ClientOptions

from .config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_KEY,
    SUPABASE_URL,
)

logger = logging.getLogger(__name__)

_client_lock = threading.Lock()


def _init_supabase_client() -> Client:
    """Tạo client với cấu hình server-side không lưu session cục bộ, tránh xung đột connection."""
    return create_client(
        SUPABASE_URL,
        SUPABASE_KEY,
        options=_AdminClientOptions(
            auto_refresh_token=False,
            persist_session=False,
        ),
    )


supabase: Client = _init_supabase_client()


def get_supabase_client() -> Client:
    """Return the existing Supabase client used for token verification."""
    global supabase
    return supabase


def reset_supabase_client() -> Client:
    """Khởi tạo lại client và connection pool mới khi phát hiện socket bị máy chủ ngắt kết nối."""
    global supabase
    with _client_lock:
        try:
            supabase = _init_supabase_client()
        except Exception as exc:
            logger.warning("Không thể reset Supabase client: %s", exc)
        return supabase


@lru_cache(maxsize=1)
def get_supabase_admin_client() -> Client | None:
    """Return a server-only Auth Admin client when a secret/service-role key is configured."""
    if not SUPABASE_ADMIN_KEY:
        logger.warning(
            "Supabase Auth Admin is not configured; set SUPABASE_SECRET_KEY "
            "or SUPABASE_SERVICE_ROLE_KEY in the Backend environment."
        )
        return None
    return create_client(
        SUPABASE_URL,
        SUPABASE_ADMIN_KEY,
        options=_AdminClientOptions(
            auto_refresh_token=False,
            persist_session=False,
        ),
    )