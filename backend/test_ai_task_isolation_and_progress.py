"""Unit tests for strict AI Task Center portal/actor isolation and universal `%` progress.

Covers:
1. Strict Admin A vs Admin B isolation across SmartStudioJob, OcrInferenceJob, AdminAiWorkflow.
2. Strict Parent A vs Parent B isolation across SmartStudioJob, OcrInferenceJob, ParentBookPageSubmission.
3. Strict Admin vs Parent portal isolation (/studio/admin/tasks*, /studio/parent/tasks*, /studio/tasks?portal=...).
4. Admin cannot create studio jobs targeting PARENT_PRIVATE books or inspect/mutate Parent OCR jobs.
5. ParentBookPageSubmission + linked PARENT_BOOK_SUBMISSION OcrInferenceJob deduplication with merged phase `%`.
6. OcrInferenceJobRepository duplicate lookup & BookAssetsRepository stale-cover scoping by actor/role.
7. Direct-call FastAPI route Query unwrapping.
8. Monotonic, finite `0..100` `%` progress across SmartStudioJob, OcrInferenceJob, LocalOcrPageScanJobRead,
   AdminAiWorkflow, ParentBookPageSubmission, BookQualityScanRead, Karaoke JobRead/SimpleProcessingStatusRead,
   and VireadOcrTrainingJob.
"""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock
from uuid import UUID, uuid4

_BACKEND_DIR = str(Path(__file__).resolve().parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db, require_admin_id
from app.api.routes.global_tasks import list_global_tasks, router as global_tasks_router
from app.models import (
    AdminAiWorkflow,
    Book,
    BookPage,
    OcrInferenceJob,
    OcrWorkerHeartbeat,
    ParentBookPageSubmission,
    Profile,
    SmartStudioJob,
)
from app.repositories.ocr_inference_job_repository import OcrInferenceJobRepository
from app.services.admin_ai_workflow_service import AdminAiWorkflowService
from app.services.ai_task_progress import (
    compute_admin_workflow_progress,
    compute_karaoke_job_progress,
    compute_ocr_job_progress,
    compute_parent_submission_progress,
    compute_quality_scan_progress,
    compute_studio_job_progress,
    compute_training_job_progress,
)
from app.services.book_content_quality_service import BookContentQualityService
from app.services.global_tasks_service import GlobalTasksService
from app.services.karaoke_processing_service import KaraokeProcessingService
from app.services.local_ocr_scan_service import LocalOcrScanService
from app.services.ocr_inference_job_service import (
    JOB_KIND_ADMIN_UPLOAD,
    JOB_KIND_LOCAL_SCAN,
    JOB_KIND_PARENT_SUBMISSION,
    OcrInferenceJobService,
)
from app.services.parent_private_book_service import ParentPrivateBookService
from test_durable_workflows_and_router import FakeStudioAsyncSession, StudioDbState


def _build_test_app(state: StudioDbState, active_actor: dict[str, UUID]) -> TestClient:
    app = FastAPI()
    app.include_router(global_tasks_router, prefix="/studio")

    async def _fake_get_db():
        yield FakeStudioAsyncSession(state)

    def _fake_actor() -> UUID:
        return active_actor["id"]

    async def _fake_require_admin() -> UUID:
        actor_id = active_actor["id"]
        role = next(
            (p.Role for p in state.tables[Profile] if p.Id == actor_id and p.Active == 1),
            None,
        )
        if role != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
        return actor_id

    app.dependency_overrides[get_db] = _fake_get_db
    app.dependency_overrides[get_current_parent_id] = _fake_actor
    app.dependency_overrides[require_admin_id] = _fake_require_admin
    return TestClient(app)


class PortalAndActorIsolationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.state = StudioDbState()
        self.db = FakeStudioAsyncSession(self.state)
        self.now = datetime.now(timezone.utc)
        self.admin_a = uuid4()
        self.admin_b = uuid4()
        self.parent_a = uuid4()
        self.parent_b = uuid4()

        self.db.add_all(
            [
                Profile(Id=self.admin_a, Role="admin", Active=1),
                Profile(Id=self.admin_b, Role="admin", Active=1),
                Profile(Id=self.parent_a, Role="parent", Active=1),
                Profile(Id=self.parent_b, Role="parent", Active=1),
            ]
        )

        self.catalog_book = Book(
            Id=uuid4(),
            Name="Sách công khai",
            Title="Sách công khai",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="ACTIVE",
            VisibilityScope="CATALOG",
            IsDeleted=False,
        )
        self.private_book_a = Book(
            Id=uuid4(),
            Name="Sách riêng A",
            Title="Sách riêng A",
            MinGrade=1,
            MaxGrade=2,
            LifecycleStatus="ACTIVE",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=self.parent_a,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        self.private_book_b = Book(
            Id=uuid4(),
            Name="Sách riêng B",
            Title="Sách riêng B",
            MinGrade=1,
            MaxGrade=2,
            LifecycleStatus="ACTIVE",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=self.parent_b,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        self.private_page_a = BookPage(
            Id=uuid4(),
            BookId=self.private_book_a.Id,
            PageNumber=1,
            ImagePath="private/a/p1.jpg",
            Width=800,
            Height=1000,
            LifecycleStatus="ACTIVE",
        )
        self.db.add_all(
            [self.catalog_book, self.private_book_a, self.private_book_b, self.private_page_a]
        )

        # Online worker heartbeat so RUNNING/QUEUED tasks show active worker state
        self.db.add(
            OcrWorkerHeartbeat(
                WorkerId="worker-1",
                Status="IDLE",
                LastHeartbeatAt=self.now,
            )
        )

        # Admin A tasks
        self.job_admin_a = SmartStudioJob(
            Id=uuid4(),
            JobType="COVER_GENERATE",
            ActorId=self.admin_a,
            ActorRole="admin",
            BookId=self.catalog_book.Id,
            InputHash="1" * 32,
            IdempotencyKey="adm-a-cover",
            Stage="IMAGE_GENERATING",
            Status="RUNNING",
            Priority=50,
            ProgressCompleted=2,
            ProgressTotal=4,
            ProgressUnit="bước",
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.ocr_admin_a = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_ADMIN_UPLOAD,
            Status="RUNNING",
            Priority=20,
            OwnerUserId=self.admin_a,
            BookId=self.catalog_book.Id,
            ImagePath="books/adm-a.png",
            ImageSha256="1" * 64,
            ProcessingMeta={"worker_phase": "recognizing"},
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.wf_admin_a = AdminAiWorkflow(
            Id=uuid4(),
            PageId=uuid4(),
            BookId=self.catalog_book.Id,
            PageRevisionId=uuid4(),
            ActorId=self.admin_a,
            IdempotencyKey=uuid4(),
            OriginalText="abc",
            InputText="abc",
            ImagePath="books/adm-a.png",
            OriginalOcrHash="1" * 64,
            AdminInputHash="1" * 64,
            Status="CHILD_SAFETY_SCANNING",
            Stage="CHILD_SAFETY_SCANNING",
            CompletedChunks=1,
            TotalChunks=2,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )

        # Admin B tasks (must NEVER leak to Admin A!)
        self.job_admin_b = SmartStudioJob(
            Id=uuid4(),
            JobType="COVER_GENERATE",
            ActorId=self.admin_b,
            ActorRole="admin",
            BookId=self.catalog_book.Id,
            InputHash="2" * 32,
            IdempotencyKey="adm-b-cover",
            Stage="QUEUED",
            Status="QUEUED",
            Priority=50,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.ocr_admin_b = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_ADMIN_UPLOAD,
            Status="QUEUED",
            OwnerUserId=self.admin_b,
            BookId=self.catalog_book.Id,
            ImagePath="books/adm-b.png",
            ImageSha256="2" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.wf_admin_b = AdminAiWorkflow(
            Id=uuid4(),
            PageId=uuid4(),
            BookId=self.catalog_book.Id,
            PageRevisionId=uuid4(),
            ActorId=self.admin_b,
            IdempotencyKey=uuid4(),
            OriginalText="def",
            InputText="def",
            ImagePath="books/adm-b.png",
            OriginalOcrHash="2" * 64,
            AdminInputHash="2" * 64,
            Status="PROOFREADING",
            Stage="PROOFREADING",
            CompletedChunks=0,
            TotalChunks=2,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )

        # Parent A tasks (including a linked submission + OCR job pair to test dedupe!)
        self.job_parent_a = SmartStudioJob(
            Id=uuid4(),
            JobType="COVER_GENERATE",
            ActorId=self.parent_a,
            ActorRole="parent",
            BookId=self.private_book_a.Id,
            InputHash="3" * 32,
            IdempotencyKey="par-a-cover",
            Stage="QUEUED",
            Status="FAILED",
            Priority=50,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.sub_parent_a = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=self.private_book_a.Id,
            OwnerParentId=self.parent_a,
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            IdempotencyKey="sub-par-a",
            SourceFileName="p1.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private/a/p1.png",
            SourceSha256="3" * 64,
            ImageWidth=500,
            ImageHeight=700,
            WorkflowStatus="CHECKING",
            OcrStatus="RUNNING",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.linked_ocr_parent_a = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_PARENT_SUBMISSION,
            Status="RUNNING",
            OwnerUserId=self.parent_a,
            BookId=self.private_book_a.Id,
            SubmissionId=self.sub_parent_a.Id,
            ImagePath="private/a/p1.png",
            ImageSha256="3" * 64,
            ProcessingMeta={"worker_phase": "recognizing"},
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.scan_parent_a = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_LOCAL_SCAN,
            Status="RUNNING",
            OwnerUserId=self.parent_a,
            ImagePath="local-scans/a.jpg",
            ImageSha256="4" * 64,
            ProcessingMeta={"worker_phase": "detecting"},
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )

        # Parent B tasks (must NEVER leak to Parent A or Admin!)
        self.job_parent_b = SmartStudioJob(
            Id=uuid4(),
            JobType="COVER_GENERATE",
            ActorId=self.parent_b,
            ActorRole="parent",
            BookId=self.private_book_b.Id,
            InputHash="5" * 32,
            IdempotencyKey="par-b-cover",
            Stage="QUEUED",
            Status="QUEUED",
            Priority=50,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.sub_parent_b = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=self.private_book_b.Id,
            OwnerParentId=self.parent_b,
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            IdempotencyKey="sub-par-b",
            SourceFileName="b1.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private/b/p1.png",
            SourceSha256="5" * 64,
            ImageWidth=500,
            ImageHeight=700,
            WorkflowStatus="CHECKING",
            OcrStatus="PENDING",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )

        self.db.add_all(
            [
                self.job_admin_a,
                self.ocr_admin_a,
                self.wf_admin_a,
                self.job_admin_b,
                self.ocr_admin_b,
                self.wf_admin_b,
                self.job_parent_a,
                self.sub_parent_a,
                self.linked_ocr_parent_a,
                self.scan_parent_a,
                self.job_parent_b,
                self.sub_parent_b,
            ]
        )
        # Mark seeded fixture rows as committed so rollbacks during negative tests do not clear fixtures.
        self.db._pending_adds.clear()
        self.db._snapshots.clear()

    def test_strict_four_actor_and_portal_isolation(self) -> None:
        active_actor = {"id": self.admin_a}
        client = _build_test_app(self.state, active_actor)

        # 1. Admin A on /studio/admin/tasks sees ONLY Admin A's 3 tasks (ZERO Admin B, ZERO Parent!)
        resp_adm_a = client.get("/studio/admin/tasks")
        self.assertEqual(resp_adm_a.status_code, 200)
        body_adm_a = resp_adm_a.json()
        self.assertEqual(body_adm_a["portal"], "admin")
        self.assertEqual(body_adm_a["actor_role"], "admin")
        ids_adm_a = {t["id"] for t in body_adm_a["tasks"]}
        self.assertEqual(
            ids_adm_a,
            {str(self.job_admin_a.Id), str(self.ocr_admin_a.Id), str(self.wf_admin_a.Id)},
        )
        self.assertTrue(all(t["portal"] == "admin" for t in body_adm_a["tasks"]))
        self.assertTrue(all(t["actor_id"] == str(self.admin_a) for t in body_adm_a["tasks"]))
        self.assertTrue(all(t["is_indeterminate"] is False for t in body_adm_a["tasks"]))
        self.assertTrue(
            all(isinstance(t["progress_pct"], (int, float)) for t in body_adm_a["tasks"])
        )

        # Admin A detail GET works for own job & returns 404 for Admin B and Parent A!
        self.assertEqual(client.get(f"/studio/admin/tasks/{self.job_admin_a.Id}").status_code, 200)
        self.assertEqual(client.get(f"/studio/admin/tasks/{self.wf_admin_a.Id}").status_code, 200)
        self.assertEqual(client.get(f"/studio/admin/tasks/{self.job_admin_b.Id}").status_code, 404)
        self.assertEqual(client.get(f"/studio/admin/tasks/{self.wf_admin_b.Id}").status_code, 404)
        self.assertEqual(client.get(f"/studio/admin/tasks/{self.job_parent_a.Id}").status_code, 404)
        self.assertEqual(client.post(f"/studio/admin/tasks/{self.job_admin_b.Id}/cancel").status_code, 404)

        # Cross-portal rejection: Admin A calling /studio/parent/tasks* or ?portal=parent -> 403!
        self.assertEqual(client.get("/studio/parent/tasks").status_code, 403)
        self.assertEqual(client.get("/studio/tasks?portal=parent").status_code, 403)
        self.assertEqual(client.get(f"/studio/parent/tasks/{self.job_admin_a.Id}").status_code, 403)

        # Admin A cannot create studio job on PARENT_PRIVATE book or page -> 403!
        resp_priv_book = client.post(
            "/studio/admin/tasks",
            json={
                "job_type": "COVER_GENERATE",
                "book_id": str(self.private_book_a.Id),
                "input_hash": "9" * 32,
                "idempotency_key": "admin-touch-private-book",
            },
        )
        self.assertEqual(resp_priv_book.status_code, 403)
        resp_priv_page = client.post(
            "/studio/admin/tasks",
            json={
                "job_type": "OCR_EXTRACT",
                "book_page_id": str(self.private_page_a.Id),
                "input_hash": "9" * 32,
                "idempotency_key": "admin-touch-private-page",
            },
        )
        self.assertEqual(resp_priv_page.status_code, 403)

        # 2. Admin B sees ONLY Admin B's 3 tasks
        active_actor["id"] = self.admin_b
        resp_adm_b = client.get("/studio/admin/tasks")
        self.assertEqual(resp_adm_b.status_code, 200)
        ids_adm_b = {t["id"] for t in resp_adm_b.json()["tasks"]}
        self.assertEqual(
            ids_adm_b,
            {str(self.job_admin_b.Id), str(self.ocr_admin_b.Id), str(self.wf_admin_b.Id)},
        )

        # 3. Parent A on /studio/parent/tasks sees ONLY Parent A's tasks, WITH linked OCR job deduped!
        active_actor["id"] = self.parent_a
        resp_par_a = client.get("/studio/parent/tasks")
        self.assertEqual(resp_par_a.status_code, 200)
        body_par_a = resp_par_a.json()
        self.assertEqual(body_par_a["portal"], "parent")
        ids_par_a = {t["id"] for t in body_par_a["tasks"]}
        # linked_ocr_parent_a is merged into sub_parent_a (NOT duplicated!)
        self.assertEqual(
            ids_par_a,
            {str(self.job_parent_a.Id), str(self.sub_parent_a.Id), str(self.scan_parent_a.Id)},
        )
        self.assertNotIn(str(self.linked_ocr_parent_a.Id), ids_par_a)

        # Verify merged OCR worker_phase `%` inside sub_parent_a!
        sub_item = next(t for t in body_par_a["tasks"] if t["id"] == str(self.sub_parent_a.Id))
        self.assertEqual(sub_item["source"], "parent_submission")
        self.assertEqual(sub_item["result_ref"]["linked_ocr_job_id"], str(self.linked_ocr_parent_a.Id))
        self.assertEqual(sub_item["result_ref"]["worker_phase"], "recognizing")
        # recognizing OCR pct = 76% -> scaled into stage 1 band (0..34%) = 25.8%
        self.assertAlmostEqual(sub_item["progress_pct"], 25.8, places=1)
        self.assertFalse(sub_item["is_indeterminate"])

        # Cross-portal & cross-parent rejection for Parent A
        self.assertEqual(client.get("/studio/admin/tasks").status_code, 403)
        self.assertEqual(client.get("/studio/tasks?portal=admin").status_code, 403)
        self.assertEqual(client.get(f"/studio/parent/tasks/{self.job_parent_b.Id}").status_code, 404)
        self.assertEqual(client.get(f"/studio/parent/tasks/{self.sub_parent_b.Id}").status_code, 404)
        self.assertEqual(client.get(f"/studio/parent/tasks/{self.job_admin_a.Id}").status_code, 404)
        self.assertEqual(client.post(f"/studio/parent/tasks/{self.job_parent_b.Id}/cancel").status_code, 404)

        # Own retry succeeds for Parent A on failed job
        self.assertEqual(client.post(f"/studio/parent/tasks/{self.job_parent_a.Id}/retry").status_code, 200)

        # 4. Parent B sees ONLY Parent B's 2 tasks
        active_actor["id"] = self.parent_b
        resp_par_b = client.get("/studio/parent/tasks")
        self.assertEqual(resp_par_b.status_code, 200)
        ids_par_b = {t["id"] for t in resp_par_b.json()["tasks"]}
        self.assertEqual(ids_par_b, {str(self.job_parent_b.Id), str(self.sub_parent_b.Id)})

    async def test_direct_call_route_unwraps_query_defaults(self) -> None:
        resp = Response()
        result = await list_global_tasks(
            response=resp,
            actor_id=self.parent_b,
            db=self.db,  # type: ignore[arg-type]
        )
        self.assertEqual(result.portal, "parent")
        self.assertEqual({t.id for t in result.tasks}, {self.job_parent_b.Id, self.sub_parent_b.Id})

    async def test_admin_ocr_job_service_blocks_parent_jobs(self) -> None:
        svc = OcrInferenceJobService(self.db)  # type: ignore[arg-type]
        # Admin OCR status/retry/cancel must reject parent jobs with 404
        with self.assertRaises(HTTPException) as ctx_status:
            await svc.get_job_status_payload(self.linked_ocr_parent_a.Id, admin_only=True)
        self.assertEqual(ctx_status.exception.status_code, 404)

        with self.assertRaises(HTTPException) as ctx_retry:
            await svc.retry_job(self.scan_parent_a.Id, admin_only=True)
        self.assertEqual(ctx_retry.exception.status_code, 404)

        with self.assertRaises(HTTPException) as ctx_cancel:
            await svc.cancel_job(self.linked_ocr_parent_a.Id, admin_only=True)
        self.assertEqual(ctx_cancel.exception.status_code, 404)

        # Book list with admin_only=True excludes parent jobs even if sharing a book_id
        mixed_book_id = self.catalog_book.Id
        stray_parent_job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_PARENT_SUBMISSION,
            Status="QUEUED",
            OwnerUserId=self.parent_a,
            BookId=mixed_book_id,
            ImagePath="private/stray.png",
            ImageSha256="6" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.db.add(stray_parent_job)
        admin_book_jobs = await svc.list_book_jobs_payload(mixed_book_id, admin_only=True)
        self.assertTrue(all(item["job_kind"] != JOB_KIND_PARENT_SUBMISSION for item in admin_book_jobs))
        # Also verify serialized OCR job includes worker_phase and numeric progress_pct
        adm_a_payload = await svc.get_job_status_payload(self.ocr_admin_a.Id, admin_only=True)
        self.assertEqual(adm_a_payload["worker_phase"], "recognizing")
        self.assertEqual(adm_a_payload["progress_pct"], 76.0)

    async def test_ocr_duplicate_lookup_isolated_by_owner(self) -> None:
        repo = OcrInferenceJobRepository(self.db)  # type: ignore[arg-type]
        shared_page_id = uuid4()
        job_a = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_ADMIN_UPLOAD,
            Status="QUEUED",
            OwnerUserId=self.admin_a,
            PageId=shared_page_id,
            ImagePath="books/dup.png",
            ImageSha256="7" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.db.add(job_a)

        same_owner_dup = await repo.find_active_duplicate_job(
            job_kind=JOB_KIND_ADMIN_UPLOAD,
            image_sha256="7" * 64,
            owner_user_id=self.admin_a,
            page_id=shared_page_id,
        )
        self.assertIsNotNone(same_owner_dup)
        self.assertEqual(same_owner_dup.Id, job_a.Id)

        other_owner_dup = await repo.find_active_duplicate_job(
            job_kind=JOB_KIND_ADMIN_UPLOAD,
            image_sha256="7" * 64,
            owner_user_id=self.admin_b,
            page_id=shared_page_id,
        )
        self.assertIsNone(other_owner_dup)

    async def test_mark_inflight_cover_jobs_stale_scopes_by_actor_and_role(self) -> None:
        from contextlib import asynccontextmanager
        from app.repositories.book_assets_repository import BookAssetsRepository

        captured_sql: list[str] = []

        class _CaptureDb:
            @asynccontextmanager
            async def begin_nested(self):
                yield self

            async def execute(self, stmt):
                captured_sql.append(str(stmt))
                return SimpleNamespace(rowcount=1)

        repo = BookAssetsRepository(_CaptureDb())  # type: ignore[arg-type]
        count = await repo.mark_inflight_cover_jobs_stale(
            self.catalog_book.Id,
            actor_role="admin",
            actor_id=self.admin_a,
        )
        self.assertEqual(count, 1)
        self.assertEqual(len(captured_sql), 1)
        self.assertIn("actor_role", captured_sql[0].lower())
        self.assertIn("actor_id", captured_sql[0].lower())

    async def test_batch_book_import_tracks_live_ocr_job_progress(self) -> None:
        ocr1 = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_ADMIN_UPLOAD,
            Status="SUCCEEDED",
            OwnerUserId=self.admin_a,
            BookId=self.catalog_book.Id,
            ImagePath="books/b1.png",
            ImageSha256="8" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        ocr2 = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_ADMIN_UPLOAD,
            Status="RUNNING",
            OwnerUserId=self.admin_a,
            BookId=self.catalog_book.Id,
            ImagePath="books/b2.png",
            ImageSha256="9" * 64,
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        batch_job = SmartStudioJob(
            Id=uuid4(),
            JobType="BATCH_BOOK_IMPORT",
            ActorId=self.admin_a,
            ActorRole="admin",
            BookId=self.catalog_book.Id,
            InputHash="b" * 32,
            IdempotencyKey="batch-doc-live",
            Stage="OCR",
            Status="QUEUED",
            Priority=60,
            ProgressCompleted=0,
            ProgressTotal=2,
            ProgressUnit="trang",
            CheckpointsJson={
                "tracking_mode": "remote_ocr_batch",
                "ocr_job_ids": [str(ocr1.Id), str(ocr2.Id)],
            },
            CreatedAt=self.now,
            UpdatedAt=self.now,
        )
        self.db.add_all([ocr1, ocr2, batch_job])

        svc = GlobalTasksService(self.db)  # type: ignore[arg-type]
        feed = await svc.list_tasks(actor_id=self.admin_a, portal="admin")
        batch_item = next(t for t in feed.tasks if t.id == batch_job.Id)
        self.assertEqual(batch_item.status, "RUNNING")
        self.assertEqual(batch_item.progress_completed, 1)
        self.assertEqual(batch_item.progress_total, 2)
        self.assertEqual(batch_item.progress_pct, 50.0)
        self.assertEqual(batch_item.progress_mode, "measured")


class UniversalProgressContractTests(unittest.IsolatedAsyncioTestCase):
    def test_admin_workflow_monotonic_two_phase_progress(self) -> None:
        seq = [
            compute_admin_workflow_progress(status="QUEUED", stage="PROOFREADING", completed_chunks=0, total_chunks=2)[0],
            compute_admin_workflow_progress(status="PROOFREADING", stage="PROOFREADING", completed_chunks=0, total_chunks=2)[0],
            compute_admin_workflow_progress(status="PROOFREADING", stage="PROOFREADING", completed_chunks=1, total_chunks=2)[0],
            compute_admin_workflow_progress(status="PROOFREADING", stage="PROOFREADING", completed_chunks=2, total_chunks=2)[0],
            compute_admin_workflow_progress(status="CHILD_SAFETY_SCANNING", stage="CHILD_SAFETY_SCANNING", completed_chunks=0, total_chunks=2)[0],
            compute_admin_workflow_progress(status="CHILD_SAFETY_SCANNING", stage="CHILD_SAFETY_SCANNING", completed_chunks=1, total_chunks=2)[0],
            compute_admin_workflow_progress(status="CHILD_SAFETY_SCANNING", stage="CHILD_SAFETY_SCANNING", completed_chunks=2, total_chunks=2)[0],
            compute_admin_workflow_progress(status="READY_FOR_ADMIN_REVIEW", stage="READY_FOR_ADMIN_REVIEW", completed_chunks=2, total_chunks=2)[0],
        ]
        # Strictly non-decreasing — zero 100% -> 0% drop between Proofreading and Safety!
        for prev, nxt in zip(seq, seq[1:]):
            self.assertLessEqual(prev, nxt, f"Progress dropped from {prev} to {nxt} in {seq}")
        self.assertEqual(seq[0], 5.0)
        self.assertEqual(seq[-1], 100.0)

        # Also verify AdminAiWorkflowService._read populates progress_pct
        now = datetime.now(timezone.utc)
        wf = SimpleNamespace(
            Id=uuid4(),
            PageId=uuid4(),
            BookId=uuid4(),
            PageRevisionId=uuid4(),
            Status="CHILD_SAFETY_SCANNING",
            Stage="CHILD_SAFETY_SCANNING",
            CompletedChunks=1,
            TotalChunks=2,
            Attempts=1,
            ErrorCode=None,
            OriginalOcrHash="a" * 64,
            AdminInputHash="a" * 64,
            ProofreadText="xin chào",
            ProofreadOutputHash="b" * 64,
            CorrectionSuggestions=[],
            UncertainWordIndices=[],
            ProofreadMetadata={},
            SafetyMetadata={},
            CandidateHistory=[],
            SafetyHistory=[],
            ReviewEvents=[],
            CandidateText="xin chào",
            CandidateHash="b" * 64,
            CandidateVersion=1,
            SafetyInputHash=None,
            Suitability=None,
            SafetyStatus="PENDING",
            Findings=[],
            ProviderEvents=[],
            OcrApprovedAt=None,
            FinalApprovedTextHash=None,
            CreatedAt=now,
            UpdatedAt=now,
        )
        dto = AdminAiWorkflowService._read(wf)  # type: ignore[arg-type]
        self.assertEqual(dto.progress_pct, 75.0)

    def test_parent_submission_continuous_three_stage_progress(self) -> None:
        stages = [
            compute_parent_submission_progress(
                workflow_status="CHECKING", ocr_status="PENDING", proofread_status="PENDING", tool_check_status="PENDING", worker_online=False
            )[2],
            compute_parent_submission_progress(
                workflow_status="CHECKING", ocr_status="PENDING", proofread_status="PENDING", tool_check_status="PENDING", linked_ocr_status="RUNNING", linked_ocr_worker_phase="detecting", worker_online=True
            )[2],
            compute_parent_submission_progress(
                workflow_status="CHECKING", ocr_status="COMPLETED", proofread_status="PENDING", tool_check_status="PENDING"
            )[2],
            compute_parent_submission_progress(
                workflow_status="CHECKING", ocr_status="COMPLETED", proofread_status="RUNNING", tool_check_status="PENDING"
            )[2],
            compute_parent_submission_progress(
                workflow_status="CHECKING", ocr_status="COMPLETED", proofread_status="COMPLETED", tool_check_status="PENDING"
            )[2],
            compute_parent_submission_progress(
                workflow_status="CHECKING", ocr_status="COMPLETED", proofread_status="COMPLETED", tool_check_status="RUNNING"
            )[2],
            compute_parent_submission_progress(
                workflow_status="PASSED_READY_TO_ADD", ocr_status="COMPLETED", proofread_status="COMPLETED", tool_check_status="PASSED"
            )[2],
        ]
        for prev, nxt in zip(stages, stages[1:]):
            self.assertLess(prev, nxt, f"Parent progress not increasing: {stages}")
        self.assertEqual(stages[0], 2.0)
        self.assertEqual(stages[-1], 100.0)

        # Also check ParentPrivateBookService._serialize_submission includes progress_pct
        now = datetime.now(timezone.utc)
        book = SimpleNamespace(Id=uuid4(), LifecycleStatus="ACTIVE", ModerationStatus="ACTIVE")
        sub = SimpleNamespace(
            Id=uuid4(),
            BookId=book.Id,
            OwnerParentId=uuid4(),
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            TargetPageNumber=1,
            SourceFileName="p.png",
            SourceFormat="PNG",
            ImageWidth=400,
            ImageHeight=600,
            SourceStoragePath="private/p.png",
            SourceType="SELF_AUTHORED",
            SourceNote=None,
            SubmissionVersion=1,
            OptimisticLockVersion=1,
            WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED",
            OcrText="Xin chào",
            OcrErrorCode=None,
            IsImageOnly=False,
            ProofreadStatus="RUNNING",
            ProofreadText=None,
            ProofreadSuggestionsJson=[],
            UncertainWordIndicesJson=[],
            ProofreadErrorCode=None,
            SpellingAcceptedAt=None,
            CandidateText="Xin chào",
            CandidateHash="c" * 64,
            ToolCheckStatus="PENDING",
            ToolCheckSuitability=None,
            ToolCheckScopeJson={},
            ToolCheckFindingsJson=[],
            ToolCheckPolicyBlocked=False,
            ToolCheckWorkflowId=None,
            ToolCheckErrorCode=None,
            ProofreadProviderEventsJson=[],
            ToolCheckProviderEventsJson=[],
            AdminDecision=None,
            AdminDecisionReason=None,
            ApprovedSnapshotHash=None,
            ApprovedSubmissionVersion=None,
            CommittedPageId=None,
            CommittedRevisionId=None,
            CreatedAt=now,
            UpdatedAt=now,
        )
        svc = ParentPrivateBookService(MagicMock())
        dto = svc._serialize_submission(book, sub)  # type: ignore[arg-type]
        self.assertEqual(dto.progress_pct, 52.0)

    def test_studio_ocr_quality_karaoke_and_training_progress(self) -> None:
        # Studio job: measured vs staged
        self.assertEqual(
            compute_studio_job_progress(status="RUNNING", stage="COVER_GEN", completed=3, total=4, unit="bước")[3:],
            (75.0, False, "measured"),
        )
        self.assertEqual(
            compute_studio_job_progress(status="QUEUED", stage="QUEUED", completed=None, total=None)[3:],
            (5.0, False, "staged"),
        )
        self.assertEqual(
            compute_studio_job_progress(status="WAITING_FOR_WORKER", stage="OCR", completed=None, total=None)[3:],
            (2.0, False, "staged"),
        )

        # OCR job phases
        self.assertEqual(compute_ocr_job_progress(status="QUEUED", worker_online=False)[0], 2.0)
        self.assertEqual(compute_ocr_job_progress(status="QUEUED", worker_online=True)[0], 8.0)
        self.assertEqual(compute_ocr_job_progress(status="CLAIMED")[0], 18.0)
        self.assertEqual(compute_ocr_job_progress(status="RUNNING", worker_phase="downloading")[0], 30.0)
        self.assertEqual(compute_ocr_job_progress(status="RUNNING", worker_phase="detecting")[0], 52.0)
        self.assertEqual(compute_ocr_job_progress(status="RUNNING", worker_phase="recognizing")[0], 76.0)
        self.assertEqual(compute_ocr_job_progress(status="RUNNING", worker_phase="postprocessing")[0], 90.0)
        self.assertEqual(compute_ocr_job_progress(status="SUCCEEDED")[0], 100.0)

        # BookQualityScanRead
        now = datetime.now(timezone.utc)
        scan_run = SimpleNamespace(
            Id=uuid4(),
            BookId=uuid4(),
            BookTitleSnapshot="Sách hay",
            TriggerType="MANUAL",
            Scope="BOOK",
            TargetPageId=None,
            Status="RUNNING",
            TotalPages=10,
            CompletedPages=4,
            SkippedPages=0,
            FailedPages=0,
            AICompletedPages=4,
            AIUnavailablePages=0,
            ErrorSummary=None,
            StartedAt=now,
            CompletedAt=None,
            CreatedAt=now,
        )
        scan_dto = BookContentQualityService._scan_read(scan_run)  # type: ignore[arg-type]
        self.assertEqual(scan_dto.progress_pct, 40.0)
        self.assertEqual(compute_quality_scan_progress(status="QUEUED", total_pages=10), 5.0)
        self.assertEqual(compute_quality_scan_progress(status="COMPLETED", total_pages=10), 100.0)

        # Karaoke JobRead & stage mapping
        karaoke_stages = [
            compute_karaoke_job_progress(status="QUEUED", stage="QUEUED"),
            compute_karaoke_job_progress(status="RUNNING", stage="VALIDATING_INPUT"),
            compute_karaoke_job_progress(status="RUNNING", stage="PREPARING_AUDIO"),
            compute_karaoke_job_progress(status="RUNNING", stage="ALIGNING_LYRICS"),
            compute_karaoke_job_progress(status="RUNNING", stage="VALIDATING_RESULT"),
            compute_karaoke_job_progress(status="READY", stage="COMPLETE"),
        ]
        self.assertEqual(karaoke_stages, [8.0, 20.0, 45.0, 75.0, 92.0, 100.0])

        job_ns = SimpleNamespace(
            id=uuid4(),
            song_id=uuid4(),
            draft_version_id=uuid4(),
            base_revision=1,
            mode="VOCAL_TRACK",
            source_kind="DRAFT_AUDIO",
            status="RUNNING",
            stage="ALIGNING_LYRICS",
            input_fingerprint="a" * 64,
            created_at=now,
            updated_at=now,
            finished_at=None,
            applied_at=None,
            applied_revision=None,
            safe_error_code=None,
            retry_policy="SAFE_RETRY",
            quality_flags=[],
            result_payload=None,
            lyrics_hash=None,
            audio_sha256=None,
        )
        state_ns = SimpleNamespace(draft=None, song=SimpleNamespace(revision=1))
        karaoke_dto = KaraokeProcessingService._dto(state_ns, job_ns)
        self.assertEqual(karaoke_dto.progress_pct, 75.0)

        # Viread OCR training job progress
        self.assertEqual(compute_training_job_progress(status="WAITING_FOR_COLAB_WORKER"), 4.0)
        self.assertEqual(
            compute_training_job_progress(
                status="COLAB_RUNNING",
                progress={"completed_steps": 300, "total_steps": 1000},
            ),
            30.0,
        )
        self.assertEqual(compute_training_job_progress(status="SUCCEEDED"), 100.0)

    async def test_local_ocr_scan_job_serialization_includes_progress_and_phase(self) -> None:
        now = datetime.now(timezone.utc)
        job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=JOB_KIND_LOCAL_SCAN,
            Status="RUNNING",
            Priority=10,
            OwnerUserId=uuid4(),
            ImagePath="local-scans/test.jpg",
            ImageSha256="a" * 64,
            ProcessingMeta={"file_name": "scan1.jpg", "worker_phase": "recognizing"},
            CreatedAt=now,
            UpdatedAt=now,
        )
        svc = LocalOcrScanService(MagicMock())
        dto = await svc._serialize_scan_job(job, worker_online=True, request_id="req-1")
        self.assertEqual(dto.worker_phase, "recognizing")
        self.assertEqual(dto.progress_pct, 76.0)


if __name__ == "__main__":
    unittest.main()
