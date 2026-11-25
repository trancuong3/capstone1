from __future__ import annotations

import asyncio
import socket
import time
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from sqlalchemy.engine import make_url

from app.api.routes.system import AdminSystemService
from app.database.session import (
    clear_database_dns_cache,
    probe_database_connection,
)
from app.repositories.book_content_quality_repository import (
    BookContentQualityRepository,
)
from app.repositories.reading_content_repository import ReadingContentRepository
from app.schemas.reading import ReadingSessionCreate
from app.services.book_content_quality_service import BookContentQualityService
from app.services.book_service import CatalogService
from app.services.reading_content_service import ReadingContentService
from app.services.storage_service import create_signed_image_urls


class AdminHealthConcurrencyAndVoiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_health_uses_voice_orchestrator_and_runs_probes_concurrently(self) -> None:
        async def slow_db_probe():
            await asyncio.sleep(0.15)
            return True

        repo = MagicMock()
        repo.probe_database = AsyncMock(side_effect=slow_db_probe)
        service = AdminSystemService(repo)

        async def slow_local_ocr(_cfg):
            await asyncio.sleep(0.15)
            return "HEALTHY", "AI OCR cục bộ sẵn sàng."

        async def slow_voice_status():
            await asyncio.sleep(0.15)
            return {
                "default_mode": "local_only",
                "default_voice_id": "local_north_truc_ly",
                "local": {
                    "configured": True,
                    "mode": "remote",
                    "available": True,
                    "stt_ready": True,
                    "tts_ready": True,
                    "error_code": None,
                    "stt_error_code": None,
                    "tts_error_code": None,
                    "worker_version": "1.1.0",
                    "latency_ms": 22.0,
                    "stt_model_version": "sherpa",
                    "tts_model_version": "vieneu",
                },
                "google": {"stt_configured": False, "tts_configured": False},
            }

        def slow_ocr_engines():
            time.sleep(0.15)
            return [
                dict(
                    id="paddleocr",
                    label="PaddleOCR",
                    status="HEALTHY",
                    detail_status="healthy",
                    safe_message="Sẵn sàng.",
                )
            ]

        async def slow_storage():
            await asyncio.sleep(0.15)
            return dict(
                id="storage",
                label="Supabase Storage",
                status="HEALTHY",
                detail_status="healthy",
                safe_message="Storage đã sẵn sàng.",
            )

        with patch(
            "app.api.routes.system.LocalOcrCorrector.probe",
            AsyncMock(side_effect=slow_local_ocr),
        ), patch("app.api.routes.system.VoiceOrchestrator") as mock_orch_cls, patch(
            "app.api.routes.system.collect_ocr_health",
            side_effect=slow_ocr_engines,
        ), patch(
            "app.api.routes.system.probe_storage_health",
            AsyncMock(side_effect=slow_storage),
        ):
            mock_orch_cls.return_value.get_status = AsyncMock(side_effect=slow_voice_status)
            started = time.perf_counter()
            report = await service.health()
            elapsed = time.perf_counter() - started

        # 5 probes each taking 0.15s would exceed 0.75s if executed sequentially.
        self.assertLess(elapsed, 0.55, f"probes appeared sequential ({elapsed:.3f}s)")
        mock_orch_cls.return_value.get_status.assert_awaited_once()
        ids = [item.id for item in report.services]
        self.assertEqual(ids[:6], ["api", "database", "local_ocr", "tts", "stt", "storage"])
        self.assertEqual(report.overall_status, "HEALTHY")

    async def test_admin_health_isolates_single_probe_exception(self) -> None:
        repo = MagicMock()
        repo.probe_database = AsyncMock(return_value=True)
        service = AdminSystemService(repo)

        with patch(
            "app.api.routes.system.LocalOcrCorrector.probe",
            AsyncMock(return_value=("HEALTHY", "ok")),
        ), patch(
            "app.api.routes.system.VoiceOrchestrator"
        ) as mock_orch_cls, patch(
            "app.api.routes.system.collect_ocr_health",
            side_effect=RuntimeError("boom"),
        ), patch(
            "app.api.routes.system.probe_storage_health",
            AsyncMock(
                return_value=dict(
                    id="storage",
                    label="Supabase Storage",
                    status="HEALTHY",
                    detail_status="healthy",
                    safe_message="ok",
                )
            ),
        ):
            mock_orch_cls.return_value.get_status = AsyncMock(
                return_value={
                    "local": {
                        "configured": True,
                        "available": True,
                        "stt_ready": True,
                        "tts_ready": True,
                    },
                    "google": {},
                }
            )
            report = await service.health()

        self.assertEqual(report.overall_status, "DEGRADED")
        by_id = {item.id: item for item in report.services}
        self.assertEqual(by_id["database"].status, "HEALTHY")
        self.assertEqual(by_id["tts"].status, "HEALTHY")
        self.assertEqual(by_id["paddleocr"].status, "DEGRADED")


class SignedImageBatchingTests(unittest.IsolatedAsyncioTestCase):
    def test_create_signed_image_urls_batches_with_single_supabase_call(self) -> None:
        bucket = MagicMock()
        bucket.create_signed_urls.return_value = [
            {
                "path": "books/b1/p1.png",
                "signedURL": "/storage/v1/object/sign/book-pages/books/b1/p1.png?token=t1",
            },
            {
                "path": "books/b1/p2.png",
                "signedURL": "/storage/v1/object/sign/book-pages/books/b1/p2.png?token=t2",
            },
        ]
        supabase = MagicMock()
        supabase.storage.from_.return_value = bucket

        with patch("app.services.storage_service.SUPABASE_ADMIN_KEY", "srv-key"), patch(
            "app.services.storage_service.SUPABASE_URL", "https://proj.supabase.co"
        ), patch("app.services.storage_service.get_supabase_admin_client", return_value=supabase):
            urls = create_signed_image_urls(
                [
                    "books/b1/p1.png",
                    "https://legacy.example/public.png",
                    "books/b1/p2.png",
                    "books/b1/p1.png",
                ],
                bucket_name="book-pages",
            )

        bucket.create_signed_urls.assert_called_once()
        self.assertEqual(bucket.create_signed_urls.call_args.args[0], ["books/b1/p1.png", "books/b1/p2.png"])
        self.assertEqual(urls[1], "https://legacy.example/public.png")
        self.assertEqual(urls[0], urls[3])
        self.assertIn("token=t1", urls[0])
        self.assertIn("token=t2", urls[2])

    def test_create_signed_image_urls_falls_back_to_parallel_executor_if_batch_missing(self) -> None:
        class _LegacyBucket:
            def __init__(self) -> None:
                self.calls: list[str] = []

            def create_signed_url(self, path: str, expires_in: int):
                self.calls.append(path)
                return {
                    "signedURL": f"https://cdn.example.supabase.co/storage/v1/object/sign/book-pages/{path}?token=x"
                }

        bucket = _LegacyBucket()
        supabase = MagicMock()
        supabase.storage.from_.return_value = bucket

        with patch("app.services.storage_service.SUPABASE_ADMIN_KEY", "srv-key"), patch(
            "app.services.storage_service.SUPABASE_URL", "https://cdn.example.supabase.co"
        ), patch("app.services.storage_service.get_supabase_admin_client", return_value=supabase):
            urls = create_signed_image_urls(["p1.png", "p2.png"], bucket_name="book-pages")

        self.assertEqual(sorted(bucket.calls), ["p1.png", "p2.png"])
        self.assertTrue(all(u.startswith("https://cdn.example.supabase.co/") for u in urls))

    def test_create_signed_image_urls_rejects_invalid_and_credentialed_refs(self) -> None:
        with patch("app.services.storage_service.get_supabase_admin_client") as mock_client:
            with self.assertRaises(HTTPException) as bad_empty:
                create_signed_image_urls([None])
            self.assertEqual(bad_empty.exception.status_code, 503)

            with self.assertRaises(HTTPException) as bad_cred:
                create_signed_image_urls(["https://user:pass@evil.example/p1.png"])
            self.assertEqual(bad_cred.exception.status_code, 503)

            mock_client.assert_not_called()

    async def test_catalog_previews_uses_batched_create_signed_image_urls(self) -> None:
        book_id = uuid.uuid4()
        repo = MagicMock()
        repo.db = MagicMock()
        repo.db.rollback = AsyncMock()
        repo.get = AsyncMock(
            return_value=SimpleNamespace(
                Id=book_id,
                LifecycleStatus="ACTIVE",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
            )
        )
        repo.is_eligible = AsyncMock(return_value=True)
        repo.previews = AsyncMock(
            return_value=[
                SimpleNamespace(
                    Id=uuid.uuid4(),
                    PageNumber=1,
                    LifecycleStatus="ACTIVE",
                    CurrentVerifiedRevisionId=uuid.uuid4(),
                    ImagePath="books/1/p1.png",
                ),
                SimpleNamespace(
                    Id=uuid.uuid4(),
                    PageNumber=2,
                    LifecycleStatus="ACTIVE",
                    CurrentVerifiedRevisionId=uuid.uuid4(),
                    ImagePath="books/1/p2.png",
                ),
            ]
        )

        service = CatalogService(repository=repo)
        with patch(
            "app.services.book_service.create_signed_image_urls",
            return_value=["https://signed/p1.png", "https://signed/p2.png"],
        ) as mock_batch:
            result = await service.previews(book_id)

        mock_batch.assert_called_once_with(["books/1/p1.png", "books/1/p2.png"])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].preview_url, "https://signed/p1.png")
        self.assertEqual(result[1].preview_url, "https://signed/p2.png")


class BookContentQualityBatchingTests(unittest.IsolatedAsyncioTestCase):
    async def test_list_books_uses_batched_latest_scans_for_books(self) -> None:
        now = datetime.now(timezone.utc)
        actor_id = uuid.uuid4()
        books = [
            SimpleNamespace(Id=uuid.uuid4(), Title=f"Sách {i}")
            for i in range(4)
        ]
        assessment_tuple_rows = [(b, 1, 0, 0, 0) for b in books]
        scan_for_first = SimpleNamespace(
            Id=uuid.uuid4(),
            BookId=books[0].Id,
            BookTitleSnapshot="Sách 0",
            TriggerType="manual",
            Scope="BOOK",
            TargetPageId=None,
            Status="COMPLETED",
            TotalPages=3,
            CompletedPages=3,
            SkippedPages=0,
            FailedPages=0,
            AICompletedPages=3,
            AIUnavailablePages=0,
            ErrorSummary=None,
            StartedAt=now,
            CompletedAt=now,
            CreatedAt=now,
        )

        repo = MagicMock()
        repo.role = AsyncMock(return_value="admin")
        repo.all_books_for_assessment = AsyncMock(return_value=assessment_tuple_rows)
        repo.all_book_assessment_rows = AsyncMock(return_value=[])
        repo.book_decisions_for_books = AsyncMock(return_value=[])
        repo.list_rights_evidences_for_books = AsyncMock(return_value=[])
        repo.latest_scans_for_books = AsyncMock(return_value={books[0].Id: scan_for_first})
        repo.latest_scan = AsyncMock(side_effect=AssertionError("N+1 latest_scan must not be called"))

        service = BookContentQualityService(repo)
        resp = await service.list_books(actor_id, search=None, limit=20, offset=0)

        repo.latest_scans_for_books.assert_awaited_once_with([b.Id for b in books])
        repo.latest_scan.assert_not_called()
        self.assertEqual(resp.total, 4)
        self.assertIsNotNone(resp.items[0].latest_scan)
        self.assertIsNone(resp.items[1].latest_scan)

    async def test_scan_detail_uses_batched_findings_for_scan(self) -> None:
        now = datetime.now(timezone.utc)
        actor_id = uuid.uuid4()
        book_id = uuid.uuid4()
        scan_id = uuid.uuid4()
        ps1_id = uuid.uuid4()
        ps2_id = uuid.uuid4()
        run = SimpleNamespace(
            Id=scan_id,
            BookId=book_id,
            BookTitleSnapshot="Sách mẫu",
            TriggerType="manual",
            Scope="BOOK",
            TargetPageId=None,
            Status="COMPLETED",
            TotalPages=2,
            CompletedPages=2,
            SkippedPages=0,
            FailedPages=0,
            AICompletedPages=2,
            AIUnavailablePages=0,
            ErrorSummary=None,
            StartedAt=now,
            CompletedAt=now,
            CreatedAt=now,
        )
        page_scans = [
            SimpleNamespace(
                Id=ps1_id,
                PageId=uuid.uuid4(),
                PageNumberSnapshot=1,
                PageLifecycleSnapshot="ACTIVE",
                PageRevisionId=uuid.uuid4(),
                ContentHash="h1",
                Status="COMPLETED",
                RuleCheckStatus="COMPLETED",
                AIAnalysisStatus="COMPLETED",
                RejectedAIFindingCount=0,
                ErrorCode=None,
                ErrorSummary=None,
            ),
            SimpleNamespace(
                Id=ps2_id,
                PageId=uuid.uuid4(),
                PageNumberSnapshot=2,
                PageLifecycleSnapshot="ACTIVE",
                PageRevisionId=uuid.uuid4(),
                ContentHash="h2",
                Status="COMPLETED",
                RuleCheckStatus="COMPLETED",
                AIAnalysisStatus="COMPLETED",
                RejectedAIFindingCount=0,
                ErrorCode=None,
                ErrorSummary=None,
            ),
        ]
        finding = SimpleNamespace(
            Id=uuid.uuid4(),
            PageScanId=ps2_id,
            BookId=book_id,
            PageId=page_scans[1].PageId,
            PageRevisionId=page_scans[1].PageRevisionId,
            IssueType="spelling_ocr",
            Severity="MEDIUM",
            OriginalExcerpt="mèo",
            ExcerptStart=0,
            ExcerptEnd=3,
            SuggestedCorrection="mèo",
            Explanation="Kiểm tra lại dấu",
            DetectionSource="RULE",
            ModelName=None,
            Confidence=0.8,
            Status="NEEDS_REVIEW",
            ReviewNote=None,
            CreatedAt=now,
        )

        repo = MagicMock()
        repo.role = AsyncMock(return_value="admin")
        repo.scan_run = AsyncMock(return_value=run)
        repo.page_scans = AsyncMock(return_value=page_scans)
        repo.findings_for_scan = AsyncMock(return_value={ps2_id: [finding]})
        repo.findings_for_page_scan = AsyncMock(
            side_effect=AssertionError("N+1 findings_for_page_scan must not be called")
        )

        service = BookContentQualityService(repo)
        detail = await service.get_scan_detail(actor_id, scan_id)

        repo.findings_for_scan.assert_awaited_once_with(scan_id)
        repo.findings_for_page_scan.assert_not_called()
        self.assertEqual(len(detail.pages), 2)
        self.assertEqual(len(detail.pages[0].findings), 0)
        self.assertEqual(len(detail.pages[1].findings), 1)

    async def test_repository_batch_queries_compile_cleanly(self) -> None:
        mock_db = MagicMock()
        scalar_result = MagicMock()
        scalar_result.all.return_value = []
        mock_db.scalars = AsyncMock(return_value=scalar_result)

        repo = BookContentQualityRepository(mock_db)
        empty_scans = await repo.latest_scans_for_books([])
        self.assertEqual(empty_scans, {})
        mock_db.scalars.assert_not_called()

        b1, b2 = uuid.uuid4(), uuid.uuid4()
        await repo.latest_scans_for_books([b1, b2])
        self.assertEqual(mock_db.scalars.await_count, 1)
        stmt_sql = str(mock_db.scalars.await_args.args[0])
        self.assertIn("row_number()", stmt_sql.lower())

        await repo.findings_for_scan(uuid.uuid4())
        self.assertEqual(mock_db.scalars.await_count, 2)


class ReadingContentBatchingTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_session_and_get_session_page_use_batched_queries(self) -> None:
        mock_db = MagicMock()
        mock_db.sync_session = SimpleNamespace(expire_on_commit=False)
        mock_db.add = MagicMock()
        mock_db.add_all = MagicMock()
        mock_db.flush = AsyncMock()
        mock_db.commit = AsyncMock()
        mock_db.refresh = AsyncMock()
        mock_db.rollback = AsyncMock()

        repo = ReadingContentRepository(mock_db)
        child_id = uuid.uuid4()
        actor_id = uuid.uuid4()
        book_id = uuid.uuid4()

        page_ids = [uuid.uuid4() for _ in range(1, 5)]
        rev_ids = [uuid.uuid4() for _ in range(1, 5)]
        pages = [
            SimpleNamespace(
                Id=pid,
                BookId=book_id,
                PageNumber=i,
                ImagePath=f"books/{book_id}/p{i}.png",
                LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=rid,
                Width=800,
                Height=1200,
            )
            for i, (pid, rid) in enumerate(zip(page_ids, rev_ids), start=1)
        ]
        revisions = [
            SimpleNamespace(
                Id=rid,
                BookPageId=pid,
                VerifiedText=f"Trang {i}",
                DraftText=None,
                OriginalOcrText=None,
                VerificationStatus="VERIFIED",
                Version=1,
            )
            for i, (pid, rid) in enumerate(zip(page_ids, rev_ids), start=1)
        ]
        book = SimpleNamespace(
            Id=book_id,
            Title="Truyện thiếu nhi",
            Author="Tác giả",
            Level=1,
            OwnerParentId=None,
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
        )
        word_rows = [(rev.Id, "Trang", [0.1, 0.1, 0.2, 0.05]) for rev in revisions]

        with patch.object(repo, "profile_role", AsyncMock(return_value="parent")), patch.object(
            repo, "session_start_context", AsyncMock(return_value=(True, book, True))
        ) as m_ctx, patch.object(
            repo,
            "active_book_pages_with_revisions",
            AsyncMock(return_value=[(p, r, True) for p, r in zip(pages, revisions)]),
        ) as m_pages, patch.object(
            repo,
            "revision_word_validation_rows",
            AsyncMock(return_value=word_rows),
        ) as m_words, patch.object(
            repo, "verified_revision", AsyncMock(side_effect=AssertionError("N+1 verified_revision"))
        ), patch.object(
            repo, "revision_words", AsyncMock(side_effect=AssertionError("N+1 revision_words"))
        ):
            service = ReadingContentService(repo)
            payload = ReadingSessionCreate(
                ChildId=child_id,
                BookId=book_id,
                SelectedPageId=pages[0].Id,
                EndPageId=pages[-1].Id,
            )
            session = await service.create_session(actor_id, payload)

        m_ctx.assert_awaited_once_with(child_id, book_id, actor_id)
        m_pages.assert_awaited_once()
        m_words.assert_awaited_once()
        self.assertEqual(session.BookId, book_id)
        self.assertEqual(session.CurrentPageId, pages[0].Id)
        mock_db.add_all.assert_called_once()
        self.assertEqual(len(mock_db.add_all.call_args.args[0]), 4)
        mock_db.refresh.assert_not_called()

        # Verify get_session_page uses session_with_ownership_and_book + session_pages_with_content
        session_row = SimpleNamespace(Id=session.Id, BookId=book_id, CurrentPageId=pages[0].Id)
        session_page_row = SimpleNamespace(
            Id=uuid.uuid4(),
            SessionId=session.Id,
            PageId=pages[0].Id,
            PageRevisionId=revisions[0].Id,
            PageNumber=1,
            Status="IN_PROGRESS",
        )
        word_row = SimpleNamespace(
            Id=uuid.uuid4(),
            PageRevisionId=revisions[0].Id,
            WordIndex=1,
            Text="Trang",
            BoundingBox=[0.1, 0.1, 0.2, 0.05],
            LineIndex=0,
        )
        with patch.object(repo, "profile_role", AsyncMock(return_value="parent")), patch.object(
            repo, "session_with_ownership_and_book", AsyncMock(return_value=(session_row, book, True))
        ) as m_sess_ctx, patch.object(
            repo,
            "session_pages_with_content",
            AsyncMock(return_value=[(session_page_row, pages[0], revisions[0])]),
        ) as m_sess_pages, patch.object(
            repo, "revision_words", AsyncMock(return_value=[word_row])
        ), patch(
            "app.services.reading_content_service.create_signed_image_url",
            return_value="https://signed/p1.png",
        ):
            page_dto = await service.get_session_page(session.Id, actor_id)

        m_sess_ctx.assert_awaited_once_with(session.Id, actor_id)
        m_sess_pages.assert_awaited_once_with(session.Id)
        self.assertEqual(page_dto.page_id, pages[0].Id)
        self.assertEqual(page_dto.image_url, "https://signed/p1.png")


class DatabaseDnsCacheTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_database_dns_cache()

    def tearDown(self) -> None:
        clear_database_dns_cache()

    async def test_probe_database_connection_caches_dns_for_60s_and_always_runs_select_1(self) -> None:
        mock_session = AsyncMock()
        mock_session.scalar = AsyncMock(return_value=1)
        mock_cm = MagicMock()
        mock_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cm.__aexit__ = AsyncMock(return_value=False)
        mock_session_maker = MagicMock(return_value=mock_cm)

        fake_getaddrinfo = AsyncMock(
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("203.0.113.10", 5432))]
        )

        with patch(
            "app.database.session.sqlalchemy_database_url",
            make_url("postgresql+asyncpg://u:p@db.example.internal:5432/postgres"),
        ), patch("app.database.session.AsyncSessionLocal", mock_session_maker):
            loop = asyncio.get_running_loop()
            with patch.object(loop, "getaddrinfo", fake_getaddrinfo):
                first = await probe_database_connection(timeout=2.0)
                second = await probe_database_connection(timeout=2.0)

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(fake_getaddrinfo.await_count, 1)
        self.assertEqual(mock_session.scalar.await_count, 2)

    async def test_probe_database_connection_does_not_cache_dns_failures(self) -> None:
        fake_getaddrinfo = AsyncMock(side_effect=socket.gaierror(-2, "name resolution failed"))
        with patch(
            "app.database.session.sqlalchemy_database_url",
            make_url("postgresql+asyncpg://u:p@bad-host.invalid:5432/postgres"),
        ):
            loop = asyncio.get_running_loop()
            with patch.object(loop, "getaddrinfo", fake_getaddrinfo):
                r1 = await probe_database_connection(timeout=1.0)
                r2 = await probe_database_connection(timeout=1.0)

        self.assertFalse(r1["ok"])
        self.assertFalse(r2["ok"])
        self.assertEqual(r1["error_type"], "gaierror")
        self.assertEqual(fake_getaddrinfo.await_count, 2)


if __name__ == "__main__":
    unittest.main()
