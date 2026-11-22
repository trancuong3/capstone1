"""Fast unit regression tests for Wave 2 findings (AUD-004..AUD-009)."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import inspect
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:5432/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import Request

from app.jobs import book_quality_worker, viread_ocr_outbox_worker, viread_ocr_training_auto_worker
from app.repositories.admin_ai_workflow_repository import AdminAiWorkflowRepository
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.repositories.book_repository import CatalogRepository
from app.schemas.admin_ai_workflow import AdminAiImageSafetyDecision, AdminAiWorkflowCreate
from app.schemas.admin_ocr import AdminOcrWordInput
from app.services.admin_ai_workflow_service import AdminAiWorkflowService
from app.services.admin_ocr_chunking import ChunkingConfig
from app.services.admin_ocr_service import AdminOcrService
from app.services.ocr_ai.child_safety import ChildSafetyOrchestrator, SafetyProvider
from app.services.ocr_ai.config import LocalOcrConfig, OcrCorrectionConfig
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services import parent_private_book_pipeline, runtime_diagnostics


class AuditWave2OcrWorkersHealthAiTests(unittest.IsolatedAsyncioTestCase):
    async def test_aud004_reupload_revision_uses_candidate_image_and_by_input_snapshot_has_valid_column(
        self,
    ) -> None:
        # 1. AdminAiWorkflowRepository.by_input_snapshot(..., image_hash="...") must NOT raise AttributeError
        mock_db = MagicMock()
        mock_db.scalar = AsyncMock(return_value=None)
        repo = AdminAiWorkflowRepository(mock_db)
        await repo.by_input_snapshot(uuid4(), uuid4(), "hash123", image_hash="a" * 64)
        self.assertEqual(mock_db.scalar.await_count, 1)

        # 2. prepare_ai_correction(..., revision_id=...) must use revision.ProcessingMeta["source_image_path"]
        actor_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        page = SimpleNamespace(
            Id=page_id,
            BookId=uuid4(),
            ImagePath="books/b1/pages/p1/old_live.png",
            LifecycleStatus="ACTIVE",
        )
        revision = SimpleNamespace(
            Id=rev_id,
            PageId=page_id,
            VerificationStatus="NEEDS_REVIEW",
            OriginalOcrText="Mèo con",
            DraftText="Mèo con",
            VerifiedText=None,
            ProcessingMeta={
                "source_image_path": "books/b1/pages/p1/new_reuploaded.png",
                "source_image_sha256": "b" * 64,
            },
        )
        service = AdminOcrService(MagicMock())
        service.repo = MagicMock()
        service.repo.role = AsyncMock(return_value="admin")
        service.repo.page = AsyncMock(return_value=page)
        service.repo.revision = AsyncMock(return_value=revision)

        words = [
            AdminOcrWordInput(
                word_index=0,
                line_index=0,
                text="Mèo",
                normalized_text="mèo",
                bbox=[0.1, 0.1, 0.2, 0.05],
                ocr_confidence=0.95,
            ),
            AdminOcrWordInput(
                word_index=1,
                line_index=0,
                text="con",
                normalized_text="con",
                bbox=[0.35, 0.1, 0.2, 0.05],
                ocr_confidence=0.95,
            ),
        ]
        prepared = await service.prepare_ai_correction(
            actor_id, page_id, "Mèo con", words, revision_id=rev_id
        )
        self.assertEqual(prepared.image_path, "books/b1/pages/p1/new_reuploaded.png")

    def test_aud005_local_training_worker_claim_returns_profile_and_config_sha256_and_fences_updates(
        self,
    ) -> None:
        src = inspect.getsource(viread_ocr_training_auto_worker._claim_local_job)
        self.assertIn("job.profile", src)
        self.assertIn("job.config_sha256", src)
        sig = inspect.signature(viread_ocr_training_auto_worker._set_job)
        self.assertIn("worker_id", sig.parameters)

    async def test_aud006_book_quality_worker_handles_deleted_book_without_name_error_and_outbox_bounds_attempts(
        self,
    ) -> None:
        scan_id = uuid4()
        worker_id = "worker-bq-1"
        orphan_run = SimpleNamespace(
            Id=scan_id,
            BookId=None,
            Scope="BOOK",
            Status="RUNNING",
            WorkerId=worker_id,
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=5),
            ErrorSummary=None,
            CompletedAt=None,
        )

        mock_session = AsyncMock()
        mock_session_cm = MagicMock()
        mock_session_cm.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_cm.__aexit__ = AsyncMock(return_value=False)

        mock_repo = MagicMock()
        mock_repo.scan_run = AsyncMock(return_value=orphan_run)

        with (
            patch.object(book_quality_worker, "AsyncSessionLocal", return_value=mock_session_cm),
            patch.object(book_quality_worker, "BookContentQualityRepository", return_value=mock_repo),
        ):
            # Must NOT raise NameError: name '_mark_scan_unavailable' is not defined
            await book_quality_worker._process_claimed_scan(scan_id, worker_id)
            self.assertEqual(orphan_run.Status, "FAILED")
            self.assertIsNone(orphan_run.WorkerId)

        outbox_src = inspect.getsource(viread_ocr_outbox_worker._claim_one)
        self.assertIn("max_attempts", outbox_src.lower())

    async def test_aud007_image_safety_unsafe_flag_revokes_ocr_approval_and_blocks_catalog_sql(
        self,
    ) -> None:
        # 1. CatalogRepository.current_page_safety_approved SQL must block ADMIN_FLAGGED_UNSAFE
        from sqlalchemy.dialects import postgresql

        compiled = CatalogRepository.current_page_safety_approved().compile(
            dialect=postgresql.dialect()
        )
        self.assertIn("ADMIN_FLAGGED_UNSAFE", list(compiled.params.values()))

        # 2. BookContentQualityRepository.book_assessment_rows must bind workflow to CurrentVerifiedRevisionId when present
        bcq_src = inspect.getsource(BookContentQualityRepository.book_assessment_rows)
        self.assertIn("CurrentVerifiedRevisionId", bcq_src)

        # 3. decide_image_safety("ADMIN_FLAGGED_UNSAFE") must clear OcrApprovedAt so page is no longer eligible
        workflow_row = SimpleNamespace(
            Id=uuid4(),
            PageId=uuid4(),
            BookId=uuid4(),
            PageRevisionId=uuid4(),
            Status="READY_FOR_ADMIN_REVIEW",
            Stage="READY_FOR_ADMIN_REVIEW",
            CompletedChunks=1,
            TotalChunks=1,
            Attempts=1,
            ErrorCode=None,
            OriginalOcrHash="h1",
            AdminInputHash="h1",
            ProofreadText="Mèo con",
            ProofreadOutputHash="h1",
            CorrectionSuggestions=[],
            UncertainWordIndices=[],
            ProofreadMetadata={},
            SafetyMetadata={"all_chunks_completed": True},
            CandidateHistory=[],
            SafetyHistory=[],
            ReviewEvents=[],
            CandidateText="Mèo con",
            CandidateHash="h1",
            CandidateVersion=1,
            SafetyInputHash="h1",
            Suitability="SUITABLE",
            SafetyStatus="CONFIRMED",
            SafetyConfirmedAt=datetime.now(timezone.utc),
            SafetyConfirmedBy=uuid4(),
            ImageSafetyStatus="ADMIN_CONFIRMED_SAFE",
            ImageSafetyReviewedAt=None,
            ImageSafetyReviewedBy=None,
            ImageSafetyImageSha256="c" * 64,
            ImageSafetyReason=None,
            SourceImageSha256="c" * 64,
            Findings=[],
            ProviderEvents=[],
            OcrApprovedAt=datetime.now(timezone.utc),
            OcrApprovedBy=uuid4(),
            FinalApprovedTextHash="h1",
            CreatedAt=datetime.now(timezone.utc),
            UpdatedAt=datetime.now(timezone.utc),
        )
        mock_db = AsyncMock()
        wf_service = AdminAiWorkflowService(mock_db)
        wf_service.repo = MagicMock()
        wf_service.repo.get = AsyncMock(return_value=workflow_row)
        with (
            patch.object(AdminOcrService, "require_admin", new=AsyncMock(return_value=None)),
            patch("app.services.admin_ai_workflow_service.AdminOcrRepository") as mock_ocr_repo_cls,
        ):
            mock_ocr_repo_cls.return_value.revision = AsyncMock(
                return_value=SimpleNamespace(ProcessingMeta={"source_image_sha256": "c" * 64})
            )
            await wf_service.decide_image_safety(
                uuid4(),
                workflow_row.PageId,
                workflow_row.Id,
                AdminAiImageSafetyDecision(
                    status="ADMIN_FLAGGED_UNSAFE",
                    reason="Hình minh họa có chi tiết không phù hợp với trẻ nhỏ.",
                    expected_image_sha256="c" * 64,
                ),
            )
        self.assertIsNone(workflow_row.OcrApprovedAt)
        self.assertIsNone(workflow_row.OcrApprovedBy)

    async def test_aud008_cloud_timeout_disables_family_for_subsequent_chunks_and_preserves_local_budget(
        self,
    ) -> None:
        # 1. ChildSafetyOrchestrator disables cloud family after PROVIDER_TIMEOUT on chunk 0
        cfg = OcrCorrectionConfig(
            cloud_enabled=True,
            cloud_timeout_seconds=0.05,
            total_timeout_seconds=30.0,
            local=LocalOcrConfig(
                base_url="http://127.0.0.1:11434",
                model="qwen3-vl:4b-instruct-q4_K_M",
                timeout_seconds=10.0,
                chunking=ChunkingConfig(max_words=8),
            ),
        )
        cloud_calls = 0
        local_calls = 0

        safety_orch = ChildSafetyOrchestrator(config=cfg)
        safety_orch.providers = [
            SafetyProvider("gemini_cloud", "gemini-2.5-flash", "google"),
            SafetyProvider("ollama_local", "qwen3-vl:4b-instruct-q4_K_M", "ollama"),
        ]

        async def fake_request(provider: SafetyProvider, _source: str):
            nonlocal cloud_calls, local_calls
            if provider.family == "google":
                cloud_calls += 1
                await asyncio.sleep(0.2)
            local_calls += 1
            return ({"suitability": "SUITABLE", "findings": []}, 200, "json_schema", 0)

        safety_orch._request = fake_request  # type: ignore[method-assign]
        res = await safety_orch.analyze("một hai ba bốn năm sáu " * 550)
        self.assertEqual(res["suitability"], "SUITABLE")
        # Cloud timed out on chunk 0 -> must be disabled on chunk 1 (cloud_calls == 1, NOT 2!)
        self.assertEqual(cloud_calls, 1)
        self.assertGreaterEqual(local_calls, 2)

        # 2. OcrCorrectionOrchestrator._cloud_attempt_timeout reserves full local.timeout_seconds when total allows
        tight_cfg = OcrCorrectionConfig(
            cloud_enabled=True,
            cloud_timeout_seconds=60.0,
            total_timeout_seconds=200.0,
            local=LocalOcrConfig(
                base_url="http://127.0.0.1:11434",
                model="qwen3-vl:4b-instruct-q4_K_M",
                timeout_seconds=180.0,
            ),
        )
        cloud_prov = SimpleNamespace(name="gemini_flash", family="gemini")
        local_prov = SimpleNamespace(name="ollama_qwen", family="ollama")
        corr_orch = OcrCorrectionOrchestrator(config=tight_cfg, providers=[cloud_prov, local_prov])  # type: ignore[arg-type]
        import time as _time

        deadline = _time.monotonic() + 200.0
        allowed_cloud = corr_orch._cloud_attempt_timeout(
            provider=cloud_prov,  # type: ignore[arg-type]
            disabled_families=set(),
            deadline=deadline,
        )
        assert allowed_cloud is not None
        # With 200s total and 180s local timeout, cloud cannot be given > 20s!
        self.assertLessEqual(allowed_cloud, 20.5)

    async def test_aud009_health_reports_failed_ocr_init_accurately_and_lists_all_workers(
        self,
    ) -> None:
        fake_ocr_mod = SimpleNamespace(
            _paddle_engine=None,
            _paddle_initialization_status="not_initialized",
            _paddle_initialization_error="RuntimeError",
            _paddle_import_error="ImportError",
            _vietocr_engine=None,
            _vietocr_initialization_status="not_initialized",
            _vietocr_initialization_error="RuntimeError",
            _vietocr_import_error=None,
        )
        with (
            patch.dict("sys.modules", {"app.services.ocr_engine": fake_ocr_mod}),
            patch.object(runtime_diagnostics, "_package_installed", return_value=True),
        ):
            item = runtime_diagnostics._ocr_engine_health(
                "paddleocr", "_paddle_engine", "_paddle_initialization_status", "PaddleOCR"
            )
            self.assertEqual(item["status"], "UNAVAILABLE")
            self.assertEqual(item["detail_status"], "failed")

        self.assertIn("parent_book_submission", runtime_diagnostics._WORKER_LABELS)
        self.assertIn("admin_ai_workflow", runtime_diagnostics._WORKER_LABELS)

        stale_sig = inspect.signature(parent_private_book_pipeline._is_stale)
        self.assertIn("expected_worker_id", stale_sig.parameters)
