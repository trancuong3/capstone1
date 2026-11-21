"""Proofreading and Child Safety overlap on one immutable OCR snapshot."""
from __future__ import annotations

import asyncio
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.jobs import admin_ai_workflow_worker as worker


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def commit(self):
        return None

    async def rollback(self):
        return None


class _Repository:
    row = None
    released = []

    def __init__(self, _session):
        pass

    async def get(self, _workflow_id, lock=False):
        return self.row

    async def release_claim(self, workflow_id, worker_id):
        self.released.append((workflow_id, worker_id))
        return True


class ParallelWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_stage_releases_its_durable_claim(self):
        workflow_id = uuid4()
        _Repository.released = []
        snapshot = {"id": workflow_id, "worker_id": "worker-shutdown", "stage": "PROOFREADING"}
        started = asyncio.Event()

        async def wait_for_shutdown(*_args):
            started.set()
            await asyncio.Event().wait()

        with (
            patch.object(worker, "_load", new=AsyncMock(return_value=snapshot)),
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _Repository),
            patch.object(worker, "_run_proofreading", side_effect=wait_for_shutdown),
        ):
            task = asyncio.create_task(worker._process(workflow_id, "worker-shutdown"))
            try:
                await asyncio.wait_for(started.wait(), timeout=2)
            except Exception:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertEqual(_Repository.released, [(workflow_id, "worker-shutdown")])

    async def test_worker_shutdown_cancels_active_workflow_tasks(self):
        workflow_id = uuid4()
        started = asyncio.Event()
        cancelled = asyncio.Event()

        class _QueueRepository:
            claims = 0

            def __init__(self, _session):
                pass

            async def claim_next(self, _worker_id, lease_seconds):
                type(self).claims += 1
                return workflow_id if type(self).claims == 1 else None

        async def active_workflow(*_args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with (
            patch.object(worker, "_configured_enabled", return_value=True),
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _QueueRepository),
            patch.object(worker, "_process", side_effect=active_workflow),
        ):
            task = asyncio.create_task(worker.run_worker(poll_seconds=1))
            try:
                await asyncio.wait_for(started.wait(), timeout=2)
            except Exception:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertTrue(cancelled.is_set())

    async def test_safety_starts_before_proofreading_finishes_and_stale_hash_is_requeued(self):
        workflow_id = uuid4()
        row = SimpleNamespace(
            Id=workflow_id,
            WorkerId="worker-1",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=20),
            ProviderEvents=[],
            ReviewEvents=[],
            SafetyHistory=[],
            SafetyMetadata={},
            Findings=[],
            CandidateHistory=[],
            CorrectionSuggestions=[],
            UncertainWordIndices=[],
            ProofreadMetadata={},
            CandidateVersion=0,
            SafetyInputHash=None,
            SafetyStatus="PENDING",
            Suitability=None,
            Stage="PROOFREADING",
            Status="PROOFREADING",
            Attempts=1,
        )
        _Repository.row = row
        safety_started = asyncio.Event()
        proofreading_waited_for_safety = asyncio.Event()

        async def correct(*_args, **_kwargs):
            await safety_started.wait()
            proofreading_waited_for_safety.set()
            return "corrected text"

        class _Safety:
            async def analyze(self, value):
                self.input_text = value
                safety_started.set()
                await proofreading_waited_for_safety.wait()
                return {
                    "suitability": "REVIEW_REQUIRED",
                    "findings": [{"evidence_text": "original text"}],
                    "provider_events": [],
                }

        snapshot = {
            "id": workflow_id,
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "input_text": "original text",
            "input_words": [{"bbox": [0.1, 0.1, 0.2, 0.1]}],
            "image_path": "books/test/page.png",
            "stage": "PROOFREADING",
            "total_chunks": 1,
            "candidate_text": None,
            "candidate_hash": None,
            "safety_input_hash": None,
            "safety_status": "PENDING",
            "worker_id": "worker-1",
            "attempts": 1,
            "provider_events": [],
        }
        with (
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _Repository),
            patch.object(worker, "_progress_loop", new=AsyncMockProgress()),
            patch.object(worker.OcrCorrectionConfig, "from_environment", return_value=object()),
            patch.object(worker.AdminOcrService, "run_prepared_ai_correction", side_effect=correct),
            patch.object(worker, "build_child_safety_orchestrator", return_value=_Safety()),
        ):
            await worker._run_proofreading(snapshot, "worker-1")

        self.assertTrue(proofreading_waited_for_safety.is_set())
        self.assertEqual(row.CandidateText, "corrected text")
        self.assertEqual(row.Stage, "CHILD_SAFETY_SCANNING")
        self.assertEqual(row.Status, "QUEUED")
        self.assertEqual(row.SafetyStatus, "STALE")
        self.assertIsNone(row.SafetyInputHash)
        self.assertEqual(row.Findings, [])
        self.assertEqual(row.SafetyHistory[0]["content_hash"], worker.content_hash("original text"))

    async def test_safety_failure_keeps_successful_proofreading_and_retries_only_safety(self):
        workflow_id = uuid4()
        row = SimpleNamespace(
            Id=workflow_id,
            WorkerId="worker-2",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=20),
            ProviderEvents=[],
            ReviewEvents=[],
            SafetyHistory=[],
            SafetyMetadata={},
            Findings=[],
            CandidateHistory=[],
            CorrectionSuggestions=[],
            UncertainWordIndices=[],
            ProofreadMetadata={},
            CandidateVersion=0,
            SafetyInputHash=None,
            SafetyStatus="PENDING",
            Suitability=None,
            Stage="PROOFREADING",
            Status="PROOFREADING",
            Attempts=1,
            ErrorCode=None,
        )
        _Repository.row = row

        class _Safety:
            async def analyze(self, _value):
                raise worker.ChildSafetyError("ALL_PROVIDERS_FAILED", [])

        async def correct(*_args, **_kwargs):
            return "same text"

        snapshot = {
            "id": workflow_id,
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "input_text": "same text",
            "input_words": [{"bbox": [0.1, 0.1, 0.2, 0.1]}],
            "image_path": "books/test/page.png",
            "stage": "PROOFREADING",
            "total_chunks": 1,
            "candidate_text": None,
            "candidate_hash": None,
            "safety_input_hash": None,
            "safety_status": "PENDING",
            "worker_id": "worker-2",
            "attempts": 1,
            "provider_events": [],
        }
        with (
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _Repository),
            patch.object(worker, "_progress_loop", new=AsyncMockProgress()),
            patch.object(worker.OcrCorrectionConfig, "from_environment", return_value=object()),
            patch.object(worker.AdminOcrService, "run_prepared_ai_correction", side_effect=correct),
            patch.object(worker, "build_child_safety_orchestrator", return_value=_Safety()),
        ):
            await worker._run_proofreading(snapshot, "worker-2")

        self.assertEqual(row.ProofreadText, "same text")
        self.assertEqual(row.CandidateText, "same text")
        self.assertEqual(row.Stage, "CHILD_SAFETY_SCANNING")
        self.assertEqual(row.Status, "QUEUED")
        self.assertEqual(row.SafetyStatus, "FAILED")
        self.assertEqual(row.ErrorCode, "ALL_PROVIDERS_FAILED")
        self.assertEqual(row.ReviewEvents[-1]["stage"], "CHILD_SAFETY_SCANNING")

    async def test_proofreading_retry_does_not_call_child_safety_when_text_is_unchanged(self):
        workflow_id = uuid4()
        row = SimpleNamespace(
            Id=workflow_id,
            WorkerId="worker-proofread-retry",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=20),
            ProviderEvents=[],
            ReviewEvents=[{
                "event": "WORKFLOW_STAGE_RETRY_QUEUED",
                "stage": "PROOFREADING",
            }],
            SafetyHistory=[],
            SafetyMetadata={},
            Findings=[],
            CandidateHistory=[],
            CorrectionSuggestions=[],
            UncertainWordIndices=[],
            ProofreadMetadata={},
            CandidateVersion=0,
            SafetyInputHash=None,
            SafetyStatus="FAILED",
            Suitability=None,
            Stage="PROOFREADING",
            Status="PROOFREADING",
            Attempts=1,
            ErrorCode=None,
        )
        _Repository.row = row

        async def correct(*_args, **_kwargs):
            return "same text"

        snapshot = {
            "id": workflow_id,
            "page_id": uuid4(),
            "revision_id": uuid4(),
            "input_text": "same text",
            "input_words": [{"bbox": [0.1, 0.1, 0.2, 0.1]}],
            "image_path": "books/test/page.png",
            "stage": "PROOFREADING",
            "total_chunks": 1,
            "candidate_text": None,
            "candidate_hash": None,
            "safety_input_hash": None,
            "safety_status": "FAILED",
            "worker_id": "worker-proofread-retry",
            "attempts": 1,
            "provider_events": [],
            "review_events": row.ReviewEvents,
        }
        with (
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _Repository),
            patch.object(worker, "_progress_loop", new=AsyncMockProgress()),
            patch.object(worker.OcrCorrectionConfig, "from_environment", return_value=object()),
            patch.object(worker.AdminOcrService, "run_prepared_ai_correction", side_effect=correct),
            patch.object(worker, "build_child_safety_orchestrator") as safety_builder,
            patch.object(worker, "_try_auto_publish", new=AsyncMock()),
        ):
            await worker._run_proofreading(snapshot, "worker-proofread-retry")

        safety_builder.assert_not_called()
        self.assertEqual(row.CandidateText, "same text")
        self.assertEqual(row.Status, "READY_FOR_ADMIN_REVIEW")
        self.assertEqual(row.SafetyStatus, "FAILED")

    async def test_child_safety_stage_does_not_run_proofreading_or_ocr(self):
        workflow_id = uuid4()
        page_revision_id = uuid4()
        candidate = "verified candidate"
        row = SimpleNamespace(
            Id=workflow_id,
            PageRevisionId=page_revision_id,
            WorkerId="worker-safety-retry",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=20),
            ProviderEvents=[],
            ReviewEvents=[],
            SafetyHistory=[],
            SafetyMetadata={},
            Findings=[],
            CandidateText=candidate,
            CandidateHash=worker.content_hash(candidate),
            SafetyInputHash=None,
            SafetyStatus="STALE",
            Suitability=None,
            Status="CHILD_SAFETY_SCANNING",
            Stage="CHILD_SAFETY_SCANNING",
            CompletedChunks=0,
            TotalChunks=1,
            Attempts=1,
            ErrorCode=None,
        )
        _Repository.row = row

        class _Safety:
            async def analyze(self, _value):
                return {
                    "suitability": "SUITABLE",
                    "findings": [],
                    "provider_events": [],
                }

        snapshot = {
            "id": workflow_id,
            "book_id": uuid4(),
            "candidate_text": candidate,
        }
        with (
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _Repository),
            patch.object(worker, "_progress_loop", new=AsyncMockProgress()),
            patch.object(worker, "build_child_safety_orchestrator", return_value=_Safety()),
            patch.object(worker.AdminOcrService, "run_prepared_ai_correction", new=AsyncMock()) as proofreader,
            patch.object(worker, "_try_auto_publish", new=AsyncMock()),
        ):
            await worker._run_safety(snapshot, "worker-safety-retry")

        proofreader.assert_not_awaited()
        self.assertEqual(row.PageRevisionId, page_revision_id)
        self.assertEqual(row.CandidateText, candidate)
        self.assertEqual(row.Status, "READY_FOR_ADMIN_REVIEW")
        self.assertEqual(row.SafetyStatus, "PROVISIONAL")
        self.assertEqual(row.SafetyMetadata.get("image_safety_status"), "UNASSESSED_NO_VISION_MODEL")
        self.assertTrue(row.SafetyMetadata.get("all_chunks_completed"))

    async def test_stale_worker_after_lease_expiry_cannot_overwrite_workflow(self):
        workflow_id = uuid4()
        candidate = "Nội dung đang chờ quét"
        row = SimpleNamespace(
            Id=workflow_id,
            PageRevisionId=uuid4(),
            WorkerId="worker-new",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=20),
            ProviderEvents=[],
            ReviewEvents=[],
            SafetyHistory=[],
            SafetyMetadata={},
            Findings=[],
            CandidateText=candidate,
            CandidateHash=worker.content_hash(candidate),
            SafetyInputHash=None,
            SafetyStatus="STALE",
            Suitability=None,
            Status="CHILD_SAFETY_SCANNING",
            Stage="CHILD_SAFETY_SCANNING",
            CompletedChunks=0,
            TotalChunks=1,
            Attempts=2,
            ErrorCode=None,
        )
        _Repository.row = row

        class _Safety:
            async def analyze(self, _value):
                return {
                    "suitability": "SUITABLE",
                    "findings": [],
                    "provider_events": [],
                    "chunks_total": 1,
                    "chunks_completed": 1,
                    "all_chunks_completed": True,
                    "text_safety_status": "PROVISIONAL",
                    "image_safety_status": "UNASSESSED_NO_VISION_MODEL",
                }

        snapshot = {
            "id": workflow_id,
            "candidate_text": candidate,
        }
        with (
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _Repository),
            patch.object(worker, "_progress_loop", new=AsyncMockProgress()),
            patch.object(worker, "build_child_safety_orchestrator", return_value=_Safety()),
        ):
            await worker._run_safety(snapshot, "worker-stale")

        self.assertEqual(row.SafetyStatus, "STALE")
        self.assertIsNone(row.SafetyInputHash)
        self.assertEqual(row.WorkerId, "worker-new")

    async def test_worker_never_auto_publishes_books(self):
        workflow_id = uuid4()
        candidate = "Nội dung sạch đã kiểm tra"
        row = SimpleNamespace(
            Id=workflow_id,
            PageRevisionId=uuid4(),
            WorkerId="worker-clean",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=20),
            ProviderEvents=[],
            ReviewEvents=[],
            SafetyHistory=[],
            SafetyMetadata={},
            Findings=[],
            CandidateText=candidate,
            CandidateHash=worker.content_hash(candidate),
            SafetyInputHash=None,
            SafetyStatus="STALE",
            Suitability=None,
            Status="CHILD_SAFETY_SCANNING",
            Stage="CHILD_SAFETY_SCANNING",
            CompletedChunks=0,
            TotalChunks=1,
            Attempts=1,
            ErrorCode=None,
        )
        _Repository.row = row

        class _Safety:
            async def analyze(self, _value):
                return {
                    "suitability": "SUITABLE",
                    "findings": [],
                    "provider_events": [],
                    "chunks_total": 1,
                    "chunks_completed": 1,
                    "all_chunks_completed": True,
                    "text_safety_status": "PROVISIONAL",
                    "image_safety_status": "UNASSESSED_NO_VISION_MODEL",
                }

        snapshot = {
            "id": workflow_id,
            "book_id": uuid4(),
            "candidate_text": candidate,
        }
        with (
            patch.object(worker, "AsyncSessionLocal", _Session),
            patch.object(worker, "AdminAiWorkflowRepository", _Repository),
            patch.object(worker, "_progress_loop", new=AsyncMockProgress()),
            patch.object(worker, "build_child_safety_orchestrator", return_value=_Safety()),
            patch.object(
                worker.BookContentQualityService,
                "auto_publish_if_eligible",
                new=AsyncMock(),
            ) as auto_pub,
        ):
            await worker._run_safety(snapshot, "worker-clean")

        auto_pub.assert_not_called()
        self.assertEqual(row.Status, "READY_FOR_ADMIN_REVIEW")
        self.assertEqual(row.SafetyStatus, "PROVISIONAL")


class AsyncMockProgress:
    async def __call__(self, *_args):
        return None


if __name__ == "__main__":
    unittest.main()
