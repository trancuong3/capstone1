from functools import lru_cache

from supabase import Client, create_client
from supabase.lib.client_options import ClientOptions

# supabase-py 2.x moved `storage` off the base ClientOptions onto the sync/async
# subclasses. `create_client` is the sync entrypoint, so it needs SyncClientOptions.
# Older installs only expose ClientOptions, which still works as a fallback.
try:  # pragma: no cover - depends on the installed supabase-py version
    from supabase.lib.client_options import SyncClientOptions as _AdminClientOptions
except ImportError:  # pragma: no cover - older supabase-py without the subclass
    _AdminClientOptions = ClientOptions

from .config import (
    SUPABASE_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def get_supabase_client() -> Client:
    """Return the existing Supabase client used for token verification."""
    return supabase


@lru_cache(maxsize=1)
def get_supabase_admin_client() -> Client | None:
    """Return a server-only Auth Admin client when its secret is configured."""
    if not SUPABASE_SERVICE_ROLE_KEY:
        return None
    return create_client(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        options=_AdminClientOptions(
            auto_refresh_token=False,
            persist_session=False,
        ),
    )
