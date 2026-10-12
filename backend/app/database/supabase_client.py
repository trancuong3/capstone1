from functools import lru_cache

from supabase import Client, create_client

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
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
