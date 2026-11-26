"""Prepare disposable GitHub Actions PostgreSQL for OCR and Admin AI schema tests."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase" / "migrations" / "20261112110945_viread_vietocr_v2.sql"
DUAL_FLOW_MIGRATION = ROOT / "supabase" / "migrations" / "20261112123000_viread_dual_training_profiles.sql"
TRAINING_JOB_QUEUE_MIGRATION = ROOT / "supabase" / "migrations" / "20261113023322_viread_training_job_queue.sql"
COLAB_DISPATCH_MIGRATION = ROOT / "supabase" / "migrations" / "20261113051337_viread_colab_enterprise_dispatch.sql"
AUTO_LOCK_HOLDOUT_MIGRATION = ROOT / "supabase" / "migrations" / "20261114093543_auto_lock_verified_holdout_and_job_lineage.sql"
PROGRESSIVE_EVAL_MIGRATION = ROOT / "supabase" / "migrations" / "20261115151028_viread_progressive_evaluation.sql"
ADMIN_AI_WORKFLOW_MIGRATION = ROOT / "supabase" / "migrations" / "20261116110000_admin_ai_workflows.sql"
ADMIN_AI_SAFETY_HISTORY_MIGRATION = ROOT / "supabase" / "migrations" / "20261116120000_admin_ai_workflow_safety_history.sql"
FLOW2_DRIVE_MIGRATION = ROOT / "supabase" / "migrations" / "20261121210000_flow2_google_drive_storage.sql"
FLOW2_QUARANTINE_MIGRATION = ROOT / "supabase" / "migrations" / "20261122100000_flow2_sample_quarantine_and_archive.sql"
SOFT_DELETE_BOOKS_MIGRATION = (
    ROOT / "supabase" / "migrations"
    / "20261124120000_soft_delete_catalog_books.sql"
)
MIGRATIONS = (
    MIGRATION,
    DUAL_FLOW_MIGRATION,
    TRAINING_JOB_QUEUE_MIGRATION,
    COLAB_DISPATCH_MIGRATION,
    AUTO_LOCK_HOLDOUT_MIGRATION,
    PROGRESSIVE_EVAL_MIGRATION,
    ADMIN_AI_WORKFLOW_MIGRATION,
    ADMIN_AI_SAFETY_HISTORY_MIGRATION,
    FLOW2_DRIVE_MIGRATION,
    FLOW2_QUARANTINE_MIGRATION,
    SOFT_DELETE_BOOKS_MIGRATION,
)
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

    for migration in MIGRATIONS:
        if not migration.is_file():
            raise FileNotFoundError(f"VietOCR V2 migration is missing: {migration}")

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
            CREATE TABLE IF NOT EXISTS public.books (
                id UUID PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS public.bookpages (
                id UUID PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS public.pagerevisions (
                id UUID PRIMARY KEY,
                pageid UUID NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
                drafttext TEXT,
                verifiedtext TEXT
            );
            """
        )
        for migration in MIGRATIONS:
            await connection.execute(migration.read_text(encoding="utf-8"))
                    # Verify that the book soft-delete migration was applied successfully.
        for column in ("is_deleted", "deleted_at", "deleted_by"):
            exists = await connection.fetchval(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'books'
                      AND column_name = $1
                )
                """,
                column,
            )
            if not exists:
                raise RuntimeError(
                    f"Soft-delete migration did not create public.books.{column}"
                )
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(prepare())
    print(
    "Applied the VietOCR V2, dual-flow, Admin AI workflow, "
    "and soft-delete catalog books migrations to the disposable "
    "loopback PostgreSQL test database."
    )
