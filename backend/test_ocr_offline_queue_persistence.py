"""Comprehensive tests for offline OCR worker durable queuing across Parent, Admin, Global Tasks, and Cron hygiene."""
from __future__ import annotations

import asyncio
import hashlib
import io
import os
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

from fastapi import UploadFile
from fastapi.testclient import TestClient
from PIL import Image

from app.api.deps import get_current_parent_id, get_db
from app.models import (
    Book,
    BookPage,
    OcrInferenceJob,
    OcrWorkerHeartbeat,
    PageRevision,
    ParentBookPageSubmission,
)
from app.services.admin_ocr_service import AdminOcrService
from app.services.global_tasks_service import (
    WAITING_FOR_OCR_WORKER_SUBSTATUS_VI,
    GlobalTasksService,
)
from app.services.local_ocr_scan_service import (
    LocalOcrScanService,
    cleanup_expired_local_scan_objects,
)
from app.services.ocr_inference_job_service import (
    JOB_KIND_ADMIN_REPROCESS,
    JOB_KIND_ADMIN_REUPLOAD,
    JOB_KIND_ADMIN_UPLOAD,
    JOB_KIND_LOCAL_SCAN,
    JOB_KIND_PARENT_SUBMISSION,
    OcrInferenceJobService,
)
from test_ocr_inference_jobs import FakeAsyncSession, InMemoryDbState


def _make_sample_png_bytes() -> bytes:
    buf = io.BytesIO()
    img = Image.new("RGB", (120, 160), color=(255, 255, 255))
    img.save(buf, format="PNG")
    return buf.getvalue()


class OfflineOcrQueueBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = InMemoryDbState()
        self.parent_a = uuid4()
        self.parent_b = uuid4()
        self.admin_id = uuid4()
        self.book_id = uuid4()
        self.page_id = uuid4()
        self.rev_id = uuid4()
        self.now = datetime.now(timezone.utc)

        self.state.tables[Book].append(
            Book(
                Id=self.book_id,
                Title="Tiếng Việt Lớp 1",
                Name="Tap 1",
                Author="ViRead",
                MinGrade=1,
                MaxGrade=1,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                IsDeleted=False,
            )
        )
        self.state.tables[BookPage].append(
            BookPage(
                Id=self.page_id,
                BookId=self.book_id,
                PageNumber=1,
                ImagePath=f"books/{self.book_id}/pages/{self.page_id}/orig.png",
                Width=120,
                Height=160,
                ContentType="CONTENT",
                LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=None,
                ProcessingMeta={"storage": "supabase"},
            )
        )
        self.state.tables[PageRevision].append(
            PageRevision(
                Id=self.rev_id,
                PageId=self.page_id,
                RevisionNo=1,
                VerificationStatus="NEEDS_REVIEW",
                OriginalOcrText="Xin chào",
                DraftText="Xin chào",
                ProcessingMeta={
                    "source_image_path": f"books/{self.book_id}/pages/{self.page_id}/orig.png",
                    "source_image_sha256": "a" * 64,
                    "source_image_width": 120,
                    "source_image_height": 160,
                },
                CreatedAt=self.now,
            )
        )

    def test_local_scan_enqueue_list_tenant_isolation_and_worker_recovery(self) -> None:
        """Flow 1: Parent queues scan while laptop is offline, survives reload via GET /jobs, completes on recovery."""
        from app.sever import app

        db = FakeAsyncSession(self.state)
        active_actor = {"id": self.parent_a}
        uploaded_objects: list[str] = []

        async def _fake_get_db():
            yield db

        def _fake_actor():
            return active_actor["id"]

        async def _fake_profile_role(_self: Any, actor_id: UUID) -> str:
            if actor_id == self.admin_id:
                return "admin"
            return "parent"

        png_bytes = _make_sample_png_bytes()

        with (
            patch.dict(os.environ, {"VIREAD_OCR_MODE": "remote_worker"}, clear=False),
            patch(
                "app.repositories.local_ocr_scan_repository.LocalOcrScanRepository.profile_role",
                new=_fake_profile_role,
            ),
            patch(
                "app.repositories.local_ocr_scan_repository.LocalOcrScanRepository.eligible_verified_pages",
                new=AsyncMock(return_value=[]),
            ),
            patch(
                "app.services.storage_service.upload_object",
                side_effect=lambda path, *_args, **_kwargs: uploaded_objects.append(path),
            ),
            patch("app.services.storage_service.delete_object"),
            patch(
                "app.services.remote_ocr_wakeup.is_remote_worker_wakeup_configured",
                return_value=False,
            ),
            patch(
                "app.services.remote_ocr_wakeup.schedule_post_commit_ocr_wakeup",
                return_value=None,
            ),
            patch(
                "app.services.remote_ocr_wakeup.maybe_nudge_ocr_wakeup_for_stale_queued_job",
                return_value=False,
            ),
        ):
            app.dependency_overrides[get_db] = _fake_get_db
            app.dependency_overrides[get_current_parent_id] = _fake_actor
            try:
                client = TestClient(app)
                # 1. Enqueue while laptop worker is offline -> 202 QUEUED, worker_online=False
                resp = client.post(
                    "/reading/scan-page-ocr/jobs",
                    files={"file": ("trang-doc-1.png", png_bytes, "image/png")},
                )
                self.assertEqual(resp.status_code, 202, resp.text)
                enqueued = resp.json()
                self.assertEqual(enqueued["status"], "QUEUED")
                self.assertFalse(enqueued["worker_online"])
                self.assertEqual(enqueued["file_name"], "trang-doc-1.png")
                self.assertEqual(enqueued["queue_position"], 1)
                job_id = enqueued["job_id"]

                # 2. Reload persistence: GET /reading/scan-page-ocr/jobs?active_only=true returns Parent A's queued job
                list_resp = client.get("/reading/scan-page-ocr/jobs?active_only=true")
                self.assertEqual(list_resp.status_code, 200, list_resp.text)
                listed = list_resp.json()
                self.assertFalse(listed["worker_online"])
                self.assertEqual(len(listed["jobs"]), 1)
                self.assertEqual(listed["jobs"][0]["job_id"], job_id)
                self.assertEqual(listed["jobs"][0]["file_name"], "trang-doc-1.png")
                self.assertEqual(listed["jobs"][0]["queue_position"], 1)

                # 3. Tenant isolation: Parent B sees 0 jobs; Admin receives 403
                active_actor["id"] = self.parent_b
                list_b = client.get("/reading/scan-page-ocr/jobs?active_only=true")
                self.assertEqual(list_b.status_code, 200)
                self.assertEqual(list_b.json()["jobs"], [])

                active_actor["id"] = self.admin_id
                list_admin = client.get("/reading/scan-page-ocr/jobs?active_only=true")
                self.assertEqual(list_admin.status_code, 403)

                # 4. Simulate laptop OCR worker turning back on and completing the queued job
                active_actor["id"] = self.parent_a
                self.state.tables[OcrWorkerHeartbeat].append(
                    OcrWorkerHeartbeat(
                        WorkerId="windows-laptop-1",
                        Status="IDLE",
                        ActiveJobCount=0,
                        ConcurrencyLimit=1,
                        LastHeartbeatAt=datetime.now(timezone.utc),
                    )
                )
                stored_job = self.state.tables[OcrInferenceJob][0]
                stored_job.Status = "SUCCEEDED"
                stored_job.DurationMs = 1240
                stored_job.ResultPayload = {
                    "full_text": "Buổi sáng mùa thu trời trong xanh.",
                    "words": [
                        {
                            "word_index": 0,
                            "line_index": 0,
                            "text": "Buổi",
                            "bbox": [0.1, 0.1, 0.1, 0.05],
                            "ocr_confidence": 0.98,
                        }
                    ],
                    "ocr_meta": {
                        "engine": "paddleocr_vietocr_dual",
                        "runtime_device": "cuda",
                        "engine_statuses": {
                            "paddleocr": "success",
                            "vietocr": "success",
                            "tesseract": "success",
                        },
                    },
                    "no_text_detected": False,
                }

                # Polling the job now returns worker_online=True + SUCCEEDED OCR result
                done_resp = client.get(f"/reading/scan-page-ocr/jobs/{job_id}")
                self.assertEqual(done_resp.status_code, 200, done_resp.text)
                done = done_resp.json()
                self.assertTrue(done["worker_online"])
                self.assertEqual(done["status"], "SUCCEEDED")
                self.assertIsNotNone(done["result"])
                self.assertEqual(
                    done["result"]["ocr_text"],
                    "Buổi sáng mùa thu trời trong xanh.",
                )
            finally:
                app.dependency_overrides.clear()

    def test_admin_enqueue_endpoints_persist_queued_jobs_when_worker_offline(self) -> None:
        """Flow 3: Admin single upload, reupload, and reprocess persist QUEUED jobs with worker_online=False (no 503)."""
        db = FakeAsyncSession(self.state)
        service = AdminOcrService(db)
        png_bytes = _make_sample_png_bytes()

        async def _run() -> None:
            book_row = self.state.tables[Book][0]
            page_row = self.state.tables[BookPage][0]
            rev_row = self.state.tables[PageRevision][0]
            with (
                patch.object(service, "require_admin", new=AsyncMock(return_value=None)),
                patch.object(
                    service.repo,
                    "book",
                    new=AsyncMock(return_value=book_row),
                ),
                patch.object(
                    service.repo,
                    "page",
                    new=AsyncMock(return_value=page_row),
                ),
                patch.object(
                    service.repo,
                    "revisions",
                    new=AsyncMock(return_value=[rev_row]),
                ),
                patch.object(
                    service.repo,
                    "next_active_page_number",
                    new=AsyncMock(return_value=2),
                ),
                patch("app.services.admin_ocr_service.upload_object"),
                patch(
                    "app.services.remote_ocr_wakeup.is_remote_worker_wakeup_configured",
                    return_value=False,
                ),
                patch(
                    "app.services.remote_ocr_wakeup.schedule_post_commit_ocr_wakeup",
                    return_value=None,
                ),
            ):
                # 1. Single page upload job while worker offline
                upload_file = UploadFile(
                    filename="page-new.png",
                    file=io.BytesIO(png_bytes),
                    headers={"content-type": "image/png"},
                )
                upload_job = await service.enqueue_upload_page_job(
                    self.admin_id,
                    self.book_id,
                    upload_file,
                )
                self.assertEqual(upload_job["status"], "QUEUED")
                self.assertEqual(upload_job["job_kind"], JOB_KIND_ADMIN_UPLOAD)
                self.assertFalse(upload_job["worker_online"])

                # 2. Reupload job while worker offline
                reupload_file = UploadFile(
                    filename="page-replace.png",
                    file=io.BytesIO(png_bytes),
                    headers={"content-type": "image/png"},
                )
                reupload_job = await service.enqueue_reupload_ocr_job(
                    self.admin_id,
                    self.page_id,
                    reupload_file,
                )
                self.assertEqual(reupload_job["status"], "QUEUED")
                self.assertEqual(reupload_job["job_kind"], JOB_KIND_ADMIN_REUPLOAD)
                self.assertFalse(reupload_job["worker_online"])

                # 3. Reprocess job while worker offline
                reprocess_job = await service.enqueue_reprocess_job(
                    self.admin_id,
                    self.page_id,
                )
                self.assertEqual(reprocess_job["status"], "QUEUED")
                self.assertEqual(reprocess_job["job_kind"], JOB_KIND_ADMIN_REPROCESS)
                self.assertFalse(reprocess_job["worker_online"])

                # 4. Status & book job list payloads report worker_online=False
                job_svc = OcrInferenceJobService(db)
                single_status = await job_svc.get_job_status_payload(
                    UUID(str(reprocess_job["id"]))
                )
                self.assertFalse(single_status["worker_online"])

                book_jobs = await job_svc.list_book_jobs_payload(self.book_id)
                self.assertGreaterEqual(len(book_jobs), 2)
                self.assertTrue(all(item["worker_online"] is False for item in book_jobs))

        asyncio.run(_run())

    def test_global_tasks_waiting_for_worker_substatus_and_gentle_poll(self) -> None:
        """Flow 4: Global Task Center maps queued Parent & Admin OCR jobs to clear offline queue sub-status & 15s poll."""
        db = FakeAsyncSession(self.state)
        svc = GlobalTasksService(db)

        scan_job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_LOCAL_SCAN,
            Status="QUEUED",
            Priority=10,
            OwnerUserId=self.parent_a,
            ImagePath="local-scans/a.jpg",
            ImageSha256="b" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        parent_sub_job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_PARENT_SUBMISSION,
            Status="QUEUED",
            Priority=50,
            OwnerUserId=self.parent_a,
            BookId=self.book_id,
            ImagePath="private/a.jpg",
            ImageSha256="c" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        admin_job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_ADMIN_UPLOAD,
            Status="QUEUED",
            Priority=20,
            OwnerUserId=self.admin_id,
            BookId=self.book_id,
            PageId=self.page_id,
            ImagePath="books/a.jpg",
            ImageSha256="d" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        parent_sub = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=self.book_id,
            OwnerParentId=self.parent_a,
            SourceFileName="page1.png",
            SourceStoragePath="private/page1.png",
            SourceSha256="e" * 64,
            SourcePageNumber=1,
            TargetPageNumber=1,
            ImageWidth=100,
            ImageHeight=100,
            WorkflowStatus="CHECKING",
            OcrStatus="PENDING",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )

        mapped_scan = svc._map_ocr_job(
            scan_job,
            actor_role="parent",
            worker_online=False,
            book_titles={},
            page_numbers={},
        )
        self.assertEqual(mapped_scan.status, "WAITING_FOR_WORKER")
        self.assertEqual(
            mapped_scan.stage_label_vi,
            WAITING_FOR_OCR_WORKER_SUBSTATUS_VI,
        )
        self.assertEqual(mapped_scan.result_href, "/book-scanner")

        mapped_parent_job = svc._map_ocr_job(
            parent_sub_job,
            actor_role="parent",
            worker_online=False,
            book_titles={self.book_id: "Sách gia đình"},
            page_numbers={},
        )
        self.assertEqual(mapped_parent_job.status, "WAITING_FOR_WORKER")
        self.assertEqual(
            mapped_parent_job.stage_label_vi,
            WAITING_FOR_OCR_WORKER_SUBSTATUS_VI,
        )

        mapped_admin_job = svc._map_ocr_job(
            admin_job,
            actor_role="admin",
            worker_online=False,
            book_titles={self.book_id: "Tiếng Việt Lớp 1"},
            page_numbers={self.page_id: 1},
        )
        self.assertEqual(mapped_admin_job.status, "WAITING_FOR_WORKER")
        self.assertEqual(
            mapped_admin_job.stage_label_vi,
            WAITING_FOR_OCR_WORKER_SUBSTATUS_VI,
        )

        mapped_parent_sub = svc._map_parent_submission(
            parent_sub,
            worker_online=False,
            book_titles={self.book_id: "Sách gia đình"},
        )
        self.assertEqual(mapped_parent_sub.status, "WAITING_FOR_WORKER")
        self.assertEqual(
            mapped_parent_sub.stage_label_vi,
            WAITING_FOR_OCR_WORKER_SUBSTATUS_VI,
        )

    def test_durable_queue_hygiene_preserves_queued_jobs_and_images_over_72_hours(self) -> None:
        """Flow 5: Cron cleanup and lease reaper NEVER delete or expire QUEUED jobs/images even after 72h offline."""
        db = FakeAsyncSession(self.state)
        old_created = self.now - timedelta(hours=72)
        expired_lease = self.now - timedelta(minutes=10)

        queued_local_scan = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_LOCAL_SCAN,
            Status="QUEUED",
            Priority=10,
            OwnerUserId=self.parent_a,
            ImageBucket="private-books",
            ImagePath=f"local-scans/{self.parent_a}/queued-72h.jpg",
            ImageSha256="1" * 64,
            ProcessingMeta={"temp_image_ttl_hours": 72},
            AttemptCount=0,
            MaxAttempts=3,
            CreatedAt=old_created,
            UpdatedAt=old_created,
        )
        succeeded_local_scan = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_LOCAL_SCAN,
            Status="SUCCEEDED",
            Priority=10,
            OwnerUserId=self.parent_a,
            ImageBucket="private-books",
            ImagePath=f"local-scans/{self.parent_a}/done-72h.jpg",
            ImageSha256="2" * 64,
            ProcessingMeta={"temp_image_ttl_hours": 72},
            AttemptCount=1,
            MaxAttempts=3,
            CreatedAt=old_created,
            UpdatedAt=old_created,
            CompletedAt=old_created,
        )
        stuck_running_job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_ADMIN_UPLOAD,
            Status="RUNNING",
            Priority=20,
            OwnerUserId=self.admin_id,
            BookId=self.book_id,
            PageId=self.page_id,
            ImagePath="books/stuck.png",
            ImageSha256="3" * 64,
            WorkerId="dead-worker",
            AttemptCount=1,
            MaxAttempts=3,
            LeaseExpiresAt=expired_lease,
            CreatedAt=old_created,
            UpdatedAt=old_created,
        )
        self.state.tables[OcrInferenceJob].extend(
            [queued_local_scan, succeeded_local_scan, stuck_running_job]
        )

        deleted_paths: list[str] = []

        async def _run() -> None:
            with (
                patch(
                    "app.services.storage_service.delete_object",
                    side_effect=lambda path, **_kwargs: deleted_paths.append(path),
                ),
                patch(
                    "app.services.remote_ocr_wakeup.schedule_post_commit_ocr_wakeup",
                    return_value=None,
                ),
            ):
                cleaned = await cleanup_expired_local_scan_objects(
                    max_age_hours=24,
                    now=self.now,
                    db=db,
                )
                self.assertEqual(cleaned, 1)
                self.assertEqual(
                    deleted_paths,
                    [f"local-scans/{self.parent_a}/done-72h.jpg"],
                )
                self.assertFalse(
                    bool((queued_local_scan.ProcessingMeta or {}).get("temp_image_cleaned"))
                )

                reap_res = await OcrInferenceJobService(db).reap_expired_leases(
                    now=self.now
                )
                self.assertEqual(reap_res["reclaimed"], 1)
                self.assertEqual(reap_res["dead_lettered"], 0)
                # QUEUED 72h job stays untouched in QUEUED!
                self.assertEqual(queued_local_scan.Status, "QUEUED")
                # Expired RUNNING lease is reclaimed to FAILED_RETRYABLE for retry!
                self.assertEqual(stuck_running_job.Status, "FAILED_RETRYABLE")

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
