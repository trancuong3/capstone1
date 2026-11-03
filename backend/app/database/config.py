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


def _int_env(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _float_env(name: str, default: float, *, minimum: float, maximum: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


# Keep each process deliberately below the observed 15-client Supabase
# session-pool limit. Multiply (pool size + overflow) by every app worker and
# instance when setting production values.
DATABASE_POOL_SIZE = _int_env("DATABASE_POOL_SIZE", 3, minimum=1, maximum=15)
DATABASE_MAX_OVERFLOW = _int_env("DATABASE_MAX_OVERFLOW", 0, minimum=0, maximum=14)
DATABASE_POOL_TIMEOUT = _float_env(
    "DATABASE_POOL_TIMEOUT", 10.0, minimum=1.0, maximum=120.0
)
DATABASE_POOL_RECYCLE = _int_env(
    "DATABASE_POOL_RECYCLE", 900, minimum=60, maximum=7200
)

if not DATABASE_URL or not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError(
        "Missing required backend environment variables: DATABASE_URL, SUPABASE_URL, SUPABASE_KEY"
    )
