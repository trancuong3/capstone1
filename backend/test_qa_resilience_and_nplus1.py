"""Regression tests for DEF-003 (SSRF/LFI/DoS), DEF-004 (TOCTOU), DEF-009, and DEF-010 (N+1)."""
from __future__ import annotations

import os
import unittest
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:55450/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-publishable-key")

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from PIL import Image
from starlette.datastructures import Headers

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import admin_ocr as admin_ocr_routes
from app.api.routes import reading as reading_routes
from app.api.routes.system import ProgressRepository
from app.jobs.parent_book_submission_worker import cleanup_expired_temp_submissions
from app.repositories.reading_management_repository import ReadingManagementRepository
from app.schemas.parent_private_book import (
    ParentOcrContributionStateRead,
    ParentPrivateBookUpdate,
)
from app.services.admin_ocr_service import AdminOcrService
from app.services.parent_private_book_service import ParentPrivateBookService
from app.services.reading_management_service import ReadingManagementService

PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
ADMIN_ID = UUID("22222222-2222-4222-8222-222222222222")
CHILD_ID = UUID("33333333-3333-4333-8333-333333333333")
BOOK_ID = UUID("44444444-4444-4444-8444-444444444444")
SESSION_ID = UUID("55555555-5555-4555-8555-555555555555")


def _png_bytes(width: int = 32, height: int = 32) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (width, height), (240, 240, 240)).save(buf, format="PNG")
    return buf.getvalue()


class Def003CameraSafetyAndResilienceTests(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_stored_page_bytes_blocks_ssrf_and_lfi(self):
        unsafe_paths = [
            "",
            "http://169.254.169.254/latest/meta-data/",
            "https://evil.example.com/page.png",
            "file:///etc/passwd",
            "/etc/passwd",
            r"C:\Windows\win.ini",
            "../secrets/key.txt",
            "books/../../etc/passwd",
            "books/b1/page\x00.png",
        ]
        with patch("app.api.routes.reading.download_object") as dl_mock:
            for bad_path in unsafe_paths:
                out = await reading_routes._fetch_stored_page_bytes(bad_path)
                self.assertIsNone(out, bad_path)
            dl_mock.assert_not_called()

            dl_mock.return_value = b"ok-bytes"
            good = await reading_routes._fetch_stored_page_bytes("books/b1/pages/p1.png")
            self.assertEqual(good, b"ok-bytes")
            dl_mock.assert_called_once_with("books/b1/pages/p1.png", bucket_name=None)

    def test_camera_match_enforces_8mb_limit_and_valid_image(self):
        app = FastAPI()
        app.include_router(reading_routes.router, prefix="/reading")
        db = MagicMock()
        db.scalar = AsyncMock(return_value="parent")
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ID
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)

        oversized = b"\x89PNG" + (b"0" * (reading_routes.MAX_CAMERA_FRAME_BYTES + 16))
        resp_413 = client.post(
            f"/reading/books/{BOOK_ID}/match-page",
            files={"file": ("big.png", oversized, "image/png")},
        )
        self.assertEqual(resp_413.status_code, 413)

        resp_413_global = client.post(
            "/reading/match-page",
            files={"file": ("big.png", oversized, "image/png")},
        )
        self.assertEqual(resp_413_global.status_code, 413)

        resp_corrupt = client.post(
            f"/reading/books/{BOOK_ID}/match-page",
            files={"file": ("bad.png", b"not-an-image", "image/png")},
        )
        self.assertEqual(resp_corrupt.status_code, 422)

    async def test_fetch_candidate_pages_caps_at_max_candidates(self):
        rows = [
            (
                SimpleNamespace(Id=uuid4(), ImagePath=f"books/{BOOK_ID}/pages/{i}.png"),
                SimpleNamespace(VisibilityScope="CATALOG"),
            )
            for i in range(130)
        ]
        with patch("app.api.routes.reading.download_object", return_value=b"img"):
            candidates = await reading_routes._fetch_candidate_pages(rows)
        self.assertEqual(len(candidates), reading_routes.MAX_CAMERA_CANDIDATE_PAGES)


class Def004CleanupToctouTests(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_commits_db_transition_before_deleting_storage(self):
        sub_id = uuid4()
        row = SimpleNamespace(
            Id=sub_id,
            SourceStoragePath="private-books/u1/b1/temp.png",
            WorkflowStatus="NEEDS_RECHECK",
            WorkerId="w1",
            LeaseExpiresAt=datetime.now(timezone.utc),
            RetryAfter=datetime.now(timezone.utc),
            UpdatedAt=datetime.now(timezone.utc),
        )
        events: list[str] = []

        fake_result = MagicMock()
        fake_result.scalars.return_value.all.return_value = [row]

        class _FakeDb:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def execute(self, stmt):
                sql = str(stmt).lower()
                self.last_sql = sql
                events.append("db_select_for_update" if "for update" in str(stmt).lower() else "db_select")
                return fake_result

            async def commit(self):
                events.append("db_commit")

            async def rollback(self):
                events.append("db_rollback")

        fake_db = _FakeDb()

        def _fake_delete(path, *, bucket_name=None):
            events.append(f"storage_delete:{path}:{bucket_name}")

        with (
            patch("app.jobs.parent_book_submission_worker.AsyncSessionLocal", lambda: fake_db),
            patch("app.jobs.parent_book_submission_worker.delete_object", _fake_delete),
        ):
            cleaned = await cleanup_expired_temp_submissions(now=datetime(2026, 6, 1, tzinfo=timezone.utc))

        self.assertEqual(cleaned, 1)
        self.assertEqual(row.WorkflowStatus, "CANCELLED")
        self.assertIsNone(row.WorkerId)
        self.assertLess(events.index("db_commit"), events.index("storage_delete:private-books/u1/b1/temp.png:viread-private-books"))


class Def009ServiceFixesTests(unittest.IsolatedAsyncioTestCase):
    async def test_parent_private_book_noop_update_preserves_ocr_contribution(self):
        db = MagicMock()
        service = ParentPrivateBookService(db)
        service._require_parent = AsyncMock()
        book = SimpleNamespace(
            Id=BOOK_ID,
            Title="Truyện Cỏ May",
            Author="An",
            MinGrade=1,
            MaxGrade=3,
            SourceDeclaration="Tôi tự chụp",
            SourceType="PHOTOS",
            ModerationStatus="ACTIVE",
            SuspendedReason=None,
            LifecycleStatus="ACTIVE",
            OwnerParentId=PARENT_ID,
            CreatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
            UpdatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
            CreatedBy=PARENT_ID,
        )
        service.repo = MagicMock(
            get_owned_private_book=AsyncMock(return_value=book),
            committed_page_counts=AsyncMock(return_value={BOOK_ID: 2}),
            list_submissions_for_book=AsyncMock(return_value=[]),
            is_private_book_readable=AsyncMock(return_value=True),
        )
        expected_contrib = ParentOcrContributionStateRead(
            book_id=BOOK_ID,
            enabled=True,
            status="OPTED_IN",
            status_notice="Đang bật đóng góp mẫu OCR",
            rights_confirmed=True,
            rights_eligible_for_training=True,
        )
        service._load_contribution_states = AsyncMock(return_value={BOOK_ID: expected_contrib})

        summary = await service.update_book(PARENT_ID, BOOK_ID, ParentPrivateBookUpdate())
        service._load_contribution_states.assert_awaited_once_with([book])
        self.assertIsNotNone(summary.ocr_contribution)
        self.assertEqual(summary.ocr_contribution.status, "OPTED_IN")

    async def test_admin_ocr_upload_page_honors_and_guards_explicit_page_number(self):
        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        svc = AdminOcrService(db)
        svc.require_admin = AsyncMock(return_value=ADMIN_ID)
        svc._read_validate_image = AsyncMock(return_value=(_png_bytes(), "image/png", "png", 32, 32))
        svc._discard_processing_page = AsyncMock()

        book = SimpleNamespace(Id=BOOK_ID, LifecycleStatus="ACTIVE")
        existing_page = SimpleNamespace(Id=uuid4(), PageNumber=2, LifecycleStatus="ACTIVE")
        svc.repo = MagicMock(
            book=AsyncMock(return_value=book),
            active_pages_for_renumber=AsyncMock(return_value=[existing_page]),
            stage_page_reservation=MagicMock(),
            flush=AsyncMock(),
        )

        # Colliding page_number=2 -> 409
        upload = UploadFile(filename="p2.png", file=BytesIO(_png_bytes()), headers=Headers({"content-type": "image/png"}))
        with self.assertRaises(HTTPException) as ctx:
            await svc.upload_page(ADMIN_ID, BOOK_ID, upload, page_number=2)
        self.assertEqual(ctx.exception.status_code, 409)

        # Non-colliding page_number=5 reserves PageNumber=5 before OCR continues
        staged_numbers: list[int] = []
        svc.repo.stage_page_reservation = MagicMock(side_effect=lambda page: staged_numbers.append(page.PageNumber))
        with patch("app.services.admin_ocr_service.upload_object", side_effect=RuntimeError("stop-after-stage")):
            svc._abort_page_upload = AsyncMock()
            with self.assertRaises((HTTPException, RuntimeError)):
                await svc.upload_page(ADMIN_ID, BOOK_ID, upload, page_number=5)
        self.assertEqual(staged_numbers, [5])


class Def010NPlusOneBatchingTests(unittest.IsolatedAsyncioTestCase):
    async def test_history_service_get_batches_answers(self):
        now = datetime(2026, 3, 1, tzinfo=timezone.utc)
        session = SimpleNamespace(
            Id=SESSION_ID,
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            SelectedPageRevisionId=None,
            State="COMPLETED",
            StartedAt=now,
            EndedAt=now + timedelta(minutes=5),
        )
        questions = [
            SimpleNamespace(
                Id=uuid4(),
                Type="FACTUAL",
                Prompt=f"Câu {i}",
                PageRevisionId=uuid4(),
                Difficulty=0.5,
                SourceSpan={
                    "start_word_index": 0,
                    "end_word_index_exclusive": 1,
                    "sentence_index": 0,
                },
            )
            for i in range(15)
        ]
        answers = [
            SimpleNamespace(
                Id=uuid4(),
                QuestionId=q.Id,
                Answer="mèo",
                IsCorrect=True,
                Score=1.0,
            )
            for q in questions
        ]

        db = MagicMock()
        repo = reading_routes.HistoryRepository(db)
        repo.role = AsyncMock(return_value="parent")
        repo.session = AsyncMock(return_value=session)
        repo.child = AsyncMock(return_value=SimpleNamespace(Id=CHILD_ID, Name="An"))
        repo.book = AsyncMock(return_value=SimpleNamespace(Id=BOOK_ID, Title="Sách", VisibilityScope="CATALOG"))
        repo.events = AsyncMock(return_value=[])
        repo.fluency = AsyncMock(return_value=None)
        repo.comparison_reports = AsyncMock(return_value=[])
        repo.session_page_rows = AsyncMock(return_value=[])
        repo.questions = AsyncMock(return_value=questions)
        repo.answer = AsyncMock()

        res_obj = MagicMock()
        res_obj.scalars.return_value.all.return_value = answers
        db.execute = AsyncMock(return_value=res_obj)

        out = await reading_routes.HistoryService(repo).get(SESSION_ID, PARENT_ID)
        self.assertEqual(len(out.comprehension), 15)
        db.execute.assert_awaited_once()
        repo.answer.assert_not_awaited()

    async def test_progress_repository_period_assessment_batches_in_3_queries(self):
        now = datetime(2026, 3, 2, tzinfo=timezone.utc)
        sessions = [
            SimpleNamespace(Id=uuid4(), StartedAt=now, EndedAt=now + timedelta(minutes=3))
            for _ in range(12)
        ]
        sess_res = MagicMock()
        sess_res.scalars.return_value.all.return_value = sessions
        rep_res = MagicMock()
        rep_res.scalars.return_value.all.return_value = []
        ev_res = MagicMock()
        ev_res.scalars.return_value.all.return_value = []

        db = MagicMock()
        db.execute = AsyncMock(side_effect=[sess_res, rep_res, ev_res])

        await ProgressRepository(db).period_assessment(
            CHILD_ID, PARENT_ID, date(2026, 3, 1), date(2026, 3, 7), now + timedelta(hours=1)
        )
        self.assertEqual(db.execute.await_count, 3)

    async def test_reading_management_service_eliminates_n_plus_1(self):
        now = datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)
        db = MagicMock()
        repo = ReadingManagementRepository(db)
        svc = ReadingManagementService(repo)
        svc.require_parent = AsyncMock()
        svc.owned_child = AsyncMock(return_value=SimpleNamespace(Id=CHILD_ID))

        # 10 goals -> 1 completed_sessions query
        goals = [
            SimpleNamespace(
                Id=uuid4(),
                ChildId=CHILD_ID,
                Metric="MINUTES",
                TargetValue=15,
                Period="DAILY",
                StartsOn=date(2026, 3, 1),
                EndsOn=None,
                Timezone="Asia/Ho_Chi_Minh",
                Status="ACTIVE",
                CompletedValue=None,
                CompletedAt=None,
                CreatedAt=now,
                UpdatedAt=now,
            )
            for _ in range(10)
        ]
        repo.goals = AsyncMock(return_value=goals)
        repo.completed_sessions = AsyncMock(return_value=[])
        goal_out = await svc.list_goals(PARENT_ID, CHILD_ID, now=now)
        self.assertEqual(len(goal_out), 10)
        repo.completed_sessions.assert_awaited_once()

        # 10 plans -> 1 completed_plan_sessions + 1 batched Book query (via AsyncSession)
        plans = [
            SimpleNamespace(
                Id=uuid4(),
                ChildId=CHILD_ID,
                BookId=BOOK_ID,
                Title=f"Plan {i}",
                TargetMinutes=10,
                Weekdays=[0, 2, 4],
                StartsOn=date(2026, 3, 1),
                EndsOn=None,
                Timezone="Asia/Ho_Chi_Minh",
                Status="ACTIVE",
                CompletedAt=None,
                CreatedAt=now,
                UpdatedAt=now,
            )
            for i in range(10)
        ]
        repo.plans = AsyncMock(return_value=plans)
        repo.completed_plan_sessions = AsyncMock(return_value=[])
        repo.book = AsyncMock()
        with patch.object(
            ReadingManagementService,
            "plan_dict",
            wraps=svc.plan_dict,
        ):
            out_plans = await svc.list_plans(PARENT_ID, CHILD_ID, now=now)
        self.assertEqual(len(out_plans), 10)
        repo.completed_plan_sessions.assert_awaited_once()

    async def test_parent_private_book_batches_summary_and_moderation_requests(self):
        from sqlalchemy.ext.asyncio import AsyncSession

        now = datetime(2026, 3, 10, tzinfo=timezone.utc)
        db = MagicMock(spec=AsyncSession)
        res_readable = MagicMock()
        res_readable.scalars.return_value.all.return_value = []
        res_reqs = MagicMock()
        res_reqs.scalars.return_value.all.return_value = []
        db.execute = AsyncMock(side_effect=[res_readable, res_reqs])

        svc = ParentPrivateBookService(db)
        books = [
            SimpleNamespace(
                Id=uuid4(),
                Title=f"Book {i}",
                Author="An",
                MinGrade=1,
                MaxGrade=3,
                SourceDeclaration="Tự viết",
                SourceType="PHOTOS",
                ModerationStatus="ACTIVE",
                SuspendedReason=None,
                LifecycleStatus="ACTIVE",
                OwnerParentId=PARENT_ID,
                CreatedAt=now,
                UpdatedAt=now,
                CreatedBy=PARENT_ID,
            )
            for i in range(10)
        ]
        svc.repo = MagicMock(
            committed_page_counts=AsyncMock(return_value={}),
            list_submissions_for_books=AsyncMock(
                return_value=[
                    SimpleNamespace(
                        Id=uuid4(),
                        BookId=b.Id,
                        WorkflowStatus="PENDING_ADMIN",
                        ToolCheckFindingsJson=None,
                        IsImageOnly=False,
                        ToolCheckPolicyBlocked=False,
                        SubmissionVersion=1,
                        BatchTotalPages=1,
                        UpdatedAt=now,
                        PageNumber=1,
                    )
                    for b in books
                ]
            ),
            is_private_book_readable=AsyncMock(),
            profile_display_map=AsyncMock(return_value={PARENT_ID: "Phụ huynh"}),
            list_all_private_books_for_admin=AsyncMock(return_value=books),
            list_user_books_for_admin=AsyncMock(return_value=books),
            get_open_moderation_request=AsyncMock(),
        )
        svc._load_contribution_states = AsyncMock(return_value={})
        svc._require_admin = AsyncMock()

        summaries = await svc._serialize_book_summaries(PARENT_ID, books, ready_only=False)
        self.assertEqual(len(summaries), 10)
        svc.repo.is_private_book_readable.assert_not_awaited()

        queue = await svc.admin_list_user_books(ADMIN_ID, limit=20, offset=0)
        self.assertEqual(queue.total, 10)
        svc.repo.get_open_moderation_request.assert_not_awaited()
        self.assertEqual(db.execute.await_count, 2)


if __name__ == "__main__":
    unittest.main()
