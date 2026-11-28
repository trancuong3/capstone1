"""Unit tests for Phase 4A + 5: Storage retry/timeout, rasterizer concurrency gate,
Admin dead-letter reservation discard & idempotency rollback, and Parent lightweight polling / batch retry.
"""
from __future__ import annotations

import asyncio
import os
import unittest
from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "test-bucket")

import httpx
from fastapi import HTTPException, Response, UploadFile
from PIL import Image

from app.api.routes.admin_ocr import discard_admin_failed_page_reservation
from app.api.routes.parent_private_book import (
    get_my_private_book,
    retry_all_my_failed_submissions,
)
from app.services import document_rasterizer_service as raster_mod
from app.services import storage_service
from app.services.admin_ocr_service import AdminOcrService
from app.services.parent_private_book_service import ParentPrivateBookService


class _HttpStatusError(RuntimeError):
    def __init__(self, status_code: int, message: str = "upstream error") -> None:
        super().__init__(message)
        self.status_code = status_code


def _make_png_bytes() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (64, 64), (245, 245, 245)).save(buf, format="PNG")
    return buf.getvalue()


class StorageServiceRetryAndTimeoutTests(unittest.IsolatedAsyncioTestCase):
    def test_upload_object_retries_522_and_timeout_and_sets_explicit_timeout(self) -> None:
        calls = {"count": 0}
        http_client = httpx.Client()
        try:
            class _FakeBucket:
                _client = http_client

                def upload(self, path, data, file_options=None):
                    calls["count"] += 1
                    if calls["count"] == 1:
                        raise _HttpStatusError(522, "Cloudflare 522")
                    if calls["count"] == 2:
                        raise TimeoutError("timed out")
                    return {"path": path}

            with (
                patch.object(storage_service, "_local_storage_path", return_value=None),
                patch.object(storage_service, "_storage_bucket", return_value=_FakeBucket()),
            ):
                storage_service.upload_object(
                    "books/b1/pages/p1.jpg",
                    b"hello",
                    "image/jpeg",
                    timeout=18.5,
                    retry_base_delay=0.0,
                )

            self.assertEqual(calls["count"], 3)
            self.assertIsInstance(http_client.timeout, httpx.Timeout)
            self.assertEqual(http_client.timeout.read, 18.5)
            self.assertEqual(http_client.timeout.write, 18.5)
        finally:
            http_client.close()

    def test_upload_object_does_not_retry_on_4xx(self) -> None:
        for code in (400, 401, 403, 404):
            with self.subTest(status_code=code):
                calls = {"count": 0}

                class _FakeBucket:
                    def upload(self, path, data, file_options=None):
                        calls["count"] += 1
                        raise _HttpStatusError(code, f"HTTP {code}")

                with (
                    patch.object(storage_service, "_local_storage_path", return_value=None),
                    patch.object(storage_service, "_storage_bucket", return_value=_FakeBucket()),
                ):
                    with self.assertRaises(storage_service.StorageUploadFailure) as ctx:
                        storage_service.upload_object(
                            "books/b1/pages/p1.jpg",
                            b"hello",
                            "image/jpeg",
                            retry_base_delay=0.0,
                        )

                self.assertEqual(calls["count"], 1)
                self.assertFalse(ctx.exception.cleanup_may_be_needed)

    def test_download_object_retries_transient_errors_but_never_4xx(self) -> None:
        calls = {"count": 0}
        http_client = httpx.Client()
        try:
            class _FlakyBucket:
                _client = http_client

                def download(self, path):
                    calls["count"] += 1
                    if calls["count"] == 1:
                        raise ConnectionResetError("connection reset by peer")
                    if calls["count"] == 2:
                        raise _HttpStatusError(524, "Cloudflare 524")
                    return b"page-bytes"

            with (
                patch.object(storage_service, "_local_storage_path", return_value=None),
                patch.object(storage_service, "_storage_bucket", return_value=_FlakyBucket()),
            ):
                data = storage_service.download_object(
                    "books/b1/pages/p1.jpg",
                    timeout=14.0,
                    retry_base_delay=0.0,
                )

            self.assertEqual(data, b"page-bytes")
            self.assertEqual(calls["count"], 3)
            self.assertEqual(http_client.timeout.read, 14.0)
        finally:
            http_client.close()

        # 404 must fail immediately without retry
        calls_404 = {"count": 0}

        class _MissingBucket:
            def download(self, path):
                calls_404["count"] += 1
                raise _HttpStatusError(404, "not found")

        with (
            patch.object(storage_service, "_local_storage_path", return_value=None),
            patch.object(storage_service, "_storage_bucket", return_value=_MissingBucket()),
        ):
            with self.assertRaises(HTTPException) as ctx:
                storage_service.download_object("books/b1/pages/missing.jpg", retry_base_delay=0.0)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(calls_404["count"], 1)

    async def test_download_object_async_retries_522_and_passes_explicit_timeout(self) -> None:
        recorded_timeouts: list[object] = []
        responses = [
            httpx.Response(522, request=httpx.Request("GET", "https://example.supabase.co/obj")),
            httpx.Response(503, request=httpx.Request("GET", "https://example.supabase.co/obj")),
            httpx.Response(200, content=b"async-bytes", request=httpx.Request("GET", "https://example.supabase.co/obj")),
        ]

        async def _fake_get(url, headers=None, timeout=None):
            recorded_timeouts.append(timeout)
            return responses.pop(0)

        fake_client = SimpleNamespace(get=_fake_get)
        with (
            patch.object(storage_service, "_local_storage_path", return_value=None),
            patch.object(storage_service, "SUPABASE_STORAGE_BUCKET", "test-bucket"),
            patch.object(storage_service, "SUPABASE_URL", "https://example.supabase.co"),
            patch.object(storage_service, "SUPABASE_ADMIN_KEY", "service-key"),
            patch.object(storage_service, "_get_storage_async_client", return_value=fake_client),
        ):
            data = await storage_service.download_object_async(
                "books/b1/pages/p1.jpg",
                timeout=16.0,
                retry_base_delay=0.0,
            )

        self.assertEqual(data, b"async-bytes")
        self.assertEqual(len(recorded_timeouts), 3)
        self.assertIsInstance(recorded_timeouts[0], httpx.Timeout)
        self.assertEqual(recorded_timeouts[0].read, 16.0)


class RasterizerConcurrencyGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrency_gate_limits_to_1_on_render_and_2_locally(self) -> None:
        clean_env = {
            "RENDER": "",
            "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "",
            "VIREAD_OCR_MODE": "",
            "VIREAD_RASTERIZER_MAX_CONCURRENCY": "",
        }
        with patch.dict(os.environ, {**clean_env, "RENDER": "true"}, clear=False):
            self.assertEqual(raster_mod.resolve_rasterizer_concurrency_limit(), 1)
            in_flight = 0
            max_in_flight = 0

            async def _worker() -> None:
                nonlocal in_flight, max_in_flight
                async with raster_mod.rasterizer_concurrency_gate():
                    in_flight += 1
                    max_in_flight = max(max_in_flight, in_flight)
                    await asyncio.sleep(0.02)
                    in_flight -= 1

            await asyncio.gather(_worker(), _worker(), _worker())
            self.assertEqual(max_in_flight, 1)

        with patch.dict(os.environ, clean_env, clear=False):
            self.assertEqual(raster_mod.resolve_rasterizer_concurrency_limit(), 2)
            in_flight = 0
            max_in_flight = 0

            async def _worker_local() -> None:
                nonlocal in_flight, max_in_flight
                async with raster_mod.rasterizer_concurrency_gate():
                    in_flight += 1
                    max_in_flight = max(max_in_flight, in_flight)
                    await asyncio.sleep(0.02)
                    in_flight -= 1

            await asyncio.gather(_worker_local(), _worker_local(), _worker_local())
            self.assertEqual(max_in_flight, 2)


class AdminReservationDiscardAndIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_discard_failed_page_reservation_retires_dead_lettered_processing_page(self) -> None:
        actor_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        book = SimpleNamespace(Id=book_id, LifecycleStatus="ACTIVE")
        page = SimpleNamespace(
            Id=page_id,
            BookId=book_id,
            PageNumber=3,
            LifecycleStatus="PROCESSING",
            ProcessingMeta={"ocr_failed": True, "last_ocr_error_code": "OCR_TIMEOUT"},
        )

        db = MagicMock()
        db.scalar = AsyncMock(return_value=None)  # No active OCR job
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.refresh = AsyncMock()

        def _set_status(target_page, new_status):
            target_page.LifecycleStatus = new_status
            return target_page

        with (
            patch.object(AdminOcrService, "require_admin", new=AsyncMock()),
            patch.object(AdminOcrService, "_renumber_active_pages", new=AsyncMock(return_value=True)),
            patch("app.repositories.admin_ocr_repository.AdminOcrRepository.book", new=AsyncMock(return_value=book)),
            patch("app.repositories.admin_ocr_repository.AdminOcrRepository.page", new=AsyncMock(return_value=page)),
            patch("app.repositories.admin_ocr_repository.AdminOcrRepository.flush", new=AsyncMock()),
            patch("app.repositories.admin_ocr_repository.AdminOcrRepository.set_page_lifecycle_status", side_effect=_set_status),
        ):
            result = await discard_admin_failed_page_reservation(
                book_id=book_id,
                page_id=page_id,
                actor_id=actor_id,
                db=db,
            )

        self.assertEqual(result.page_id, page_id)
        self.assertEqual(result.book_id, book_id)
        self.assertEqual(result.lifecycle_status, "RETIRED")
        self.assertEqual(page.LifecycleStatus, "RETIRED")
        self.assertTrue(page.ProcessingMeta["discarded_failed_reservation"])
        db.commit.assert_awaited_once()

    async def test_discard_failed_page_reservation_rejects_invalid_states(self) -> None:
        actor_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        book = SimpleNamespace(Id=book_id, LifecycleStatus="ACTIVE")

        cases = [
            ("ACTIVE", {"ocr_failed": True}, None),
            ("PROCESSING", {"ocr_failed": False}, None),
            ("PROCESSING", {"ocr_failed": True}, uuid4()),  # Active job still running
        ]
        for lifecycle, meta, active_job in cases:
            with self.subTest(lifecycle=lifecycle, meta=meta, active_job=bool(active_job)):
                page = SimpleNamespace(
                    Id=page_id,
                    BookId=book_id,
                    PageNumber=1,
                    LifecycleStatus=lifecycle,
                    ProcessingMeta=dict(meta),
                )
                db = MagicMock()
                db.scalar = AsyncMock(return_value=active_job)
                db.rollback = AsyncMock()
                db.commit = AsyncMock()
                with (
                    patch.object(AdminOcrService, "require_admin", new=AsyncMock()),
                    patch("app.repositories.admin_ocr_repository.AdminOcrRepository.book", new=AsyncMock(return_value=book)),
                    patch("app.repositories.admin_ocr_repository.AdminOcrRepository.page", new=AsyncMock(return_value=page)),
                ):
                    with self.assertRaises(HTTPException) as ctx:
                        await AdminOcrService(db).discard_failed_page_reservation(
                            actor_id, book_id, page_id
                        )
                self.assertEqual(ctx.exception.status_code, 409)
                db.commit.assert_not_awaited()

    async def test_enqueue_upload_document_jobs_rolls_back_before_continue_on_idempotency_hit(self) -> None:
        actor_id = uuid4()
        book_id = uuid4()
        upload_id = uuid4()
        png_bytes = _make_png_bytes()
        import hashlib

        # Render via actual rasterizer first so digest matches normalized bytes
        bundle = raster_mod.rasterize_uploaded_document(
            filename="page.png", content_type="image/png", data=png_bytes
        )
        expected_digest = hashlib.sha256(bundle.pages[0].image_bytes).hexdigest()

        existing_job = SimpleNamespace(
            Id=uuid4(),
            JobKind="ADMIN_PAGE_UPLOAD",
            Status="QUEUED",
            Priority=20,
            BookId=book_id,
            PageId=uuid4(),
            RevisionId=None,
            SubmissionId=None,
            ImageSha256=expected_digest,
            WorkerId=None,
            AttemptCount=0,
            MaxAttempts=3,
            ErrorCode=None,
            ErrorMessage=None,
            CancelledReason=None,
            ProcessingMeta={"file_name": "page.png"},
            CreatedAt=datetime.now(timezone.utc),
            UpdatedAt=datetime.now(timezone.utc),
            CompletedAt=None,
        )

        db = MagicMock()
        db.rollback = AsyncMock()
        db.commit = AsyncMock()

        upload = UploadFile(file=BytesIO(png_bytes), filename="page.png", headers={"content-type": "image/png"})
        fake_book = SimpleNamespace(Id=book_id, LifecycleStatus="ACTIVE")

        fake_job_svc = MagicMock()
        fake_job_svc.repo = MagicMock()
        fake_job_svc.repo.get_by_idempotency = AsyncMock(return_value=existing_job)
        fake_job_svc.has_online_worker = AsyncMock(return_value=True)
        fake_job_svc._safe_queue_positions = AsyncMock(return_value={existing_job.Id: 1})

        with (
            patch.object(AdminOcrService, "require_admin", new=AsyncMock()),
            patch.object(AdminOcrService, "dispatch_batch_book_import_job", new=AsyncMock(return_value=None)),
            patch("app.repositories.admin_ocr_repository.AdminOcrRepository.book", new=AsyncMock(return_value=fake_book)),
            patch("app.services.admin_ocr_service.OcrInferenceJobService", return_value=fake_job_svc),
        ):
            payload = await AdminOcrService(db).enqueue_upload_document_jobs(
                actor_id, book_id, upload, upload_id=upload_id
            )

        self.assertEqual(payload["queued_count"], 1)
        self.assertGreaterEqual(db.rollback.await_count, 1)


class ParentPrivateBookPollingAndBatchRetryTests(unittest.IsolatedAsyncioTestCase):
    def _make_book(self, actor_id: UUID, book_id: UUID) -> SimpleNamespace:
        now = datetime.now(timezone.utc)
        return SimpleNamespace(
            Id=book_id,
            Title="Truyện Riêng",
            Name="Truyện Riêng",
            Author="Ba Mẹ",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="ACTIVE",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=actor_id,
            ModerationStatus="ACTIVE",
            SuspendedReason=None,
            SourceDeclaration="[OWNED_PHYSICAL_BOOK]",
            CreatedAt=now,
        )

    def _make_submission(
        self,
        actor_id: UUID,
        book_id: UUID,
        *,
        workflow_status: str = "CHECK_FAILED",
        ocr_status: str = "FAILED",
        proofread_status: str = "PENDING",
        tool_check_status: str = "PENDING",
        source_page: int = 1,
    ) -> SimpleNamespace:
        now = datetime.now(timezone.utc)
        return SimpleNamespace(
            Id=uuid4(),
            BookId=book_id,
            OwnerParentId=actor_id,
            BatchId=uuid4(),
            BatchTotalPages=2,
            SourcePageNumber=source_page,
            TargetPageNumber=source_page,
            SourceFileName=f"page-{source_page}.jpg",
            SourceFormat="IMAGE",
            SourceStoragePath=f"private-books/{actor_id}/{book_id}/staging/p{source_page}.jpg",
            SourceSha256="a" * 64,
            ImageWidth=800,
            ImageHeight=1000,
            SourceType="OWNED_PHYSICAL_BOOK",
            SourceNote=None,
            SubmissionVersion=1,
            OptimisticLockVersion=1,
            WorkflowStatus=workflow_status,
            OcrStatus=ocr_status,
            OcrText="Mèo con đi học." if ocr_status == "COMPLETED" else None,
            OcrWordsJson=[],
            OcrMetaJson={},
            OcrHash=None,
            OcrErrorCode="OCR_TIMEOUT" if ocr_status == "FAILED" else None,
            IsImageOnly=False,
            ProofreadStatus=proofread_status,
            ProofreadText=None,
            ProofreadHash=None,
            ProofreadSuggestionsJson=[],
            UncertainWordIndicesJson=[],
            ProofreadProviderEventsJson=[],
            ProofreadErrorCode="PROVIDER_TIMEOUT" if proofread_status == "FAILED" else None,
            SpellingAcceptedAt=None,
            CandidateText="Mèo con đi học." if ocr_status == "COMPLETED" else None,
            CandidateHash="b" * 64 if ocr_status == "COMPLETED" else None,
            CandidateWordsJson=[],
            ToolCheckStatus=tool_check_status,
            ToolCheckInputHash=None,
            ToolCheckSuitability=None,
            ToolCheckScopeJson={},
            ToolCheckFindingsJson=[],
            ToolCheckProviderEventsJson=[],
            ToolCheckErrorCode=None,
            ToolCheckPolicyBlocked=False,
            ToolCheckWorkflowId=None,
            ToolCheckCompletedAt=None,
            ApprovedSnapshotHash=None,
            ApprovedSubmissionVersion=None,
            ApprovedBy=None,
            ApprovedAt=None,
            AdminDecision=None,
            AdminDecisionReason=None,
            CommittedPageId=None,
            CommittedRevisionId=None,
            CommittedAt=None,
            WorkerId="w1",
            LeaseExpiresAt=now,
            RetryAfter=now,
            TempExpiresAt=now,
            CreatedAt=now,
            UpdatedAt=now,
        )

    async def test_get_my_private_book_summary_only_skips_readability_recomputation(self) -> None:
        actor_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        now = datetime.now(timezone.utc)
        book = self._make_book(actor_id, book_id)
        page = SimpleNamespace(
            Id=page_id,
            BookId=book_id,
            PageNumber=1,
            CurrentVerifiedRevisionId=rev_id,
            ImagePath=f"private-books/{actor_id}/{book_id}/pages/{page_id}/rev-1.jpg",
            CreatedAt=now,
        )
        rev = SimpleNamespace(Id=rev_id, VerifiedText="Chú mèo con trèo cây cau dưới nắng sớm.")
        sub = self._make_submission(
            actor_id,
            book_id,
            workflow_status="CHECKING",
            ocr_status="RUNNING",
            proofread_status="PENDING",
            tool_check_status="PENDING",
        )

        db = MagicMock()
        request = SimpleNamespace(base_url="http://127.0.0.1:8000/")
        response = Response()

        with (
            patch.object(ParentPrivateBookService, "_require_parent", new=AsyncMock()),
            patch.object(ParentPrivateBookService, "_load_contribution_states", new=AsyncMock(return_value={})),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.get_owned_private_book", new=AsyncMock(return_value=book)),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.list_committed_pages", new=AsyncMock(return_value=[(page, rev)])),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.list_submissions_for_book", new=AsyncMock(return_value=[sub])),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.is_private_book_readable", new=AsyncMock(return_value=True)),
            patch("app.services.vietnamese_readability.analyse_vietnamese_readability") as mock_analyse,
        ):
            summary_result = await get_my_private_book(
                book_id=book_id,
                request=request,
                response=response,
                summary_only=True,
                actor_id=actor_id,
                db=db,
            )
            mock_analyse.assert_not_called()
            self.assertIsNone(summary_result.book.readability)
            self.assertIsNone(summary_result.pages[0].readability)
            self.assertEqual(len(summary_result.submissions), 1)

            # Direct call omitting summary_only (FastAPI Query default object) unwraps to False -> runs readability
            mock_analyse.return_value = SimpleNamespace(
                to_dict=lambda: {
                    "syllable_count": 9,
                    "sentence_count": 1,
                    "avg_syllables_per_sentence": 9.0,
                    "complex_phonics_ratio": 0.1,
                    "multisyllable_ratio": 0.2,
                    "decodable_syllable_ratio": 0.9,
                    "estimated_grade_band": "GRADE_1",
                    "estimated_min_grade": 1,
                    "estimated_max_grade": 2,
                    "grade_match_status": "MATCHED",
                    "phonics_readiness_score": 92.0,
                }
            )
            full_result = await get_my_private_book(
                book_id=book_id,
                request=request,
                response=response,
                actor_id=actor_id,
                db=db,
            )
            self.assertEqual(mock_analyse.call_count, 2)
            self.assertIsNotNone(full_result.book.readability)
            self.assertIsNotNone(full_result.pages[0].readability)

    async def test_retry_failed_submissions_retries_all_failed_preserving_completed_stages(self) -> None:
        actor_id = uuid4()
        book_id = uuid4()
        book = self._make_book(actor_id, book_id)
        sub_ocr_fail = self._make_submission(
            actor_id,
            book_id,
            workflow_status="CHECK_FAILED",
            ocr_status="FAILED",
            proofread_status="PENDING",
            source_page=1,
        )
        sub_proofread_fail = self._make_submission(
            actor_id,
            book_id,
            workflow_status="CHECK_FAILED",
            ocr_status="COMPLETED",
            proofread_status="FAILED",
            source_page=2,
        )
        sub_ready = self._make_submission(
            actor_id,
            book_id,
            workflow_status="PASSED_READY_TO_ADD",
            ocr_status="COMPLETED",
            proofread_status="COMPLETED",
            tool_check_status="PASSED",
            source_page=3,
        )
        subs_by_id = {
            sub_ocr_fail.Id: sub_ocr_fail,
            sub_proofread_fail.Id: sub_proofread_fail,
            sub_ready.Id: sub_ready,
        }

        async def _get_owned_sub(_self, _bid, sid, _owner, *, lock=False):
            return subs_by_id.get(sid)

        db = MagicMock()
        response = Response()
        sync_mock = AsyncMock(return_value=[])
        dispatch_mock = MagicMock()

        with (
            patch.object(ParentPrivateBookService, "_require_parent", new=AsyncMock()),
            patch.object(ParentPrivateBookService, "_sync_remote_ocr_for_submissions", new=sync_mock),
            patch.object(ParentPrivateBookService, "_dispatch_post_ocr_if_ready", new=dispatch_mock),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.get_owned_private_book", new=AsyncMock(return_value=book)),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.list_submissions_for_book", new=AsyncMock(return_value=[sub_ocr_fail, sub_proofread_fail, sub_ready])),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.get_owned_submission", new=_get_owned_sub),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.commit", new=AsyncMock()),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.rollback", new=AsyncMock()),
        ):
            res = await retry_all_my_failed_submissions(
                book_id=book_id,
                response=response,
                actor_id=actor_id,
                db=db,
            )

        self.assertEqual(res["retried_count"], 2)
        self.assertEqual(res["skipped_count"], 0)
        self.assertEqual(res["failed_count"], 0)
        self.assertIsNone(res["queue_full_retry_after_seconds"])
        self.assertEqual(sub_ocr_fail.WorkflowStatus, "CHECKING")
        self.assertEqual(sub_ocr_fail.OcrStatus, "PENDING")
        # Stage 1 preserved for proofread-failed page
        self.assertEqual(sub_proofread_fail.WorkflowStatus, "CHECKING")
        self.assertEqual(sub_proofread_fail.OcrStatus, "COMPLETED")
        self.assertEqual(sub_proofread_fail.ProofreadStatus, "PENDING")
        # Ready page untouched
        self.assertEqual(sub_ready.WorkflowStatus, "PASSED_READY_TO_ADD")

    async def test_retry_failed_submissions_handles_429_ocr_queue_full_gracefully(self) -> None:
        actor_id = uuid4()
        book_id = uuid4()
        book = self._make_book(actor_id, book_id)
        sub1 = self._make_submission(actor_id, book_id, source_page=1)
        sub2 = self._make_submission(actor_id, book_id, source_page=2)
        sub3 = self._make_submission(actor_id, book_id, source_page=3)
        subs_by_id = {sub1.Id: sub1, sub2.Id: sub2, sub3.Id: sub3}

        async def _get_owned_sub(_self, _bid, sid, _owner, *, lock=False):
            return subs_by_id.get(sid)

        sync_calls = {"count": 0}

        async def _sync_with_429(_self, subs, *, reason=""):
            sync_calls["count"] += 1
            if sync_calls["count"] == 2:
                raise HTTPException(
                    status_code=429,
                    detail={
                        "code": "OCR_QUEUE_FULL",
                        "message": "Hàng chờ OCR đang đầy",
                        "retry_after_seconds": 45,
                        "queue_depth": 250,
                    },
                )
            return []

        db = MagicMock()
        response = Response()
        commit_mock = AsyncMock()
        rollback_mock = AsyncMock()

        with (
            patch.object(ParentPrivateBookService, "_require_parent", new=AsyncMock()),
            patch.object(ParentPrivateBookService, "_sync_remote_ocr_for_submissions", new=_sync_with_429),
            patch.object(ParentPrivateBookService, "_dispatch_post_ocr_if_ready", new=MagicMock()),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.get_owned_private_book", new=AsyncMock(return_value=book)),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.list_submissions_for_book", new=AsyncMock(return_value=[sub1, sub2, sub3])),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.get_owned_submission", new=_get_owned_sub),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.commit", new=commit_mock),
            patch("app.repositories.parent_private_book_repository.ParentPrivateBookRepository.rollback", new=rollback_mock),
        ):
            res = await retry_all_my_failed_submissions(
                book_id=book_id,
                response=response,
                actor_id=actor_id,
                db=db,
            )

        self.assertEqual(res["retried_count"], 1)
        self.assertEqual(res["skipped_count"], 2)
        self.assertEqual(res["failed_count"], 0)
        self.assertEqual(res["queue_full_retry_after_seconds"], 45)
        self.assertEqual(commit_mock.await_count, 1)
        self.assertEqual(rollback_mock.await_count, 1)


if __name__ == "__main__":
    unittest.main()
