"""Prepare the disposable GitHub Actions PostgreSQL for the VietOCR migration test."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase" / "migrations" / "20261112110945_viread_vietocr_v2.sql"
ALLOWED_DATABASE = "test"
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _test_database_dsn() -> str:
    configured_url = os.environ.get("ADMIN_OCR_TEST_DATABASE_URL")
    if not configured_url:
        raise RuntimeError(
            "ADMIN_OCR_TEST_DATABASE_URL must point at the disposable CI database"
        )

    parsed = urlsplit(configured_url)
    username = unquote(parsed.username or "")
    database = unquote(parsed.path.lstrip("/"))
    if (
        parsed.scheme not in {"postgresql", "postgresql+asyncpg"}
        or parsed.hostname not in ALLOWED_HOSTS
        or parsed.port not in {None, 5432}
        or username != "test"
        or database != ALLOWED_DATABASE
    ):
        raise RuntimeError(
            "Refusing to prepare anything except the loopback PostgreSQL database named 'test'"
        )

    if parsed.scheme == "postgresql+asyncpg":
        return configured_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    return configured_url


async def prepare() -> None:
    import asyncpg

    if not MIGRATION.is_file():
        raise FileNotFoundError(f"VietOCR V2 migration is missing: {MIGRATION}")

    connection = await asyncpg.connect(_test_database_dsn())
    try:
        for role in ("anon", "authenticated", "service_role"):
            exists = await connection.fetchval(
                "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", role
            )
            if not exists:
                await connection.execute(f'CREATE ROLE "{role}" NOLOGIN')

        # These minimal parent tables exist only in the clean CI service database.
        # The migration itself is then applied verbatim, including its constraints,
        # RLS, grants, indexes, and Original model seed.
        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS public.profiles (
                id UUID PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS public.bookpages (
                id UUID PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS public.pagerevisions (
                id UUID PRIMARY KEY,
                pageid UUID NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE
            );
            """
        )
        await connection.execute(MIGRATION.read_text(encoding="utf-8"))
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(prepare())
    print("Applied the VietOCR V2 migration to the disposable loopback PostgreSQL test database.")
