import logging
from functools import lru_cache

from supabase import Client, create_client
from supabase.lib.client_options import ClientOptions

from .config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_KEY,
    SUPABASE_URL,
)

logger = logging.getLogger(__name__)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def get_supabase_client() -> Client:
    """Return the existing Supabase client used for token verification."""
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
        options=ClientOptions(auto_refresh_token=False, persist_session=False),
    )
