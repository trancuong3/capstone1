from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = BACKEND_ROOT.parent

# Prefer backend/.env for server-only settings, then use the repository-root
# .env to fill any missing values. Existing process environment always wins.
for _dotenv_path in (BACKEND_ROOT / ".env", REPOSITORY_ROOT / ".env"):
    if _dotenv_path.is_file():
        load_dotenv(dotenv_path=_dotenv_path, override=False)

DATABASE_URL = os.getenv("DATABASE_URL")
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
