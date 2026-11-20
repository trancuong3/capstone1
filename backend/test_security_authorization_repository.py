"""SQL ownership regressions for security-sensitive persistence methods.

Compile real SQLAlchemy queries with PostgreSQL dialect. No live database,
private Supabase credentials, or production records are used.
"""

import os
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy.dialects import postgresql

from app.api.routes.reading import HistoryRepository
from app.database.role_cache import get_cached_profile_role
from app.repositories.admin_parent_repository import AdminParentRepository
from app.api.routes.system import AdminSystemRepository, LegacyReportRepository, ProgressRepository
from app.repositories.tutor_question_repository import TutorQuestionRepository
from app.services.tutor_question_service import TutorQuestionService
from fastapi import HTTPException

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
CHILD = UUID("22222222-2222-4222-8222-222222222222")
SESSION = UUID("33333333-3333-4333-8333-333333333333")
START = date(2026, 1, 1)
END = date(2026, 1, 7)
BEGIN_DT = datetime(2026, 1, 1, tzinfo=timezone.utc)
END_DT = datetime(2026, 1, 8, tzinfo=timezone.utc)


def compiled(statement):
    prepared = statement.compile(dialect=postgresql.dialect())
    return str(prepared).lower(), list(prepared.params.values())


class OwnershipRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_tutor_owned_session_reads_restrict_active_parent_and_child(self):
        for method_name in ("owned_session", "owned_session_for_update"):
            with self.subTest(method=method_name):
                db = MagicMock()
                db.scalar = AsyncMock(return_value=None)
                await getattr(TutorQuestionRepository(db), method_name)(SESSION, ACTOR)
                sql, params = compiled(db.scalar.await_args.args[0])
                self.assertIn("childprofiles.parentid", sql)
                self.assertIn("profiles.role", sql)
                self.assertIn("profiles.active", sql)
                self.assertIn(ACTOR, params)
                self.assertIn(SESSION, params)
                self.assertIn("parent", params)
                self.assertIn(1, params)
                if method_name.endswith("_for_update"):
                    self.assertIn("for update", sql)

    async def test_legacy_snapshot_owner_lock_is_for_update(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        self.assertFalse(await LegacyReportRepository(db).lock_owned_child(ACTOR, CHILD))
        sql, params = compiled(db.scalar.await_args.args[0])
        self.assertIn("childprofiles.parentid", sql)
        self.assertIn("for update", sql)
        self.assertIn(ACTOR, params)
        self.assertIn(CHILD, params)

    async def test_legacy_snapshot_cache_scoped_to_child_and_parent(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        await LegacyReportRepository(db).trusted_snapshot(ACTOR, CHILD, START, END)
        sql, params = compiled(db.scalar.await_args.args[0])
        for column in ("progressreports.childid", "childprofiles.parentid",
                       "progressreports.periodstart", "progressreports.periodend",
                       "progressreports.summary"):
            self.assertIn(column, sql)
        self.assertIn(ACTOR, params)
        self.assertIn(CHILD, params)
        self.assertIn(START, params)
        self.assertIn(END, params)
        self.assertIn("server_completed_sessions_v1", params)

    async def test_legacy_snapshot_evidence_is_completed_owned_sessions_only(self):
        db = MagicMock()
        result = MagicMock()
        result.all.return_value = []
        db.execute = AsyncMock(return_value=result)
        await LegacyReportRepository(db).completed_sessions(
            ACTOR, CHILD, BEGIN_DT, END_DT, END_DT
        )
        sql, params = compiled(db.execute.await_args.args[0])
        for column in (
            "childprofiles.parentid", "readingsessions.childid",
            "readingsessions.state", "readingsessions.startedat",
            "readingsessions.endedat",
        ):
            self.assertIn(column, sql)
        self.assertIn(ACTOR, params)
        self.assertIn(CHILD, params)
        self.assertIn("COMPLETED", params)

    async def test_current_and_historical_report_queries_scope_parent_and_child(self):
        for method_name, args in (
            ("latest", (CHILD, ACTOR)),
            ("report", (CHILD, START, END, ACTOR)),
            ("periods", (CHILD, ACTOR, 0, 10)),
        ):
            with self.subTest(method=method_name):
                db = MagicMock()
                db.scalar = AsyncMock(return_value=None)
                mapping = MagicMock()
                mapping.mappings.return_value.all.return_value = []
                db.execute = AsyncMock(return_value=mapping)
                await getattr(ProgressRepository(db), method_name)(*args)
                query = (db.execute if method_name == "periods" else db.scalar).await_args.args[0]
                sql, params = compiled(query)
                self.assertIn("childprofiles.parentid", sql)
                self.assertIn("progressreports.childid", sql)
                self.assertIn(ACTOR, params)
                self.assertIn(CHILD, params)

    async def test_history_session_query_never_reads_another_parent(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        await HistoryRepository(db).session(SESSION, ACTOR)
        sql, params = compiled(db.scalar.await_args.args[0])
        self.assertIn("childprofiles.parentid", sql)
        self.assertIn("readingsessions.id", sql)
        self.assertIn(ACTOR, params)
        self.assertIn(SESSION, params)


    async def test_history_and_admin_roles_exclude_inactive_profiles(self):
        for repo_type in (HistoryRepository, AdminSystemRepository):
            with self.subTest(repository=repo_type.__name__):
                db = MagicMock()
                db.scalar = AsyncMock(return_value=None)
                await repo_type(db).role(ACTOR)
                sql, params = compiled(db.scalar.await_args.args[0])
                self.assertIn("profiles.active", sql)
                self.assertIn(ACTOR, params)
                self.assertIn(1, params)

    async def test_tutor_refuses_to_insert_when_session_reopens_during_generation(self):
        repository = MagicMock()
        repository.owned_session = AsyncMock(return_value=SimpleNamespace(
            Id=SESSION, State="COMPLETED"
        ))
        repository.owned_session_for_update = AsyncMock(return_value=SimpleNamespace(
            Id=SESSION, State="ACTIVE"
        ))
        repository.questions = AsyncMock(return_value=[])
        repository.release = AsyncMock()
        repository.add_questions = Mock()
        repository.commit = AsyncMock()

        service = TutorQuestionService(repository)
        service.config = SimpleNamespace(enabled=True)
        service._source_pages = AsyncMock(return_value=[object()])
        service.generator = SimpleNamespace(
            generate=AsyncMock(return_value=SimpleNamespace(questions=[object()])),
        )
        with self.assertRaises(HTTPException) as caught:
            await service.generate_for_session(SESSION, ACTOR)
        self.assertEqual(caught.exception.status_code, 409)
        repository.owned_session_for_update.assert_awaited_once_with(SESSION, ACTOR)
        repository.add_questions.assert_not_called()
        repository.commit.assert_not_awaited()
        self.assertEqual(repository.release.await_count, 2)


    async def test_role_cache_queries_require_active_profile(self):
        # A mock DB intentionally bypasses caching and captures the actual
        # authorization SQL without touching a production profile.
        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)
        await get_cached_profile_role(db, ACTOR)
        sql, params = compiled(db.scalar.await_args.args[0])
        self.assertIn("profiles.active", sql)
        self.assertIn(ACTOR, params)
        self.assertIn(1, params)

    async def test_admin_deactivation_invalidates_cached_parent_role(self):
        db = MagicMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = ACTOR
        db.execute = AsyncMock(return_value=result)
        db.commit = AsyncMock()
        with patch("app.repositories.admin_parent_repository.invalidate_cached_role") as invalidate:
            changed = await AdminParentRepository(db).soft_delete_parent(ACTOR)
        self.assertTrue(changed)
        db.commit.assert_awaited_once()
        invalidate.assert_called_once_with(ACTOR)
        sql, params = compiled(db.execute.await_args.args[0])
        self.assertIn("profiles.active", sql)
        self.assertIn("profiles.role", sql)
        self.assertIn(ACTOR, params)
        self.assertIn("parent", params)

    async def test_deactivation_does_not_invalidate_on_missing_profile(self):
        db = MagicMock()
        result = MagicMock()
        result.scalar_one_or_none.return_value = None
        db.execute = AsyncMock(return_value=result)
        db.rollback = AsyncMock()
        db.commit = AsyncMock()
        with patch("app.repositories.admin_parent_repository.invalidate_cached_role") as invalidate:
            changed = await AdminParentRepository(db).soft_delete_parent(ACTOR)
        self.assertFalse(changed)
        db.rollback.assert_awaited_once()
        db.commit.assert_not_awaited()
        invalidate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
