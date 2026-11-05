from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values
from sqlalchemy.engine import make_url

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = BACKEND_ROOT.parent
WORKSPACE_ROOT = REPOSITORY_ROOT.parent


def _load_missing_dotenv_values() -> None:
    """Load known dotenv paths without replacing non-empty process settings."""
    for dotenv_path in (
        BACKEND_ROOT / ".env",
        REPOSITORY_ROOT / ".env",
        WORKSPACE_ROOT / ".env",
    ):
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
SUPABASE_AVATAR_BUCKET = (
    (os.getenv("SUPABASE_AVATAR_BUCKET") or "viread-avatars").strip()
    or "viread-avatars"
)

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


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean value")


SMTP_HOST = (os.getenv("SMTP_HOST") or "smtp.gmail.com").strip()
SMTP_PORT = _int_env("SMTP_PORT", 587, minimum=1, maximum=65535)
SMTP_USERNAME = (os.getenv("SMTP_USERNAME") or "").strip() or None
SMTP_APP_PASSWORD = (os.getenv("SMTP_APP_PASSWORD") or "").strip().replace(" ", "") or None
SMTP_FROM_EMAIL = (os.getenv("SMTP_FROM_EMAIL") or "vireadforyou@gmail.com").strip() or None
SMTP_SEND_TIMEOUT_SECONDS = _float_env("SMTP_SEND_TIMEOUT_SECONDS", 15.0, minimum=1.0, maximum=120.0)
READING_REMINDER_POLL_SECONDS = _int_env("READING_REMINDER_POLL_SECONDS", 30, minimum=5, maximum=300)
READING_REMINDER_MAX_ATTEMPTS = _int_env("READING_REMINDER_MAX_ATTEMPTS", 5, minimum=1, maximum=10)
READING_REMINDER_APP_URL = (
    os.getenv("READING_REMINDER_APP_URL") or "http://localhost:3000/reading-management"
).strip()


APP_ENVIRONMENT = (
    os.getenv("APP_ENVIRONMENT") or "development"
).strip().lower()
if APP_ENVIRONMENT not in {"development", "test", "production"}:
    raise ValueError("APP_ENVIRONMENT must be development, test or production")

DATABASE_POOLER_MODE = (
    os.getenv("DATABASE_POOLER_MODE") or "local"
).strip().lower()
if DATABASE_POOLER_MODE not in {"local", "transaction"}:
    raise ValueError("DATABASE_POOLER_MODE must be 'local' or 'transaction'")

DATABASE_SSL_REQUIRED = _bool_env(
    "DATABASE_SSL_REQUIRED",
    default=DATABASE_POOLER_MODE == "transaction",
)
DATABASE_SSL_ROOT_CERT = (
    os.getenv("DATABASE_SSL_ROOT_CERT") or ""
).strip() or None

DATABASE_CONCURRENCY_LIMIT = _int_env(
    "DATABASE_CONCURRENCY_LIMIT", 8, minimum=1, maximum=256
)
DATABASE_CONCURRENCY_WAIT_TIMEOUT = _float_env(
    "DATABASE_CONCURRENCY_WAIT_TIMEOUT", 5.0, minimum=0.1, maximum=120.0
)
DATABASE_CONNECT_TIMEOUT = _float_env(
    "DATABASE_CONNECT_TIMEOUT", 10.0, minimum=1.0, maximum=120.0
)
DATABASE_COMMAND_TIMEOUT = _float_env(
    "DATABASE_COMMAND_TIMEOUT", 30.0, minimum=1.0, maximum=600.0
)

if not DATABASE_URL or not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError(
        "Missing required backend environment variables: "
        "DATABASE_URL, SUPABASE_URL, SUPABASE_KEY"
    )

try:
    _database_url = make_url(DATABASE_URL)
except Exception as error:
    raise ValueError("DATABASE_URL is not a valid SQLAlchemy URL") from error

if _database_url.drivername != "postgresql+asyncpg":
    raise ValueError("DATABASE_URL must use the postgresql+asyncpg driver")

if APP_ENVIRONMENT == "production" and DATABASE_POOLER_MODE != "transaction":
    raise ValueError(
        "Production deployments must explicitly use DATABASE_POOLER_MODE=transaction"
    )

if DATABASE_POOLER_MODE == "transaction":
    if _database_url.port != 6543:
        raise ValueError(
            "DATABASE_POOLER_MODE=transaction requires the Supabase Transaction "
            "Pooler port 6543"
        )
    if not DATABASE_SSL_REQUIRED:
        raise ValueError(
            "DATABASE_SSL_REQUIRED must be true for the production transaction pooler"
        )
    if not DATABASE_SSL_ROOT_CERT:
        raise ValueError(
            "DATABASE_SSL_ROOT_CERT is required for production transaction-pooler connections"
        )
    if not Path(DATABASE_SSL_ROOT_CERT).is_file():
        raise ValueError(
            "DATABASE_SSL_ROOT_CERT must point to an available CA certificate file"
        )
