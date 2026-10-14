from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = BACKEND_ROOT.parent
WORKSPACE_ROOT = REPOSITORY_ROOT.parent


def _load_missing_dotenv_values() -> None:
    """Load known dotenv paths without replacing non-empty process settings."""
    for dotenv_path in (BACKEND_ROOT / ".env", REPOSITORY_ROOT / ".env", WORKSPACE_ROOT / ".env"):
        if not dotenv_path.is_file():
            continue
        for key, value in dotenv_values(dotenv_path).items():
            if value is None:
                continue
            current = os.getenv(key)
            if current is None or not current.strip():
                os.environ[key] = value


_load_missing_dotenv_values()

DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip() or None
SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip() or None
SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip() or None
SUPABASE_STORAGE_BUCKET = (os.getenv("SUPABASE_STORAGE_BUCKET") or "").strip() or None

# Server-only credentials for Supabase Storage/Auth Admin. Prefer the current
# secret API key and retain the legacy service-role key for existing deployments.
SUPABASE_SECRET_KEY = (os.getenv("SUPABASE_SECRET_KEY") or "").strip() or None
SUPABASE_SERVICE_ROLE_KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or None
SUPABASE_ADMIN_KEY = SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY

if not DATABASE_URL or not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError(
        "Missing required backend environment variables: DATABASE_URL, SUPABASE_URL, SUPABASE_KEY"
    )
