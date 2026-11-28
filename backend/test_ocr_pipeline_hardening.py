from __future__ import annotations

import asyncio
import hashlib
import io
import os
import tracemalloc
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import UploadFile
from PIL import Image, ImageDraw
from sqlalchemy.exc import IntegrityError

from app.models import (
    Book,
    BookPage,
    OcrInferenceJob,
    OcrWorkerHeartbeat,
    ParentBookPageSubmission,
)
from app.services.admin_ocr_service import AdminOcrService
from app.services.document_rasterizer_service import (
    iter_rasterized_spooled_document,
    spool_upload_file,
)
from app.services.local_ocr_scan_service import cleanup_expired_local_scan_objects
from app.services.ocr_ai.child_safety import ChildSafetyOrchestrator
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError, OcrOrchestrationError
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services.parent_private_book_service import _build_scope
from app.services.ocr_inference_job_service import (
    JOB_KIND_ADMIN_UPLOAD,
    JOB_KIND_LOCAL_SCAN,
    JOB_KIND_PARENT_SUBMISSION,
    PRIORITY_ADMIN_OCR,
    PRIORITY_LOCAL_SCAN,
    PRIORITY_PARENT_SUBMISSION,
    OcrInferenceJobService,
    _valid_bbox,
    align_edited_text_to_words,
    build_proofread_suggestions,
    compute_candidate_hash,
    reconcile_orphaned_parent_submissions,
    run_parent_submission_post_ocr,
)
from test_ocr_inference_jobs import (
    FakeAsyncSession,
    InMemoryDbState,
    _DummySessionCtx,
)


def _make_png_bytes(width: int = 320, height: int = 180) -> bytes:
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((20, 40), "Xin chao", fill=(10, 10, 10))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_multipage_pdf_bytes(num_pages: int = 20) -> bytes:
    import pymupdf  # type: ignore[import-not-found]

    doc = pymupdf.open()
    try:
        for i in range(1, num_pages + 1):
            page = doc.new_page(width=595, height=842)
            page.insert_text((72, 100), f"Trang {i}: Truyen co tich thieu nhi Viet Nam", fontsize=14)
        return doc.tobytes()
    finally:
        doc.close()


def _make_multipage_docx_bytes(num_pages: int = 12) -> bytes:
    import docx  # type: ignore[import-not-found]

    doc = docx.Document()
    for i in range(1, num_pages + 1):
        if i > 1:
            doc.add_page_break()
        doc.add_heading(f"Chương {i}: Ánh nắng bình minh", level=1)
        doc.add_paragraph("– Chào buổi sáng! Chú mèo nhỏ đang đọc sách tiếng Việt có đủ dấu ă â đ ê ô ơ ư.")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


class TestOcrPipelineHardening(unittest.TestCase):
    def setUp(self) -> None:
        self.state = InMemoryDbState()
        self.db = FakeAsyncSession(self.state)
        self.admin_id = uuid4()
        self.parent_id = uuid4()
        self.state.roles[self.admin_id] = "admin"
        self.state.roles[self.parent_id] = "parent"
        self._signed_url_patcher = patch(
            "app.services.ocr_inference_job_service.storage_service.create_signed_image_url",
            return_value="https://signed.example/mock-source.png",
        )
        self._signed_url_patcher.start()
        self.addCleanup(self._signed_url_patcher.stop)

    def _svc(self) -> OcrInferenceJobService:
        return OcrInferenceJobService(self.db)  # type: ignore[arg-type]

    def test_heartbeat_job_refreshes_worker_heartbeat_beyond_ttl_and_marks_busy_then_idle(self):
        async def _scenario() -> None:
            svc = self._svc()
            img_sha = hashlib.sha256(b"long-cpu-page").hexdigest()
            worker_id = "win-ocr-stable-host"

            # Worker sends initial IDLE heartbeat, then ages past 75s TTL while running a job.
            hb = await svc.record_worker_heartbeat(
                worker_id=worker_id,
                hostname="WIN-HOST",
                app_version="1.0.0",
                git_sha="86c390cf",
                status_value="IDLE",
                active_job_id=None,
                active_job_count=0,
                concurrency_limit=1,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engines={"paddleocr": {"status": "HEALTHY", "inference_verified": True}},
                system_stats={"ram_total_mb": 16384},
                last_error=None,
            )
            hb.LastHeartbeatAt = datetime.now(timezone.utc) - timedelta(seconds=90)
            self.assertFalse(await svc.has_online_worker())

            job = await svc.enqueue_job(
                job_kind=JOB_KIND_LOCAL_SCAN,
                owner_user_id=self.parent_id,
                image_path="local-scans/long.jpg",
                image_sha256=img_sha,
                priority=PRIORITY_LOCAL_SCAN,
            )
            await self.db.commit()
            claimed = await svc.claim_next_job(worker_id=worker_id, lease_seconds=120)
            assert claimed is not None

            # Mid-job lease heartbeat MUST refresh ocr_worker_heartbeats and preserve engine metadata.
            await svc.heartbeat_job(
                job_id=job.Id,
                worker_id=worker_id,
                fencing_token=int(claimed["fencing_token"]),
                lease_seconds=120,
                phase="ocr_running",
            )
            self.assertTrue(await svc.has_online_worker())
            self.assertEqual(hb.Status, "BUSY")
            self.assertEqual(hb.ActiveJobId, job.Id)
            self.assertEqual(hb.ActiveJobCount, 1)
            self.assertEqual(hb.Hostname, "WIN-HOST")
            self.assertIn("paddleocr", hb.Engines)

            # Completing the job flips worker heartbeat back to IDLE immediately.
            await svc.complete_job(
                job_id=job.Id,
                worker_id=worker_id,
                fencing_token=int(claimed["fencing_token"]),
                source_sha256=img_sha,
                full_text="Xin chào",
                words=[
                    {"word_index": 0, "line_index": 0, "text": "Xin", "bbox": [0.1, 0.1, 0.15, 0.05]},
                    {"word_index": 1, "line_index": 0, "text": "chào", "bbox": [0.28, 0.1, 0.18, 0.05]},
                ],
                ocr_meta={},
                no_text_detected=False,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engine_diagnostics={},
                duration_ms=52000,
                schedule_post_ocr=False,
            )
            self.assertEqual(hb.Status, "IDLE")
            self.assertIsNone(hb.ActiveJobId)
            self.assertEqual(hb.ActiveJobCount, 0)

        asyncio.run(_scenario())

    def test_reap_expired_leases_standalone_reclaims_and_propagates_dead_letter(self):
        async def _scenario() -> None:
            svc = self._svc()
            now = datetime.now(timezone.utc)
            sha1 = "1" * 64
            sha2 = "2" * 64

            sub_retry = ParentBookPageSubmission(
                Id=uuid4(),
                BookId=uuid4(),
                OwnerParentId=self.parent_id,
                BatchId=uuid4(),
                BatchTotalPages=1,
                SourcePageNumber=1,
                SourceStoragePath="private/s1.png",
                SourceSha256=sha1,
                ImageWidth=800,
                ImageHeight=1000,
                WorkflowStatus="CHECKING",
                OcrStatus="RUNNING",
                ProofreadStatus="PENDING",
                ToolCheckStatus="PENDING",
                SubmissionVersion=1,
                OptimisticLockVersion=1,
                TempExpiresAt=now + timedelta(days=1),
            )
            sub_dead = ParentBookPageSubmission(
                Id=uuid4(),
                BookId=uuid4(),
                OwnerParentId=self.parent_id,
                BatchId=uuid4(),
                BatchTotalPages=1,
                SourcePageNumber=2,
                SourceStoragePath="private/s2.png",
                SourceSha256=sha2,
                ImageWidth=800,
                ImageHeight=1000,
                WorkflowStatus="CHECKING",
                OcrStatus="RUNNING",
                ProofreadStatus="PENDING",
                ToolCheckStatus="PENDING",
                SubmissionVersion=1,
                OptimisticLockVersion=1,
                TempExpiresAt=now + timedelta(days=1),
            )
            self.state.tables[ParentBookPageSubmission].extend([sub_retry, sub_dead])

            job_retry = OcrInferenceJob(
                Id=uuid4(),
                JobKind=JOB_KIND_PARENT_SUBMISSION,
                Status="RUNNING",
                Priority=PRIORITY_PARENT_SUBMISSION,
                OwnerUserId=self.parent_id,
                BookId=sub_retry.BookId,
                SubmissionId=sub_retry.Id,
                ImagePath=sub_retry.SourceStoragePath,
                ImageSha256=sha1,
                ExpectedVersion=1,
                WorkerId="dead-worker",
                FencingToken=1,
                AttemptCount=1,
                MaxAttempts=3,
                LeaseExpiresAt=now - timedelta(seconds=30),
                CreatedAt=now - timedelta(minutes=3),
                UpdatedAt=now - timedelta(minutes=3),
            )
            job_dead = OcrInferenceJob(
                Id=uuid4(),
                JobKind=JOB_KIND_PARENT_SUBMISSION,
                Status="RUNNING",
                Priority=PRIORITY_PARENT_SUBMISSION,
                OwnerUserId=self.parent_id,
                BookId=sub_dead.BookId,
                SubmissionId=sub_dead.Id,
                ImagePath=sub_dead.SourceStoragePath,
                ImageSha256=sha2,
                ExpectedVersion=1,
                WorkerId="dead-worker",
                FencingToken=3,
                AttemptCount=3,
                MaxAttempts=3,
                LeaseExpiresAt=now - timedelta(seconds=30),
                CreatedAt=now - timedelta(minutes=10),
                UpdatedAt=now - timedelta(minutes=10),
            )
            self.state.tables[OcrInferenceJob].extend([job_retry, job_dead])

            # Standalone reaper runs with NO worker calling claim_next_job!
            summary = await svc.reap_expired_leases(now=now)
            self.assertEqual(summary, {"reclaimed": 1, "dead_lettered": 1})
            self.assertEqual(job_retry.Status, "FAILED_RETRYABLE")
            self.assertEqual(sub_retry.OcrStatus, "PENDING")
            self.assertEqual(job_dead.Status, "DEAD_LETTER")
            self.assertEqual(sub_dead.WorkflowStatus, "CHECK_FAILED")
            self.assertEqual(sub_dead.OcrErrorCode, "LEASE_EXPIRED_MAX_ATTEMPTS")

        asyncio.run(_scenario())

    def test_prune_stale_worker_heartbeats_and_list_filters_old_rows(self):
        async def _scenario() -> None:
            svc = self._svc()
            now = datetime.now(timezone.utc)
            fresh = OcrWorkerHeartbeat(
                WorkerId="w-fresh",
                Status="IDLE",
                LastHeartbeatAt=now - timedelta(seconds=10),
                CreatedAt=now,
                UpdatedAt=now,
            )
            stale = OcrWorkerHeartbeat(
                WorkerId="w-stale",
                Status="OFFLINE",
                LastHeartbeatAt=now - timedelta(hours=30),
                CreatedAt=now - timedelta(hours=30),
                UpdatedAt=now - timedelta(hours=30),
            )
            self.state.tables[OcrWorkerHeartbeat].extend([fresh, stale])

            listed = await svc.repo.list_worker_heartbeats(max_age_hours=24, now=now)
            self.assertEqual([w.WorkerId for w in listed], ["w-fresh"])

            pruned = await svc.prune_stale_worker_heartbeats(max_age_hours=24, now=now)
            self.assertEqual(pruned, 1)
            self.assertEqual([w.WorkerId for w in self.state.tables[OcrWorkerHeartbeat]], ["w-fresh"])

        asyncio.run(_scenario())

    def test_age_based_priority_boost_prevents_parent_submission_starvation(self):
        async def _scenario() -> None:
            svc = self._svc()
            now = datetime.now(timezone.utc)
            old_parent = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=self.parent_id,
                submission_id=uuid4(),
                image_path="p/old.png",
                image_sha256="a" * 64,
                priority=PRIORITY_PARENT_SUBMISSION,
            )
            old_parent.CreatedAt = now - timedelta(minutes=6)
            fresh_scan = await svc.enqueue_job(
                job_kind=JOB_KIND_LOCAL_SCAN,
                owner_user_id=self.parent_id,
                image_path="local-scans/new.jpg",
                image_sha256="b" * 64,
                priority=PRIORITY_LOCAL_SCAN,
            )
            await self.db.commit()

            claimed = await svc.claim_next_job(worker_id="w1")
            assert claimed is not None
            self.assertEqual(claimed["job_id"], str(old_parent.Id))
            self.assertLess(old_parent.Priority, fresh_scan.Priority)

        asyncio.run(_scenario())

    def test_parent_post_ocr_dialogue_dash_and_vietnamese_diacritics_no_word_box_mismatch(self):
        async def _scenario() -> None:
            now = datetime.now(timezone.utc)
            img_bytes = _make_png_bytes()
            img_sha = hashlib.sha256(img_bytes).hexdigest()
            # Vietnamese text with standalone dialogue dashes '–', '—', '...', and full diacritics + 6 tones.
            ocr_text = "– Mẹ ơi, ăng-ten ở đâu?\n— Ở đây mà, má mả mã mạ, đi ăn cơm ướt nhé ..."
            ocr_words = [
                {"word_index": 0, "line_index": 0, "text": "Mẹ", "bbox": [0.1, 0.1, 0.08, 0.05]},
                {"word_index": 1, "line_index": 0, "text": "ơi,", "bbox": [0.2, 0.1, 0.08, 0.05]},
                {"word_index": 2, "line_index": 0, "text": "ăng-ten", "bbox": [0.3, 0.1, 0.14, 0.05]},
                {"word_index": 3, "line_index": 0, "text": "ở", "bbox": [0.46, 0.1, 0.05, 0.05]},
                {"word_index": 4, "line_index": 0, "text": "đâu?", "bbox": [0.53, 0.1, 0.1, 0.05]},
                {"word_index": 5, "line_index": 1, "text": "Ở", "bbox": [0.1, 0.2, 0.06, 0.05]},
                {"word_index": 6, "line_index": 1, "text": "đây", "bbox": [0.18, 0.2, 0.08, 0.05]},
                {"word_index": 7, "line_index": 1, "text": "mà,", "bbox": [0.28, 0.2, 0.08, 0.05]},
                {"word_index": 8, "line_index": 1, "text": "má", "bbox": [0.38, 0.2, 0.07, 0.05]},
                {"word_index": 9, "line_index": 1, "text": "mả", "bbox": [0.47, 0.2, 0.07, 0.05]},
                {"word_index": 10, "line_index": 1, "text": "mã", "bbox": [0.56, 0.2, 0.07, 0.05]},
                {"word_index": 11, "line_index": 1, "text": "mạ,", "bbox": [0.65, 0.2, 0.07, 0.05]},
                {"word_index": 12, "line_index": 1, "text": "đi", "bbox": [0.74, 0.2, 0.05, 0.05]},
                {"word_index": 13, "line_index": 1, "text": "ăn", "bbox": [0.80, 0.2, 0.05, 0.05]},
                {"word_index": 14, "line_index": 1, "text": "cơm", "bbox": [0.1, 0.3, 0.09, 0.05]},
                {"word_index": 15, "line_index": 1, "text": "ướt", "bbox": [0.21, 0.3, 0.09, 0.05]},
                {"word_index": 16, "line_index": 1, "text": "nhé", "bbox": [0.32, 0.3, 0.09, 0.05]},
            ]
            sub = ParentBookPageSubmission(
                Id=uuid4(),
                BookId=uuid4(),
                OwnerParentId=self.parent_id,
                BatchId=uuid4(),
                BatchTotalPages=1,
                SourcePageNumber=1,
                SourceStoragePath="private/dialogue.png",
                SourceSha256=img_sha,
                ImageWidth=320,
                ImageHeight=180,
                SourceType="SELF_AUTHORED",
                WorkflowStatus="CHECKING",
                OcrStatus="COMPLETED",
                OcrText=ocr_text,
                OcrWordsJson=ocr_words,
                ProofreadStatus="PENDING",
                ToolCheckStatus="PENDING",
                CandidateText=ocr_text,
                CandidateWordsJson=ocr_words,
                CandidateHash=compute_candidate_hash(ocr_text, source_sha256=img_sha),
                SubmissionVersion=1,
                OptimisticLockVersion=1,
                TempExpiresAt=now + timedelta(days=1),
            )
            self.state.tables[ParentBookPageSubmission].append(sub)

            class _PassthroughProvider:
                name = "mock_cloud"
                family = "mock"
                model = "mock-v1"

                async def correct_chunk(self, *, chunk, image_bytes, image_mime_type):
                    from app.services.ocr_ai.schemas import ChunkCorrectionResult

                    return ChunkCorrectionResult(
                        chunk_id=chunk.chunk_id,
                        corrected_words=tuple(t.text for t in chunk.tokens),
                        uncertain_word_indices=(),
                    )

            orch = OcrCorrectionOrchestrator(
                OcrCorrectionConfig(cloud_enabled=False, local_enabled=True),
                providers=[_PassthroughProvider()],
            )

            class _SafeRunner:
                async def analyze(self, text: str) -> dict[str, Any]:
                    return {
                        "suitability": "SUITABLE",
                        "findings": [],
                        "provider_events": [{"chunk_id": 0, "availability": True, "provider": "mock"}],
                    }

            with patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                lambda: _DummySessionCtx(self.state),
            ):
                res = await run_parent_submission_post_ocr(
                    sub.Id,
                    proofread_orchestrator=orch,
                    safety_orchestrator=_SafeRunner(),
                    download_bytes=lambda _path: img_bytes,
                )

            self.assertNotEqual(res.get("error_code"), "WORD_BOX_MISMATCH")
            self.assertEqual(sub.ProofreadStatus, "COMPLETED")
            self.assertEqual(sub.WorkflowStatus, "PASSED_READY_TO_ADD")
            self.assertEqual(len(sub.CandidateWordsJson), len(ocr_words))
            self.assertEqual(sub.CandidateWordsJson[0]["text"], "Mẹ")
            for w in sub.CandidateWordsJson:
                x, y, bw, bh = w["bbox"]
                self.assertGreaterEqual(x, 0.0)
                self.assertGreaterEqual(y, 0.0)
                self.assertGreater(bw, 0.0)
                self.assertGreater(bh, 0.0)
                self.assertLessEqual(x + bw, 1.0 + 1e-6)
                self.assertLessEqual(y + bh, 1.0 + 1e-6)

            # Verify suggestions & alignment never shift on standalone punctuation.
            aligned = align_edited_text_to_words(ocr_text, ocr_words)
            self.assertEqual(len(aligned), len(ocr_words))
            suggestions = build_proofread_suggestions(ocr_words, ocr_text)
            self.assertEqual(suggestions, [])

        asyncio.run(_scenario())

    def test_valid_bbox_clamps_and_rejects_out_of_bounds_boxes(self):
        self.assertEqual(_valid_bbox([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4])
        # Tiny rounding overflow <= 1.001 clamps cleanly to stay within 1.0
        clamped = _valid_bbox([0.9, 0.9, 0.1005, 0.1005])
        assert clamped is not None
        self.assertLessEqual(clamped[0] + clamped[2], 1.0)
        self.assertLessEqual(clamped[1] + clamped[3], 1.0)
        # Pixel coordinates or wildly out-of-bounds boxes are rejected
        self.assertIsNone(_valid_bbox([10.0, 20.0, 30.0, 40.0]))
        self.assertIsNone(_valid_bbox([0.8, 0.8, 0.5, 0.5]))
        self.assertIsNone(_valid_bbox([-0.1, 0.1, 0.2, 0.2]))

    def test_post_ocr_transient_429_503_retries_and_recovers_and_cloud_config_auto_enables_on_render(self):
        async def _scenario() -> None:
            now = datetime.now(timezone.utc)
            img_bytes = _make_png_bytes()
            img_sha = hashlib.sha256(img_bytes).hexdigest()
            text = "Chú mèo con"
            words = [
                {"word_index": 0, "line_index": 0, "text": "Chú", "bbox": [0.1, 0.1, 0.1, 0.05]},
                {"word_index": 1, "line_index": 0, "text": "mèo", "bbox": [0.22, 0.1, 0.1, 0.05]},
                {"word_index": 2, "line_index": 0, "text": "con", "bbox": [0.34, 0.1, 0.1, 0.05]},
            ]
            sub = ParentBookPageSubmission(
                Id=uuid4(),
                BookId=uuid4(),
                OwnerParentId=self.parent_id,
                BatchId=uuid4(),
                BatchTotalPages=1,
                SourcePageNumber=1,
                SourceStoragePath="private/retry.png",
                SourceSha256=img_sha,
                ImageWidth=320,
                ImageHeight=180,
                SourceType="SELF_AUTHORED",
                WorkflowStatus="CHECKING",
                OcrStatus="COMPLETED",
                OcrText=text,
                OcrWordsJson=words,
                ProofreadStatus="PENDING",
                ToolCheckStatus="PENDING",
                CandidateText=text,
                CandidateWordsJson=words,
                CandidateHash=compute_candidate_hash(text, source_sha256=img_sha),
                SubmissionVersion=1,
                OptimisticLockVersion=1,
                TempExpiresAt=now + timedelta(days=1),
            )
            self.state.tables[ParentBookPageSubmission].append(sub)

            proof_calls = 0

            class _FlakyProofread:
                async def correct(self, txt, *_args, **_kwargs):
                    nonlocal proof_calls
                    proof_calls += 1
                    if proof_calls < 3:
                        raise OcrOrchestrationError("PROVIDER_QUOTA")
                    return txt

            safety_calls = 0

            class _FlakySafety:
                async def analyze(self, _txt):
                    nonlocal safety_calls
                    safety_calls += 1
                    if safety_calls == 1:
                        err = RuntimeError("503 service unavailable")
                        err.status_code = 503  # type: ignore[attr-defined]
                        raise err
                    return {
                        "suitability": "SUITABLE",
                        "findings": [],
                        "provider_events": [{"chunk_id": 0, "availability": True, "provider": "gemini"}],
                    }

            with patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                lambda: _DummySessionCtx(self.state),
            ):
                await run_parent_submission_post_ocr(
                    sub.Id,
                    proofread_orchestrator=_FlakyProofread(),
                    safety_orchestrator=_FlakySafety(),
                    download_bytes=lambda _path: img_bytes,
                )

            self.assertEqual(proof_calls, 3)
            self.assertEqual(safety_calls, 2)
            self.assertEqual(sub.WorkflowStatus, "PASSED_READY_TO_ADD")

            # Verify Render cloud-AI auto-enablement & skipping dead local Ollama
            env = {
                "RENDER": "true",
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "GEMINI_API_KEY": "test-gemini-key",
                "LOCAL_OCR_BASE_URL": "",
                "LOCAL_OCR_ENABLED": "",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "",
            }
            with patch.dict(os.environ, env, clear=False):
                self.assertFalse(OcrCorrectionConfig.local_ollama_enabled())
                self.assertTrue(OcrCorrectionConfig.private_book_allow_cloud_ai())
                cfg = OcrCorrectionConfig.from_environment_for_private_book()
                self.assertTrue(cfg.gemini_enabled)
                self.assertFalse(cfg.local_enabled)
                orch = OcrCorrectionOrchestrator(cfg)
                self.assertNotIn("ollama", [p.family for p in orch.providers])

        asyncio.run(_scenario())

    def test_reconciler_recovers_stale_running_post_ocr_and_active_dedup_prevents_duplicates(self):
        async def _scenario() -> None:
            svc = self._svc()
            now = datetime.now(timezone.utc)
            # Active deduplication when idempotency_key=None
            page_id = uuid4()
            sha = "f" * 64
            j1 = await svc.enqueue_job(
                job_kind=JOB_KIND_ADMIN_UPLOAD,
                owner_user_id=self.admin_id,
                page_id=page_id,
                image_path="books/b/p1.png",
                image_sha256=sha,
                priority=PRIORITY_ADMIN_OCR,
                idempotency_key=None,
            )
            j2 = await svc.enqueue_job(
                job_kind=JOB_KIND_ADMIN_UPLOAD,
                owner_user_id=self.admin_id,
                page_id=page_id,
                image_path="books/b/p1.png",
                image_sha256=sha,
                priority=PRIORITY_ADMIN_OCR,
                idempotency_key=None,
            )
            self.assertEqual(j1.Id, j2.Id)

            # IntegrityError recovery on concurrent duplicate idempotency_key
            existing = await svc.enqueue_job(
                job_kind=JOB_KIND_ADMIN_UPLOAD,
                owner_user_id=self.admin_id,
                page_id=uuid4(),
                image_path="books/b/p2.png",
                image_sha256="e" * 64,
                idempotency_key="race-idem-1",
            )
            with (
                patch.object(svc.repo, "get_by_idempotency", side_effect=[None, existing]),
                patch.object(svc.repo, "create_job", side_effect=IntegrityError("dup", {}, Exception("uq"))),
            ):
                recovered = await svc.enqueue_job(
                    job_kind=JOB_KIND_ADMIN_UPLOAD,
                    owner_user_id=self.admin_id,
                    page_id=existing.PageId,
                    image_path="books/b/p2.png",
                    image_sha256="e" * 64,
                    idempotency_key="race-idem-1",
                )
            self.assertEqual(recovered.Id, existing.Id)

            # Reconciler recovers submissions stuck in ProofreadStatus='RUNNING'
            stuck = ParentBookPageSubmission(
                Id=uuid4(),
                BookId=uuid4(),
                OwnerParentId=self.parent_id,
                BatchId=uuid4(),
                BatchTotalPages=1,
                SourcePageNumber=1,
                SourceStoragePath="private/stuck.png",
                SourceSha256="d" * 64,
                ImageWidth=800,
                ImageHeight=1000,
                WorkflowStatus="CHECKING",
                OcrStatus="COMPLETED",
                ProofreadStatus="RUNNING",
                ToolCheckStatus="PENDING",
                SubmissionVersion=1,
                OptimisticLockVersion=1,
                Attempts=0,
                TempExpiresAt=now + timedelta(days=1),
                UpdatedAt=now - timedelta(minutes=6),
            )
            self.state.tables[ParentBookPageSubmission].append(stuck)
            rec = await reconcile_orphaned_parent_submissions(
                self.db,  # type: ignore[arg-type]
                stale_after_seconds=90,
                reschedule=False,
                now=now,
            )
            self.assertEqual(rec["reclaimed_count"], 1)
            self.assertEqual(stuck.ProofreadStatus, "PENDING")

        asyncio.run(_scenario())

    def test_enqueue_upload_document_jobs_returns_total_source_pages_without_500(self):
        async def _scenario() -> None:
            book_id = uuid4()
            self.state.tables[Book].append(
                Book(
                    Id=book_id,
                    Name="Doc Book",
                    Title="Doc Book",
                    MinGrade=1,
                    MaxGrade=3,
                    LifecycleStatus="ACTIVE",
                    VisibilityScope="CATALOG",
                    IsDeleted=False,
                    CreatedBy=self.admin_id,
                )
            )
            pdf_bytes = _make_multipage_pdf_bytes(num_pages=3)
            upload = UploadFile(
                filename="story.pdf",
                file=io.BytesIO(pdf_bytes),
                headers={"content-type": "application/pdf"},
            )
            svc = AdminOcrService(self.db)  # type: ignore[arg-type]
            with (
                patch.object(svc, "require_admin", new=AsyncMock(return_value=None)),
                patch.object(svc.repo, "book", new=AsyncMock(return_value=self.state.tables[Book][0])),
                patch.object(svc.repo, "next_active_page_number", new=AsyncMock(side_effect=[1, 2, 3])),
                patch.object(svc.repo, "stage_page_reservation", side_effect=lambda p: self.db.add(p)),
                patch.object(svc.repo, "flush", new=AsyncMock(return_value=None)),
                patch("app.services.admin_ocr_service.upload_object", return_value=None),
            ):
                result = await svc.enqueue_upload_document_jobs(
                    self.admin_id, book_id, upload, upload_id=uuid4()
                )
            self.assertEqual(result["total_source_pages"], 3)
            self.assertEqual(result["queued_count"], 3)
            self.assertEqual(len(result["job_ids"]), 3)

        asyncio.run(_scenario())

    def test_cleanup_expired_local_scan_objects_sweeps_stale_temp_scans(self):
        async def _scenario() -> None:
            now = datetime.now(timezone.utc)
            old_job = OcrInferenceJob(
                Id=uuid4(),
                JobKind=JOB_KIND_LOCAL_SCAN,
                Status="DEAD_LETTER",
                Priority=PRIORITY_LOCAL_SCAN,
                OwnerUserId=self.parent_id,
                ImageBucket="viread-private-books",
                ImagePath="local-scans/old-temp.jpg",
                ImageSha256="9" * 64,
                ProcessingMeta={},
                CreatedAt=now - timedelta(hours=30),
                UpdatedAt=now - timedelta(hours=30),
            )
            self.state.tables[OcrInferenceJob].append(old_job)
            deleted: list[str] = []
            with patch(
                "app.services.ocr_inference_job_service.storage_service.delete_object",
                side_effect=lambda path, **_kw: deleted.append(path),
            ):
                count = await cleanup_expired_local_scan_objects(
                    max_age_hours=24, now=now, db=self.db
                )
            self.assertEqual(count, 1)
            self.assertEqual(deleted, ["local-scans/old-temp.jpg"])
            self.assertTrue(old_job.ProcessingMeta.get("temp_image_cleaned"))

        asyncio.run(_scenario())

    def test_tesseract_fallback_multiparagraph_order_and_adaptive_line_sorting(self):
        import numpy as np
        from app.services import ocr_engine

        # 1) Multi-paragraph Tesseract dict resets line_num=1 per paragraph
        fake_data = {
            "text": ["Đoạn", "một", "Đoạn", "hai"],
            "left": [10, 120, 10, 120],
            "top": [10, 10, 200, 200],
            "width": [80, 900, 80, 80],  # 120 + 900 > 1000 -> must clamp cleanly to <= 1.0!
            "height": [30, 30, 30, 30],
            "conf": ["92", "90", "88", "91"],
            "block_num": [1, 1, 2, 2],
            "par_num": [1, 1, 1, 1],
            "line_num": [1, 1, 1, 1],
        }
        fake_pt = MagicMock()
        fake_pt.image_to_data.return_value = fake_data
        fake_out = MagicMock(DICT="dict")
        import cv2

        dummy_img = np.full((400, 1000, 3), 255, dtype=np.uint8)
        ok_enc, encoded_png = cv2.imencode(".png", dummy_img)
        self.assertTrue(ok_enc)
        with (
            patch.object(ocr_engine, "_resolve_tesseract_command", return_value=None),
            patch.object(ocr_engine, "_ensure_pytesseract", return_value=(fake_pt, fake_out)),
        ):
            out = ocr_engine._extract_text_and_boxes_tesseract(encoded_png.tobytes())
        self.assertEqual(out["text"], "Đoạn một\nĐoạn hai")
        self.assertEqual([w["line_index"] for w in out["words"]], [0, 0, 1, 1])
        for w in out["words"]:
            x, y, bw, bh = w["bbox"]
            self.assertLessEqual(x + bw, 1.0 + 1e-9)
            self.assertLessEqual(y + bh, 1.0 + 1e-9)

        # 2) Skewed same-line boxes sort left-to-right via band clustering
        raw_items = [
            ([[300, 100], [500, 100], [500, 140], [300, 140]], ("phải", 0.9)),
            ([[40, 106], [240, 106], [240, 146], [40, 146]], ("trái", 0.9)),
            ([[40, 220], [240, 220], [240, 260], [40, 260]], ("dưới", 0.9)),
        ]
        ordered, _layout = ocr_engine.sort_reading_order_adaptive(raw_items, 1000, dummy_img)
        self.assertEqual([it["paddle_text"] for it in ordered], ["trái", "phải", "dưới"])

    def test_streaming_rasterizer_memory_bounded_under_512mib_budget(self):
        async def _scenario() -> None:
            pdf_bytes = _make_multipage_pdf_bytes(num_pages=20)
            docx_bytes = _make_multipage_docx_bytes(num_pages=12)

            with patch.dict(os.environ, {"RENDER": "true"}, clear=False):
                # PDF streaming benchmark
                tracemalloc.start()
                spooled_pdf = await spool_upload_file(
                    UploadFile(
                        filename="bench20.pdf",
                        file=io.BytesIO(pdf_bytes),
                        headers={"content-type": "application/pdf"},
                    )
                )
                pdf_count = 0
                try:
                    with iter_rasterized_spooled_document(spooled_pdf) as (_fn, fmt, _sha, it):
                        self.assertEqual(fmt, "PDF")
                        for page in it:
                            pdf_count += 1
                            self.assertLessEqual(max(page.width, page.height), 2400)
                finally:
                    spooled_pdf.close()
                _curr_pdf, peak_pdf_bytes = tracemalloc.get_traced_memory()
                tracemalloc.stop()

                # DOCX streaming benchmark
                tracemalloc.start()
                spooled_docx = await spool_upload_file(
                    UploadFile(
                        filename="bench12.docx",
                        file=io.BytesIO(docx_bytes),
                        headers={
                            "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        },
                    )
                )
                docx_count = 0
                try:
                    with iter_rasterized_spooled_document(spooled_docx) as (_fn, fmt, _sha, it):
                        self.assertEqual(fmt, "DOCX")
                        for page in it:
                            docx_count += 1
                            self.assertLessEqual(max(page.width, page.height), 2400)
                finally:
                    spooled_docx.close()
                _curr_docx, peak_docx_bytes = tracemalloc.get_traced_memory()
                tracemalloc.stop()

            self.assertEqual(pdf_count, 20)
            self.assertEqual(docx_count, 12)
            # Peak Python heap allocation must stay well below 40 MiB (vs ~348 MiB before streaming!)
            self.assertLess(peak_pdf_bytes, 40 * 1024 * 1024)
            self.assertLess(peak_docx_bytes, 40 * 1024 * 1024)

        asyncio.run(_scenario())

    def test_hosted_flags_ignore_leftover_local_ocr_base_url_for_admin_and_parent(self):
        hosted_cases = (
            {"RENDER": "true"},
            {"VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true"},
            {"VIREAD_OCR_MODE": "remote_worker"},
        )
        for hosted_env in hosted_cases:
            env = {
                "LOCAL_OCR_BASE_URL": "http://127.0.0.1:11434",
                "LOCAL_OCR_ENABLED": "",
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "GEMINI_API_KEY": "test-gemini-key",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "",
                **hosted_env,
            }
            with self.subTest(hosted_env=hosted_env), patch.dict(os.environ, env, clear=True):
                self.assertFalse(OcrCorrectionConfig.local_ollama_enabled())
                self.assertTrue(OcrCorrectionConfig.private_book_allow_cloud_ai())

                admin_cfg = OcrCorrectionConfig.from_environment()
                parent_cfg = OcrCorrectionConfig.from_environment_for_private_book()
                for cfg in (admin_cfg, parent_cfg):
                    self.assertFalse(cfg.local_enabled)
                    self.assertTrue(cfg.gemini_enabled)
                    proofread_orch = OcrCorrectionOrchestrator(cfg)
                    safety_orch = ChildSafetyOrchestrator(cfg)
                    self.assertNotIn("ollama", [p.family for p in proofread_orch.providers])
                    self.assertNotIn("ollama", [p.family for p in safety_orch.providers])

        override_env = {
            "RENDER": "true",
            "LOCAL_OCR_BASE_URL": "http://127.0.0.1:11434",
            "LOCAL_OCR_ENABLED": "true",
            "OCR_CLOUD_CORRECTION_ENABLED": "true",
            "GEMINI_API_KEY": "test-gemini-key",
        }
        with patch.dict(os.environ, override_env, clear=True):
            self.assertTrue(OcrCorrectionConfig.local_ollama_enabled())
            cfg = OcrCorrectionConfig.from_environment()
            self.assertTrue(cfg.local_enabled)
            self.assertIn("ollama", [p.family for p in OcrCorrectionOrchestrator(cfg).providers])
            self.assertIn("ollama", [p.family for p in ChildSafetyOrchestrator(cfg).providers])

    def test_no_ai_provider_configured_fails_fast_without_retry(self):
        async def _scenario() -> None:
            self.assertIsNone(OcrConfigurationError("local ollama model missing").code)
            self.assertEqual(
                OcrConfigurationError("NO_AI_PROVIDER_CONFIGURED").code,
                "NO_AI_PROVIDER_CONFIGURED",
            )

            cases = (
                {
                    "RENDER": "true",
                    "LOCAL_OCR_BASE_URL": "http://127.0.0.1:11434",
                    "LOCAL_OCR_ENABLED": "",
                    "OCR_CLOUD_CORRECTION_ENABLED": "false",
                    "PRIVATE_BOOK_ALLOW_CLOUD_AI": "",
                },
                {
                    "RENDER": "true",
                    "LOCAL_OCR_BASE_URL": "http://127.0.0.1:11434",
                    "LOCAL_OCR_ENABLED": "",
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "GEMINI_API_KEY": "test-gemini-key",
                    "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false",
                },
            )
            for env in cases:
                with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                    cfg = OcrCorrectionConfig.from_environment_for_private_book()
                    self.assertFalse(cfg.local_enabled)
                    proof_orch = OcrCorrectionOrchestrator(cfg)
                    safety_orch = ChildSafetyOrchestrator(cfg)
                    self.assertEqual(proof_orch.providers, ())
                    self.assertEqual(safety_orch.providers, [])
                    with self.assertRaises(OcrConfigurationError) as proof_exc:
                        await proof_orch.correct("Xin chào", _make_png_bytes(), [(0.1, 0.1, 0.2, 0.05), (0.35, 0.1, 0.2, 0.05)])
                    self.assertEqual(proof_exc.exception.code, "NO_AI_PROVIDER_CONFIGURED")
                    with self.assertRaises(OcrConfigurationError) as safety_exc:
                        await safety_orch.analyze("Xin chào")
                    self.assertEqual(safety_exc.exception.code, "NO_AI_PROVIDER_CONFIGURED")

            now = datetime.now(timezone.utc)
            img_bytes = _make_png_bytes()
            img_sha = hashlib.sha256(img_bytes).hexdigest()
            text = "Xin chào"
            words = [
                {"word_index": 0, "line_index": 0, "text": "Xin", "bbox": [0.1, 0.1, 0.2, 0.05]},
                {"word_index": 1, "line_index": 0, "text": "chào", "bbox": [0.35, 0.1, 0.2, 0.05]},
            ]
            sub = ParentBookPageSubmission(
                Id=uuid4(),
                BookId=uuid4(),
                OwnerParentId=self.parent_id,
                BatchId=uuid4(),
                BatchTotalPages=1,
                SourcePageNumber=1,
                SourceStoragePath="private/no-ai.png",
                SourceSha256=img_sha,
                ImageWidth=320,
                ImageHeight=180,
                SourceType="SELF_AUTHORED",
                WorkflowStatus="CHECKING",
                OcrStatus="COMPLETED",
                OcrText=text,
                OcrWordsJson=words,
                ProofreadStatus="PENDING",
                ToolCheckStatus="PENDING",
                CandidateText=text,
                CandidateWordsJson=words,
                CandidateHash=compute_candidate_hash(text, source_sha256=img_sha),
                SubmissionVersion=1,
                OptimisticLockVersion=1,
                TempExpiresAt=now + timedelta(days=1),
            )
            self.state.tables[ParentBookPageSubmission].append(sub)

            attempts = 0

            class _UnconfiguredProofread:
                async def correct(self, *_args, **_kwargs):
                    nonlocal attempts
                    attempts += 1
                    raise OcrConfigurationError("NO_AI_PROVIDER_CONFIGURED")

            with patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                lambda: _DummySessionCtx(self.state),
            ):
                res = await run_parent_submission_post_ocr(
                    sub.Id,
                    proofread_orchestrator=_UnconfiguredProofread(),
                    download_bytes=lambda _path: img_bytes,
                )

            self.assertEqual(attempts, 1)
            self.assertEqual(res["status"], "CHECK_FAILED")
            self.assertEqual(res["error_code"], "NO_AI_PROVIDER_CONFIGURED")
            self.assertEqual(sub.WorkflowStatus, "CHECK_FAILED")
            self.assertEqual(sub.ProofreadErrorCode, "NO_AI_PROVIDER_CONFIGURED")

        asyncio.run(_scenario())

    def test_post_ocr_skips_started_provider_events_and_build_scope_defaults(self):
        async def _scenario() -> None:
            now = datetime.now(timezone.utc)
            img_bytes = _make_png_bytes()
            img_sha = hashlib.sha256(img_bytes).hexdigest()
            text = "Chú mèo con"
            words = [
                {"word_index": 0, "line_index": 0, "text": "Chú", "bbox": [0.1, 0.1, 0.1, 0.05]},
                {"word_index": 1, "line_index": 0, "text": "mèo", "bbox": [0.22, 0.1, 0.1, 0.05]},
                {"word_index": 2, "line_index": 0, "text": "con", "bbox": [0.34, 0.1, 0.1, 0.05]},
            ]
            sub = ParentBookPageSubmission(
                Id=uuid4(),
                BookId=uuid4(),
                OwnerParentId=self.parent_id,
                BatchId=uuid4(),
                BatchTotalPages=1,
                SourcePageNumber=1,
                SourceStoragePath="private/events.png",
                SourceSha256=img_sha,
                ImageWidth=320,
                ImageHeight=180,
                SourceType="SELF_AUTHORED",
                WorkflowStatus="CHECKING",
                OcrStatus="COMPLETED",
                OcrText=text,
                OcrWordsJson=words,
                ProofreadStatus="PENDING",
                ToolCheckStatus="PENDING",
                CandidateText=text,
                CandidateWordsJson=words,
                CandidateHash=compute_candidate_hash(text, source_sha256=img_sha),
                SubmissionVersion=1,
                OptimisticLockVersion=1,
                TempExpiresAt=now + timedelta(days=1),
            )
            self.state.tables[ParentBookPageSubmission].append(sub)

            class _EventProofread:
                async def correct(self, txt, *_args, on_provider_event=None, **_kwargs):
                    assert on_provider_event is not None
                    on_provider_event(
                        {
                            "provider": "gemini_3_5",
                            "model": "gemini-3.5-flash-lite",
                            "chunk_id": 0,
                            "status": "started",
                            "availability": None,
                            "error_code": None,
                            "duration_ms": 0,
                        }
                    )
                    on_provider_event(
                        {
                            "provider": "gemini_3_5",
                            "model": "gemini-3.5-flash-lite",
                            "chunk_id": 0,
                            "status": "succeeded",
                            "availability": True,
                            "error_code": None,
                            "duration_ms": 42,
                        }
                    )
                    return txt

            class _OkSafety:
                async def analyze(self, _txt):
                    return {
                        "suitability": "SUITABLE",
                        "findings": [],
                        "provider_events": [
                            {"provider": "gemini_primary", "chunk_id": 0, "availability": True}
                        ],
                    }

            with patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                lambda: _DummySessionCtx(self.state),
            ):
                res = await run_parent_submission_post_ocr(
                    sub.Id,
                    proofread_orchestrator=_EventProofread(),
                    safety_orchestrator=_OkSafety(),
                    download_bytes=lambda _path: img_bytes,
                )

            self.assertEqual(res["status"], "PASSED_READY_TO_ADD")
            self.assertEqual(len(sub.ProofreadProviderEventsJson), 1)
            self.assertEqual(sub.ProofreadProviderEventsJson[0]["availability"], True)
            self.assertEqual(sub.ProofreadProviderEventsJson[0]["duration_ms"], 42)

            with patch.dict(
                os.environ,
                {
                    "RENDER": "true",
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "LOCAL_OCR_ENABLED": "",
                    "PRIVATE_BOOK_ALLOW_CLOUD_AI": "",
                },
                clear=True,
            ):
                self.assertFalse(_build_scope({}).local_ai_enforced)
                self.assertTrue(_build_scope({"local_ai_enforced": True}).local_ai_enforced)

            with patch.dict(
                os.environ,
                {"PRIVATE_BOOK_ALLOW_CLOUD_AI": "false"},
                clear=True,
            ):
                self.assertTrue(_build_scope({}).local_ai_enforced)
                self.assertFalse(_build_scope({"local_ai_enforced": False}).local_ai_enforced)

        asyncio.run(_scenario())


if __name__ == "__main__":
    unittest.main()
