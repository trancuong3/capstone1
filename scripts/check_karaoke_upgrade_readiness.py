"""Explicit read-only readiness check for the approved Supabase karaoke project.

Run with backend/.venv Python. Never prints URLs with credentials, keys, emails,
tokens or raw provider/database exceptions; never updates DB/Auth/Storage.
"""
import argparse
import asyncio
import json
from pathlib import Path
import ssl
from uuid import UUID

import asyncpg
from dotenv import dotenv_values
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
APPROVED_REF = "hgkklatgepyzbkkmwfvp"
SONG_ID = UUID("0374bb5e-426e-4375-8c1f-2f11c529e786")


async def check(project, admin_email):
    if project != APPROVED_REF:
        raise ValueError("Unapproved project")
    env = dotenv_values(ROOT / "backend/.env")
    front = dotenv_values(ROOT / "frontend/.env.local")
    from urllib.parse import urlparse
    for value in (env.get("SUPABASE_URL"), front.get("NEXT_PUBLIC_SUPABASE_URL")):
        if urlparse(value or "").hostname != project + ".supabase.co":
            raise ValueError("Frontend/backend project mismatch")
    url = make_url(env["DATABASE_URL"])
    if project not in (url.username or "") and project not in (url.host or ""):
        raise ValueError("Database project mismatch")
    ca = ROOT / ".cache/karaoke-prod-ca-2021.crt"
    context = ssl.create_default_context(cafile=str(ca))
    connection = await asyncpg.connect(host=url.host, port=url.port or 5432,
        user=url.username, password=url.password, database=url.database,
        ssl=context, timeout=15, statement_cache_size=0,
        server_settings={"default_transaction_read_only": "on", "statement_timeout": "15000"})
    try:
        async with connection.transaction(readonly=True):
            admin = await connection.fetchrow("""
                SELECT p.id,p.role,p.active,u.email_confirmed_at IS NOT NULL AS confirmed
                FROM public.profiles p JOIN auth.users u ON u.id=p.id
                WHERE lower(u.email)=lower($1)
            """, admin_email)
            parent = await connection.fetchrow("""
                SELECT p.id,p.role,p.active,count(c.id)::int AS children
                FROM public.profiles p JOIN public.childprofiles c ON c.parentid=p.id
                JOIN auth.users u ON u.id=p.id
                WHERE p.role='parent' AND p.active=1 AND u.email_confirmed_at IS NOT NULL
                GROUP BY p.id,p.role,p.active ORDER BY p.id LIMIT 1
            """)
            song = await connection.fetchrow("""
                SELECT s.id,s.status,s.revision,s.published_version_id,
                    v.lyrics->>'format_version' AS lyrics_format,v.audio_sha256,
                    (SELECT count(*) FROM public.karaoke_song_versions d
                     WHERE d.song_id=s.id AND d.state='DRAFT')::int AS draft_count
                FROM public.karaoke_songs s LEFT JOIN public.karaoke_song_versions v
                ON v.id=s.published_version_id WHERE s.id=$1
            """, SONG_ID)
            return {"project": project, "read_only": True, "tls_verified": context.check_hostname,
                "admin_ready": bool(admin and admin["role"] == "admin" and admin["active"] == 1 and admin["confirmed"]),
                "parent_ready": bool(parent and parent["role"] == "parent" and parent["active"] == 1 and parent["children"]),
                "parent_id": str(parent["id"]) if parent else None,
                "song": dict(song) if song else None}
    finally:
        await connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--admin-email", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(check(args.project_ref, args.admin_email)), default=str))
    except Exception as error:
        print(json.dumps({"read_only": True, "status": "not_ready", "error_type": type(error).__name__}))
        raise SystemExit(1)
