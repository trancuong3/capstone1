import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
# Server-only credential for Supabase Auth Admin API. Never expose to the browser.
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not DATABASE_URL or not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("⚠️ Thiếu biến môi trường! Hãy kiểm tra lại file .env")