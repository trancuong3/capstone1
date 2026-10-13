import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
# Server-only credentials for Supabase Auth Admin API. Prefer the current secret API key;
# retain the legacy service-role key name for existing deployments. Never expose either to the browser.
SUPABASE_SECRET_KEY = (os.getenv("SUPABASE_SECRET_KEY") or "").strip() or None
SUPABASE_SERVICE_ROLE_KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or None
SUPABASE_ADMIN_KEY = SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY

if not DATABASE_URL or not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("⚠️ Thiếu biến môi trường! Hãy kiểm tra lại file .env")