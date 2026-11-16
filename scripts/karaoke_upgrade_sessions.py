"""Opt-in, approved temporary live sessions; never imported by the application.

No account creation, role/password update or email sending. Read-only DB lookup
first; generate_link is only used for the exact existing confirmed identities.
Tokens stay in an ignored cache file and logout uses scope=local, never global.
"""
import argparse
import asyncio
import json
import os
import ssl
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import asyncpg
from dotenv import dotenv_values
from sqlalchemy.engine import make_url

from check_karaoke_upgrade_readiness import APPROVED_REF, ROOT, check

SESSION_FILE = ROOT / ".cache/karaoke-upgrade-sessions.json"


def auth_request(base, key, route, payload=None, token=None):
    request = Request(base + "/auth/v1/" + route,
        data=json.dumps(payload).encode() if payload is not None else b"",
        headers={"apikey": key, "Authorization": "Bearer " + (token or key),
                 "Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=35) as response:
        content = response.read()
        return json.loads(content) if content else {}


def cleanup(data, key):
    for role in ("admin", "parent"):
        if role not in data:
            continue
        try:
            auth_request(data["supabase_url"], key, "logout?scope=local",
                         token=data[role]["access_token"])
        except HTTPError as error:
            if error.code not in (401, 403, 404):
                raise


async def identities(project, admin_email):
    readiness = await check(project, admin_email)
    if not readiness["admin_ready"] or not readiness["parent_ready"]:
        raise ValueError("Existing approved identities are not ready")
    env = dotenv_values(ROOT / "backend/.env")
    url = make_url(env["DATABASE_URL"])
    context = ssl.create_default_context(cafile=str(ROOT / ".cache/karaoke-prod-ca-2021.crt"))
    connection = await asyncpg.connect(host=url.host, port=url.port or 5432,
        user=url.username, password=url.password, database=url.database, ssl=context,
        timeout=15, statement_cache_size=0,
        server_settings={"default_transaction_read_only": "on", "statement_timeout": "15000"})
    try:
        async with connection.transaction(readonly=True):
            rows = await connection.fetch("""
                SELECT p.id,p.role,u.email FROM public.profiles p
                JOIN auth.users u ON u.id=p.id
                WHERE p.active=1 AND u.email_confirmed_at IS NOT NULL
                AND ((p.role='admin' AND lower(u.email)=lower($2))
                     OR (p.role='parent' AND p.id=$1::uuid))
            """, readiness["parent_id"], admin_email)
            child = await connection.fetchrow("""
                SELECT id,alias,grade FROM public.childprofiles
                WHERE parentid=$1::uuid ORDER BY id LIMIT 1
            """, readiness["parent_id"])
            if len(rows) != 2 or not child:
                raise ValueError("Approved account lookup is not exact")
            return {row["role"]: dict(row) for row in rows}, dict(child)
    finally:
        await connection.close()


def main(args):
    if args.project_ref != APPROVED_REF:
        raise ValueError("Unapproved project")
    front = dotenv_values(ROOT / "frontend/.env.local")
    base = "https://" + APPROVED_REF + ".supabase.co"
    if front.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/") != base:
        raise ValueError("Frontend project mismatch")
    public_key = front.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") or front.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    if not public_key:
        raise ValueError("Public key unavailable")
    if args.cleanup:
        data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
        if data.get("supabase_url") != base or data.get("project") != args.project_ref:
            raise ValueError("Session project mismatch")
        cleanup(data, public_key)
        SESSION_FILE.unlink()
        print(json.dumps({"temporary_sessions_signed_out": True, "credential_file_removed": True}))
        return
    if SESSION_FILE.exists():
        raise ValueError("Clean up previous temporary sessions first")
    if not args.admin_email:
        raise ValueError("Explicit approved admin email is required")
    people, child = asyncio.run(identities(args.project_ref, args.admin_email))
    env = dotenv_values(ROOT / "backend/.env")
    admin_key = env.get("SUPABASE_SECRET_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not admin_key:
        raise ValueError("Admin credential unavailable")
    data = {"project": args.project_ref, "supabase_url": base,
            "child_id": str(child["id"]), "child_alias": child["alias"], "child_grade": child["grade"]}
    SESSION_FILE.parent.mkdir(exist_ok=True)
    descriptor = os.open(SESSION_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(data, stream)
    try:
        for role in ("admin", "parent"):
            linked = auth_request(base, admin_key, "admin/generate_link",
                {"type": "magiclink", "email": people[role]["email"]})
            if linked.get("id") != str(people[role]["id"]):
                raise ValueError("Auth identity mismatch")
            session = auth_request(base, public_key, "verify",
                {"type": "magiclink", "token_hash": linked["hashed_token"]})
            data[role] = {field: session[field] for field in ("access_token", "refresh_token")}
            SESSION_FILE.write_text(json.dumps(data), encoding="utf-8")
            if session.get("user", {}).get("id") != str(people[role]["id"]):
                raise ValueError("Session identity mismatch")
    except Exception:
        cleanup(data, public_key)
        SESSION_FILE.unlink()
        raise
    print(json.dumps({"project": args.project_ref, "temporary_sessions_created": 2,
                      "account_role_password_changes": False, "emails_sent": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--admin-email")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--create-approved-sessions", action="store_true")
    action.add_argument("--cleanup", action="store_true")
    try:
        main(parser.parse_args())
    except Exception as error:
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        raise SystemExit(1)
