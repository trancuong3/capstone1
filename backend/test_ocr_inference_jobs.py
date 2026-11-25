from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
import unittest
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import httpx
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.models import (
    Book,
    BookPage,
    OcrInferenceJob,
    OcrWorkerHeartbeat,
    PageRevision,
    PageRevisionWord,
    ParentBookPageSubmission,
)
from app.services.admin_ocr_service import AdminOcrService
from app.services.ocr_inference_job_service import (
    JOB_KIND_ADMIN_REPROCESS,
    JOB_KIND_ADMIN_UPLOAD,
    JOB_KIND_LOCAL_SCAN,
    JOB_KIND_PARENT_SUBMISSION,
    PRIORITY_ADMIN_OCR,
    PRIORITY_LOCAL_SCAN,
    PRIORITY_PARENT_SUBMISSION,
    OcrInferenceJobService,
    compute_candidate_hash,
    run_parent_submission_post_ocr,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_TOKEN = "ocr-worker-staging-test-token-0123456789abcdef"


def _resolve_col_val(row: Any, col_expr: Any) -> Any:
    col_key = getattr(col_expr, "key", None) or getattr(col_expr, "name", None)
    val = getattr(row, col_key, None) if col_key else None
    if val is None and col_key is not None and hasattr(row, "__mapper__"):
        for attr in row.__mapper__.attrs:
            cols = getattr(attr, "columns", ())
            if cols and cols[0].name == col_key:
                return getattr(row, attr.key, None)
    return val


def _eval_clause(row: Any, expr: Any) -> bool:
    """Evaluate basic SQLAlchemy BinaryExpression / BooleanClauseList predicates in memory."""
    cls_name = type(expr).__name__
    if cls_name == "BooleanClauseList":
        op_name = getattr(expr.operator, "__name__", "")
        sub_results = [_eval_clause(row, c) for c in expr.clauses]
        return any(sub_results) if "or" in op_name else all(sub_results)
    if cls_name == "Grouping":
        return _eval_clause(row, expr.element)

    left = getattr(expr, "left", None)
    right = getattr(expr, "right", None)
    op = getattr(expr, "operator", None)
    op_name = getattr(op, "__name__", str(op))
    if left is None:
        return True

    val = _resolve_col_val(row, left)

    if right is None or type(right).__name__ == "Null":
        return val is None if "is_" in op_name and "not" not in op_name else val is not None

    if hasattr(right, "table") or "Column" in type(right).__name__:
        rhs_val = _resolve_col_val(row, right)
    else:
        rhs_val = getattr(right, "value", getattr(right, "element", right))
        if hasattr(right, "effective_value"):
            rhs_val = right.effective_value

    if op_name in ("is_", "is"):
        return val is rhs_val
    if op_name in ("is_not", "isnot"):
        return val is not rhs_val
    if op_name in ("in_op", "in"):
        return val in rhs_val
    if op_name in ("not_in_op", "notin_op"):
        return val not in rhs_val
    if op_name == "eq":
        return val == rhs_val
    if op_name == "ne":
        return val != rhs_val
    if op_name == "lt":
        return val is not None and rhs_val is not None and val < rhs_val
    if op_name == "le":
        return val is not None and rhs_val is not None and val <= rhs_val
    if op_name == "gt":
        return val is not None and rhs_val is not None and val > rhs_val
    if op_name == "ge":
        return val is not None and rhs_val is not None and val >= rhs_val
    return True


@dataclass
class InMemoryDbState:
    tables: dict[type, list[Any]] = field(
        default_factory=lambda: {
            OcrInferenceJob: [],
            OcrWorkerHeartbeat: [],
            ParentBookPageSubmission: [],
            Book: [],
            BookPage: [],
            PageRevision: [],
            PageRevisionWord: [],
        }
    )
    roles: dict[UUID, str] = field(default_factory=dict)
    active_model_pointer: dict[str, Any] | None = None


class _FakeScalarResult:
    def __init__(self, items: list[Any]):
        self._items = items

    def all(self) -> list[Any]:
        return list(self._items)

    def first(self) -> Any | None:
        return self._items[0] if self._items else None


class _FakeExecuteResult:
    def __init__(self, rows: list[Any]):
        self._rows = rows

    def all(self) -> list[Any]:
        return list(self._rows)

    def first(self) -> Any | None:
        return self._rows[0] if self._rows else None

    def mappings(self) -> _FakeExecuteResult:
        return self

    def scalars(self) -> _FakeScalarResult:
        return _FakeScalarResult(self._rows)


class FakeAsyncSession:
    """Transactional in-memory AsyncSession emulator for deterministic contract tests."""

    def __init__(self, state: InMemoryDbState):
        self.state = state
        self._pending_adds: list[Any] = []
        self._snapshots: dict[tuple[type, int], dict[str, Any]] = {}

    def _snapshot_obj(self, obj: Any) -> dict[str, Any]:
        return {
            attr.key: getattr(obj, attr.key)
            for attr in obj.__mapper__.attrs
        }

    def _ensure_snapshot(self, obj: Any) -> None:
        key = (type(obj), id(obj))
        if key not in self._snapshots and hasattr(obj, "__mapper__"):
            self._snapshots[key] = self._snapshot_obj(obj)

    def add(self, obj: Any) -> None:
        model_cls = type(obj)
        if getattr(obj, "Id", None) is None and hasattr(model_cls, "Id"):
            obj.Id = uuid4()
        now = datetime.now(timezone.utc)
        if hasattr(obj, "CreatedAt") and getattr(obj, "CreatedAt", None) is None:
            obj.CreatedAt = now
        if hasattr(obj, "UpdatedAt") and getattr(obj, "UpdatedAt", None) is None:
            obj.UpdatedAt = now
        if hasattr(model_cls, "__mapper__"):
            for attr in model_cls.__mapper__.attrs:
                if hasattr(attr, "columns") and attr.columns:
                    col = attr.columns[0]
                    if getattr(obj, attr.key, None) is None and col.default is not None:
                        arg = getattr(col.default, "arg", None)
                        if arg is not None and not callable(arg):
                            setattr(obj, attr.key, arg() if isinstance(arg, (list, dict)) else arg)
        self.state.tables.setdefault(model_cls, []).append(obj)
        self._pending_adds.append(obj)

    def add_all(self, objs: list[Any]) -> None:
        for obj in objs:
            self.add(obj)

    async def flush(self) -> None:
        for obj in self.state.tables.get(OcrInferenceJob, []):
            self._ensure_snapshot(obj)

    async def commit(self) -> None:
        self._pending_adds.clear()
        self._snapshots.clear()

    async def rollback(self) -> None:
        for obj in self._pending_adds:
            lst = self.state.tables.get(type(obj), [])
            if obj in lst:
                lst.remove(obj)
        self._pending_adds.clear()
        for (_, _), snap in list(self._snapshots.items()):
            # Find live object
            pass
        for (cls, obj_id), snap in self._snapshots.items():
            for live in self.state.tables.get(cls, []):
                if id(live) == obj_id:
                    for k, v in snap.items():
                        setattr(live, k, v)
                    break
        self._snapshots.clear()

    async def refresh(self, _obj: Any) -> None:
        return None

    async def scalar(self, query: Any) -> Any | None:
        rows = (await self.scalars(query)).all()
        return rows[0] if rows else None

    async def scalars(self, query: Any) -> _FakeScalarResult:
        if hasattr(query, "column_descriptions"):
            desc = query.column_descriptions[0]
            model_cls = desc.get("entity")
            if model_cls is None:
                # Single-column scalar select (e.g. select(PageRevision.Id))
                col = desc.get("expr")
                table_name = getattr(getattr(col, "table", None), "name", None)
                target_cls = next(
                    (c for c in self.state.tables if getattr(c, "__tablename__", None) == table_name),
                    None,
                )
                rows = list(self.state.tables.get(target_cls, [])) if target_cls else []
                for crit in getattr(query, "_where_criteria", ()):
                    rows = [r for r in rows if _eval_clause(r, crit)]
                self._apply_ordering(rows, query)
                limit_val = getattr(query, "_limit_clause", None)
                if limit_val is not None and getattr(limit_val, "value", None) is not None:
                    rows = rows[: int(limit_val.value)]
                attr_key = col.key
                return _FakeScalarResult([getattr(r, attr_key) for r in rows])

            rows = list(self.state.tables.get(model_cls, []))
            for crit in getattr(query, "_where_criteria", ()):
                rows = [r for r in rows if _eval_clause(r, crit)]
            self._apply_ordering(rows, query)
            limit_val = getattr(query, "_limit_clause", None)
            if limit_val is not None and getattr(limit_val, "value", None) is not None:
                rows = rows[: int(limit_val.value)]
            for r in rows:
                self._ensure_snapshot(r)
            return _FakeScalarResult(rows)
        return _FakeScalarResult([])

    def _apply_ordering(self, rows: list[Any], query: Any) -> None:
        order_clauses = list(getattr(query, "_order_by_clauses", ()))
        for clause in reversed(order_clauses):
            modifier = getattr(clause, "modifier", None)
            desc = modifier is not None and "desc" in getattr(modifier, "__name__", "").lower()
            elem = getattr(clause, "element", clause)
            rows.sort(
                key=lambda r, el=elem: (
                    _resolve_col_val(r, el) is None,
                    str(_resolve_col_val(r, el))
                    if isinstance(_resolve_col_val(r, el), UUID)
                    else (_resolve_col_val(r, el) if _resolve_col_val(r, el) is not None else ""),
                ),
                reverse=desc,
            )

    async def execute(self, stmt: Any, *_args: Any, **_kwargs: Any) -> _FakeExecuteResult:
        sql_text = str(stmt)
        if "viread_ocr_active_model" in sql_text:
            ptr = self.state.active_model_pointer
            return _FakeExecuteResult([ptr] if ptr else [])
        if "SELECT profile" in sql_text or "FROM profiles" in sql_text:
            return _FakeExecuteResult([])
        if hasattr(stmt, "column_descriptions"):
            descs = stmt.column_descriptions
            # Handle GROUP BY status count query in queue_depth_counts
            if len(descs) == 2 and str(descs[1].get("name")) == "count":
                rows = list(self.state.tables.get(OcrInferenceJob, []))
                counts: dict[str, int] = {}
                for r in rows:
                    counts[r.Status] = counts.get(r.Status, 0) + 1
                return _FakeExecuteResult(list(counts.items()))
        return _FakeExecuteResult([])

    async def delete(self, obj: Any) -> None:
        lst = self.state.tables.get(type(obj), [])
        if obj in lst:
            lst.remove(obj)


class _DummySessionCtx:
    def __init__(self, state: InMemoryDbState):
        self._state = state
        self._session: FakeAsyncSession | None = None

    async def __aenter__(self) -> FakeAsyncSession:
        self._session = FakeAsyncSession(self._state)
        return self._session

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None and self._session is not None:
            await self._session.rollback()


def _sample_words(texts: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "word_index": idx,
            "line_index": 0,
            "text": tok,
            "bbox": [10.0 * idx, 10.0, 24.0, 16.0],
            "ocr_confidence": 0.96,
            "ocr_review_status": "trusted",
            "ocr_score_source": "ocr_calibrated_word_accuracy_v1",
        }
        for idx, tok in enumerate(texts)
    ]


class TestOcrInferenceJobsAndResilience(unittest.TestCase):
    def setUp(self) -> None:
        self.state = InMemoryDbState()
        self.db = FakeAsyncSession(self.state)
        self.admin_id = uuid4()
        self.family_a = uuid4()
        self.family_b = uuid4()
        self.state.roles[self.admin_id] = "admin"
        self.state.roles[self.family_a] = "parent"
        self.state.roles[self.family_b] = "parent"
        self._signed_url_patcher = patch(
            "app.services.ocr_inference_job_service.storage_service.create_signed_image_url",
            return_value="https://signed.example/mock-source.png",
        )
        self._signed_url_patcher.start()
        self.addCleanup(self._signed_url_patcher.stop)

    def _svc(self) -> OcrInferenceJobService:
        return OcrInferenceJobService(self.db)  # type: ignore[arg-type]

    def test_internal_worker_token_constant_time_auth_contract(self):
        import app.sever as sever_mod

        async def _fake_get_db():
            yield FakeAsyncSession(self.state)

        sever_mod.app.dependency_overrides[get_db] = _fake_get_db
        try:
            client = TestClient(sever_mod.app)
            with patch.dict(os.environ, {"VIREAD_OCR_WORKER_TOKEN": ""}, clear=False):
                r_unconfigured = client.post(
                    "/internal/ocr-jobs/claim",
                    json={"worker_id": "w1"},
                )
                self.assertEqual(r_unconfigured.status_code, 503)

            with patch.dict(os.environ, {"VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN}, clear=False):
                r_missing = client.post("/internal/ocr-jobs/claim", json={"worker_id": "w1"})
                self.assertEqual(r_missing.status_code, 401)

                r_wrong = client.post(
                    "/internal/ocr-jobs/claim",
                    json={"worker_id": "w1"},
                    headers={"X-ViRead-Ocr-Worker-Token": "x" * 40},
                )
                self.assertEqual(r_wrong.status_code, 401)

                r_ok = client.post(
                    "/internal/ocr-jobs/claim",
                    json={"worker_id": "w1"},
                    headers={"X-ViRead-Ocr-Worker-Token": WORKER_TOKEN},
                )
                self.assertEqual(r_ok.status_code, 200)
                self.assertEqual(r_ok.json(), {"job": None})
        finally:
            sever_mod.app.dependency_overrides.clear()

    def test_priority_claim_lease_reclaim_fencing_and_idempotency(self):
        async def _scenario() -> None:
            svc = self._svc()
            img_sha = hashlib.sha256(b"page-bytes").hexdigest()

            j_parent = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=self.family_a,
                submission_id=uuid4(),
                image_path="p/1.png",
                image_sha256=img_sha,
                priority=PRIORITY_PARENT_SUBMISSION,
                idempotency_key="idem-parent-1",
            )
            j_parent_dup = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=self.family_a,
                submission_id=j_parent.SubmissionId,
                image_path="p/1.png",
                image_sha256=img_sha,
                priority=PRIORITY_PARENT_SUBMISSION,
                idempotency_key="idem-parent-1",
            )
            self.assertEqual(j_parent_dup.Id, j_parent.Id)

            # Different family using same raw key does not collide, AND same family + diff SHA rejects 409.
            with self.assertRaises(Exception) as conflict_ctx:
                await svc.enqueue_job(
                    job_kind=JOB_KIND_PARENT_SUBMISSION,
                    owner_user_id=self.family_a,
                    submission_id=uuid4(),
                    image_path="p/2.png",
                    image_sha256=hashlib.sha256(b"other").hexdigest(),
                    priority=PRIORITY_PARENT_SUBMISSION,
                    idempotency_key="idem-parent-1",
                )
            self.assertEqual(getattr(conflict_ctx.exception, "status_code", None), 409)

            j_scan = await svc.enqueue_job(
                job_kind=JOB_KIND_LOCAL_SCAN,
                owner_user_id=self.family_b,
                local_scan_request_id="scan-1",
                image_path="s/1.png",
                image_sha256=img_sha,
                priority=PRIORITY_LOCAL_SCAN,
            )
            j_admin = await svc.enqueue_job(
                job_kind=JOB_KIND_ADMIN_UPLOAD,
                owner_user_id=self.admin_id,
                book_id=uuid4(),
                page_id=uuid4(),
                image_path="a/1.png",
                image_sha256=img_sha,
                priority=PRIORITY_ADMIN_OCR,
            )
            await self.db.commit()

            # Priority order: LOCAL_PAGE_SCAN (10) -> ADMIN (20) -> PARENT (50)
            c1 = await svc.claim_next_job(worker_id="w1", lease_seconds=60)
            self.assertEqual(c1["job_id"], str(j_scan.Id))
            self.assertEqual(c1["fencing_token"], 1)

            # Simulate lease expiry (crash of w1 before complete!)
            j_scan.LeaseExpiresAt = datetime.now(timezone.utc) - timedelta(seconds=5)
            await self.db.commit()

            # Reclaim bumps fencing_token=2
            c_reclaim = await svc.claim_next_job(worker_id="w2", lease_seconds=60)
            self.assertEqual(c_reclaim["job_id"], str(j_scan.Id))
            self.assertEqual(c_reclaim["fencing_token"], 2)

            # Stale worker w1 with fencing_token=1 MUST be rejected 409
            with self.assertRaises(Exception) as stale_ctx:
                await svc.complete_job(
                    job_id=j_scan.Id,
                    worker_id="w1",
                    fencing_token=1,
                    source_sha256=img_sha,
                    full_text="Trang một",
                    words=_sample_words(["Trang", "một"]),
                    ocr_meta={},
                    no_text_detected=False,
                    model_profile="FLOW1_EXTERNAL_TRDG",
                    model_sha256="2" * 64,
                    engine_diagnostics={},
                    duration_ms=100,
                    schedule_post_ocr=False,
                )
            self.assertEqual(getattr(stale_ctx.exception, "status_code", None), 409)

            # Active worker w2 with fencing_token=2 succeeds + idempotent replay succeeds
            done = await svc.complete_job(
                job_id=j_scan.Id,
                worker_id="w2",
                fencing_token=2,
                source_sha256=img_sha,
                full_text="Trang một",
                words=_sample_words(["Trang", "một"]),
                ocr_meta={"runtime_device": "cpu"},
                no_text_detected=False,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engine_diagnostics={},
                duration_ms=120,
                schedule_post_ocr=False,
            )
            self.assertEqual(done["status"], "SUCCEEDED")
            self.assertFalse(done["idempotent_replay"])

            replay = await svc.complete_job(
                job_id=j_scan.Id,
                worker_id="w2",
                fencing_token=2,
                source_sha256=img_sha,
                full_text="Trang một",
                words=_sample_words(["Trang", "một"]),
                ocr_meta={},
                no_text_detected=False,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engine_diagnostics={},
                duration_ms=120,
                schedule_post_ocr=False,
            )
            self.assertTrue(replay["idempotent_replay"])

            c2 = await svc.claim_next_job(worker_id="w1", lease_seconds=60)
            self.assertEqual(c2["job_id"], str(j_admin.Id))

        asyncio.run(_scenario())

    def test_admin_mid_job_edit_cancels_and_rejects_stale_worker_completion(self):
        async def _scenario() -> None:
            book_id = uuid4()
            page_id = uuid4()
            verified_id = uuid4()
            img_path = f"books/{book_id}/pages/{page_id}/p1.png"
            img_sha = hashlib.sha256(b"admin-page-1").hexdigest()

            book = Book(
                Id=book_id,
                Title="Truyện Cổ Tích",
                MinGrade=1,
                MaxGrade=3,
                LifecycleStatus="ACTIVE",
            )
            page = BookPage(
                Id=page_id,
                BookId=book_id,
                PageNumber=1,
                ImagePath=img_path,
                Width=800,
                Height=1000,
                LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=verified_id,
            )
            verified_rev = PageRevision(
                Id=verified_id,
                PageId=page_id,
                RevisionNo="1",
                VerificationStatus="VERIFIED",
                OriginalOcrText="Ngày xửa",
                VerifiedText="Ngày xửa",
                DraftText="Ngày xửa",
                ContentHash="h1",
                ProcessingMeta={"source_image_path": img_path},
            )
            self.db.add_all([book, page, verified_rev])
            await self.db.commit()

            svc = self._svc()
            job = await svc.enqueue_job(
                job_kind=JOB_KIND_ADMIN_REPROCESS,
                owner_user_id=self.admin_id,
                book_id=book_id,
                page_id=page_id,
                image_path=img_path,
                image_sha256=img_sha,
                priority=PRIORITY_ADMIN_OCR,
                expected_verified_revision_id=verified_id,
                expected_latest_revision_id=verified_id,
                processing_meta={"expected_page_image_path": img_path},
            )
            await self.db.commit()

            claim = await svc.claim_next_job(worker_id="win-ocr-1", lease_seconds=60)
            self.assertEqual(claim["job_id"], str(job.Id))

            # Admin concurrently saves a new edit revision while OCR is running.
            admin_edit_rev = PageRevision(
                Id=uuid4(),
                PageId=page_id,
                RevisionNo="2",
                VerificationStatus="NEEDS_REVIEW",
                OriginalOcrText="Ngày xửa",
                DraftText="Ngày xửa ngày xưa",
                ContentHash="h2",
            )
            self.db.add(admin_edit_rev)
            await svc.cancel_for_page(page_id, reason="SUPERSEDED_BY_ADMIN_EDIT_DRAFT")
            await self.db.commit()

            # Worker heartbeat detects cancellation immediately
            hb = await svc.heartbeat_job(
                job_id=job.Id,
                worker_id="win-ocr-1",
                fencing_token=claim["fencing_token"],
            )
            self.assertTrue(hb["cancelled"])

            # Even if worker finishes concurrently and attempts /complete, it MUST be rejected 409!
            with self.assertRaises(Exception) as exc_ctx:
                await svc.complete_job(
                    job_id=job.Id,
                    worker_id="win-ocr-1",
                    fencing_token=claim["fencing_token"],
                    source_sha256=img_sha,
                    full_text="Ngày xưa cũ",
                    words=_sample_words(["Ngày", "xưa", "cũ"]),
                    ocr_meta={},
                    no_text_detected=False,
                    model_profile="FLOW1_EXTERNAL_TRDG",
                    model_sha256="2" * 64,
                    engine_diagnostics={},
                    duration_ms=200,
                )
            self.assertEqual(getattr(exc_ctx.exception, "status_code", None), 409)
            # Admin's revision remains untouched (count stays 2).
            self.assertEqual(len(self.state.tables[PageRevision]), 2)

        asyncio.run(_scenario())

    def test_30_page_book_partial_isolation_single_retry_and_fail_closed_ai(self):
        async def _scenario() -> None:
            book_id = uuid4()
            book = Book(
                Id=book_id,
                Title="Sách Ba Mươi Trang",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="PRIVATE_PARENT",
                OwnerParentId=self.family_a,
            )
            self.db.add(book)

            submissions: dict[int, ParentBookPageSubmission] = {}
            jobs_by_page: dict[int, OcrInferenceJob] = {}
            svc = self._svc()
            batch_id = uuid4()

            for page_no in range(1, 31):
                sub_id = uuid4()
                sha = hashlib.sha256(f"img-{page_no}".encode()).hexdigest()
                sub = ParentBookPageSubmission(
                    Id=sub_id,
                    BookId=book_id,
                    OwnerParentId=self.family_a,
                    BatchId=batch_id,
                    BatchTotalPages=30,
                    SourcePageNumber=page_no,
                    IdempotencyKey=f"batch-p{page_no}",
                    SourceFileName=f"page_{page_no}.png",
                    SourceFormat="IMAGE",
                    SourceStoragePath=f"private/{book_id}/p{page_no}.png",
                    SourceSha256=sha,
                    ImageWidth=800,
                    ImageHeight=1000,
                    SubmissionVersion=1,
                    OptimisticLockVersion=1,
                    WorkflowStatus="CHECKING",
                    OcrStatus="PENDING",
                    ProofreadStatus="PENDING",
                    ToolCheckStatus="PENDING",
                )
                self.db.add(sub)
                submissions[page_no] = sub
                job = await svc.enqueue_job(
                    job_kind=JOB_KIND_PARENT_SUBMISSION,
                    owner_user_id=self.family_a,
                    book_id=book_id,
                    submission_id=sub_id,
                    image_path=sub.SourceStoragePath,
                    image_sha256=sha,
                    priority=PRIORITY_PARENT_SUBMISSION,
                    expected_version=1,
                    expected_candidate_hash=None,
                    max_attempts=2,
                )
                jobs_by_page[page_no] = job
            await self.db.commit()

            # Page 7 fails retries and dead-letters -> CHECK_FAILED independently
            j7 = jobs_by_page[7]
            j7.Priority = 1
            for attempt_idx in range(2):
                c7 = await svc.claim_next_job(worker_id="w-ocr", lease_seconds=60)
                self.assertEqual(c7["job_id"], str(j7.Id))
                fail_res = await svc.fail_job(
                    job_id=j7.Id,
                    worker_id="w-ocr",
                    fencing_token=c7["fencing_token"],
                    error_code="TRANSIENT_GPU_OOM" if attempt_idx == 0 else "PERSISTENT_CORRUPT_DECODE",
                    retryable=(attempt_idx == 0),
                )
                if attempt_idx == 0:
                    j7.NextRetryAt = datetime.now(timezone.utc) - timedelta(seconds=1)
                else:
                    self.assertEqual(fail_res["status"], "DEAD_LETTER")

            self.assertEqual(submissions[7].WorkflowStatus, "CHECK_FAILED")
            self.assertEqual(submissions[7].OcrStatus, "FAILED")

            # Page 12 succeeds Stage 1 -> Stage 2 -> Stage 3 finds an issue -> NEEDS_ADMIN_REVIEW!
            j12 = jobs_by_page[12]
            j12.Priority = 2
            c12 = await svc.claim_next_job(worker_id="w-ocr", lease_seconds=60)
            self.assertEqual(c12["job_id"], str(j12.Id))
            await svc.complete_job(
                job_id=j12.Id,
                worker_id="w-ocr",
                fencing_token=c12["fencing_token"],
                source_sha256=submissions[12].SourceSha256,
                full_text="Trang mười hai nội dung cần xem xét",
                words=_sample_words(["Trang", "mười", "hai", "nội", "dung", "cần", "xem", "xét"]),
                ocr_meta={},
                no_text_detected=False,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engine_diagnostics={},
                duration_ms=150,
                schedule_post_ocr=False,
            )

            class _OkProofread:
                async def correct(self, text, image_bytes, word_boxes, **kwargs):
                    return text

            class _FlaggingSafety:
                async def analyze(self, text):
                    return {
                        "suitability": "REVIEW_REQUIRED",
                        "findings": [{"category": "TONE", "excerpt": "cần xem xét", "severity": "MEDIUM"}],
                        "provider_events": [],
                    }

            with patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                side_effect=lambda: _DummySessionCtx(self.state),
            ):
                stage12 = await run_parent_submission_post_ocr(
                    submissions[12].Id,
                    proofread_orchestrator=_OkProofread(),
                    safety_orchestrator=_FlaggingSafety(),
                    download_bytes=lambda _p: b"fake-bytes"
                    if hashlib.sha256(b"fake-bytes").hexdigest() == submissions[12].SourceSha256
                    else f"img-12".encode(),
                )
            self.assertEqual(stage12["status"], "NEEDS_ADMIN_REVIEW")
            self.assertEqual(submissions[7].WorkflowStatus, "CHECK_FAILED")
            self.assertEqual(submissions[12].WorkflowStatus, "NEEDS_ADMIN_REVIEW")

            # Verify fail-closed when Ollama safety throws timeout/bad JSON on Page 10!
            sub10 = submissions[10]
            j10 = jobs_by_page[10]
            j10.Priority = 3
            c10 = await svc.claim_next_job(worker_id="w-ocr", lease_seconds=60)
            self.assertEqual(c10["job_id"], str(j10.Id))
            await svc.complete_job(
                job_id=j10.Id,
                worker_id="w-ocr",
                fencing_token=c10["fencing_token"],
                source_sha256=sub10.SourceSha256,
                full_text="Trang mười kiểm tra lỗi",
                words=_sample_words(["Trang", "mười", "kiểm", "tra", "lỗi"]),
                ocr_meta={},
                no_text_detected=False,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engine_diagnostics={},
                duration_ms=100,
                schedule_post_ocr=False,
            )

            class _BrokenSafety:
                async def analyze(self, text):
                    raise TimeoutError("Ollama request timed out")

            with patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                side_effect=lambda: _DummySessionCtx(self.state),
            ):
                stage10 = await run_parent_submission_post_ocr(
                    sub10.Id,
                    proofread_orchestrator=_OkProofread(),
                    safety_orchestrator=_BrokenSafety(),
                    download_bytes=lambda _p: b"img-10",
                )
            self.assertEqual(stage10["status"], "CHECK_FAILED")
            self.assertEqual(sub10.WorkflowStatus, "CHECK_FAILED")
            self.assertIsNone(sub10.ToolCheckSuitability)
            self.assertNotEqual(sub10.WorkflowStatus, "PASSED_READY_TO_ADD")

            # Single-page retry on Page 7 -> clean SUITABLE -> PASSED_READY_TO_ADD!
            sub7 = submissions[7]
            sub7.WorkflowStatus = "CHECKING"
            sub7.OcrStatus = "PENDING"
            sub7.OcrErrorCode = None
            sub7.ProofreadStatus = "PENDING"
            sub7.ToolCheckStatus = "PENDING"
            sub7.OptimisticLockVersion = 2
            j7_retry = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=self.family_a,
                book_id=book_id,
                submission_id=sub7.Id,
                image_path=sub7.SourceStoragePath,
                image_sha256=sub7.SourceSha256,
                priority=1,
                expected_version=sub7.SubmissionVersion,
                expected_candidate_hash=sub7.CandidateHash,
            )
            await self.db.commit()
            c7_r = await svc.claim_next_job(worker_id="w-ocr", lease_seconds=60)
            self.assertEqual(c7_r["job_id"], str(j7_retry.Id))
            await svc.complete_job(
                job_id=j7_retry.Id,
                worker_id="w-ocr",
                fencing_token=c7_r["fencing_token"],
                source_sha256=sub7.SourceSha256,
                full_text="Con mèo trèo cây cau",
                words=_sample_words(["Con", "mèo", "trèo", "cây", "cau"]),
                ocr_meta={},
                no_text_detected=False,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engine_diagnostics={},
                duration_ms=90,
                schedule_post_ocr=False,
            )

            class _CleanSafety:
                async def analyze(self, text):
                    return {"suitability": "SUITABLE", "findings": [], "provider_events": []}

            with patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                side_effect=lambda: _DummySessionCtx(self.state),
            ):
                stage7 = await run_parent_submission_post_ocr(
                    sub7.Id,
                    proofread_orchestrator=_OkProofread(),
                    safety_orchestrator=_CleanSafety(),
                    download_bytes=lambda _p: b"img-7",
                )
            self.assertEqual(stage7["status"], "PASSED_READY_TO_ADD")
            self.assertEqual(sub7.WorkflowStatus, "PASSED_READY_TO_ADD")
            self.assertEqual(sub7.ToolCheckStatus, "PASSED")
            self.assertEqual(sub7.ToolCheckSuitability, "SUITABLE")
            self.assertEqual(sub7.ToolCheckInputHash, sub7.CandidateHash)
            self.assertEqual(
                sub7.CandidateHash,
                compute_candidate_hash(
                    "Con mèo trèo cây cau", source_sha256=sub7.SourceSha256, is_image_only=False
                ),
            )

        asyncio.run(_scenario())

    def test_cross_family_isolation_and_admin_rbac(self):
        import app.sever as sever_mod

        book_a_id = uuid4()
        sub_a_id = uuid4()
        book_a = Book(
            Id=book_a_id,
            Title="Gia Đình A",
            MinGrade=1,
            MaxGrade=2,
            LifecycleStatus="ACTIVE",
            VisibilityScope="PRIVATE_PARENT",
            OwnerParentId=self.family_a,
        )
        sub_a = ParentBookPageSubmission(
            Id=sub_a_id,
            BookId=book_a_id,
            OwnerParentId=self.family_a,
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            IdempotencyKey="k1",
            SourceFileName="p1.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private/a.png",
            SourceSha256="a" * 64,
            ImageWidth=400,
            ImageHeight=500,
            WorkflowStatus="CHECKING",
        )
        self.db.add_all([book_a, sub_a])

        active_actor = self.family_b

        async def _fake_get_db():
            yield FakeAsyncSession(self.state)

        async def _fake_actor():
            return active_actor

        sever_mod.app.dependency_overrides[get_db] = _fake_get_db
        sever_mod.app.dependency_overrides[get_current_parent_id] = _fake_actor
        try:
            client = TestClient(sever_mod.app)
            with (
                patch(
                    "app.repositories.parent_private_book_repository.ParentPrivateBookRepository.role",
                    AsyncMock(return_value="parent"),
                ),
                patch(
                    "app.repositories.parent_private_book_repository.ParentPrivateBookRepository.get_owned_private_book",
                    AsyncMock(return_value=None),
                ),
                patch(
                    "app.repositories.admin_ocr_repository.AdminOcrRepository.role",
                    AsyncMock(return_value="parent"),
                ),
            ):
                # Family B cannot inspect Family A's submission job status (404 isolation)
                r_cross = client.get(
                    f"/books/my-books/{book_a_id}/submissions/{sub_a_id}/ocr-job"
                )
                self.assertEqual(r_cross.status_code, 404)

                # Non-admin parent cannot inspect admin OCR jobs (403 RBAC)
                r_admin = client.get(f"/books/admin/catalog/{book_a_id}/ocr-jobs")
                self.assertEqual(r_admin.status_code, 403)
        finally:
            sever_mod.app.dependency_overrides.clear()

    def test_remote_offline_fails_sync_503_while_parent_queues_durably(self):
        async def _scenario() -> None:
            svc = self._svc()
            # No worker heartbeats -> offline
            self.assertFalse(await svc.has_online_worker())

            admin_svc = AdminOcrService(self.db)  # type: ignore[arg-type]
            with self.assertRaises(Exception) as exc_ctx:
                await admin_svc._ingest_via_remote_worker(
                    actor_id=self.admin_id,
                    book_id=uuid4(),
                    page_id=uuid4(),
                    object_path="books/b/pages/p/x.png",
                    image_digest="b" * 64,
                    content_type="image/png",
                    width=400,
                    height=500,
                    upload_id=None,
                    started_at=0.0,
                )
            self.assertIn("offline", str(exc_ctx.exception).lower())

            # Async worker heartbeat brings sync online check up!
            await svc.record_worker_heartbeat(
                worker_id="win-ocr-1",
                hostname="WIN-LAPTOP",
                app_version="1.0.0",
                git_sha="abc123",
                status_value="IDLE",
                active_job_id=None,
                active_job_count=0,
                concurrency_limit=1,
                model_profile="FLOW1_EXTERNAL_TRDG",
                model_sha256="2" * 64,
                engines={
                    "paddleocr": {"status": "HEALTHY", "detail_status": "inference_verified", "loaded": True, "inference_verified": True},
                    "vietocr": {"status": "HEALTHY", "detail_status": "inference_verified", "loaded": True, "inference_verified": True},
                },
                system_stats={"ram_total_mb": 16384},
                last_error=None,
            )
            self.assertTrue(await svc.has_online_worker())

        asyncio.run(_scenario())

    def test_migration_sql_rls_constraints_and_indexes_present(self):
        sql = (
            REPO_ROOT / "supabase" / "migrations" / "20261124010000_ocr_inference_jobs.sql"
        ).read_text(encoding="utf-8")
        self.assertIn("CREATE TABLE IF NOT EXISTS public.ocr_inference_jobs", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.ocr_worker_heartbeats", sql)
        self.assertIn("ENABLE ROW LEVEL SECURITY", sql)
        self.assertIn("REVOKE ALL ON TABLE public.ocr_inference_jobs FROM PUBLIC, anon, authenticated", sql)
        self.assertIn("GRANT ALL ON TABLE public.ocr_inference_jobs TO service_role", sql)
        self.assertIn("idx_ocr_inference_jobs_claim_queue", sql)
        self.assertIn("uq_ocr_inference_jobs_idempotency", sql)
        self.assertIn("fencing_token BIGINT", sql)

    def test_worker_words_and_aligned_boxes_satisfy_parent_and_admin_contracts(self):
        from app.services.ocr_inference_job_service import (
            _normalize_worker_words,
            align_edited_text_to_words,
        )
        from app.services.parent_private_book_service import _coerce_word_bounding_box
        from app.services.reading_content_service import ReadingContentService

        raw_worker = [
            {
                "word_index": 0,
                "line_index": 0,
                "text": "Sáng",
                "bbox": [0.1, 0.1, 0.14, 0.06],
                "ocr_confidence": 0.97,
                "ocr_review_status": "matched",
                "ocr_score_source": "ocr_calibrated_word_accuracy_v1",
                "ocr_evidence": {
                    "contract": "hybrid_ocr_evidence_v4",
                    "selected_engine": "vietocr",
                    "engine_outputs": {"paddleocr": "Sáng", "vietocr": "Sáng", "tesseract": "Sáng"},
                    "bbox_quality": "valid",
                    "crop_quality": "usable",
                },
            },
            {
                "word_index": 1,
                "line_index": 0,
                "text": "sớm",
                "bbox": [0.28, 0.1, 0.14, 0.06],
                "ocr_confidence": 0.95,
            },
        ]
        normalized = _normalize_worker_words(raw_worker)
        self.assertEqual(len(normalized), 2)
        for item in normalized:
            self.assertIsInstance(item["bbox"], list)
            self.assertEqual(item["bbox"], item["bounding_box"])
            self.assertIsNotNone(ReadingContentService._valid_bbox(item["bounding_box"]))
        self.assertEqual(normalized[0]["ocr_evidence"]["selected_engine"], "vietocr")

        # AdminOcrService._word_data must accept normalized worker words directly.
        admin_words = AdminOcrService._word_data(normalized)
        self.assertEqual(len(admin_words), 2)
        self.assertEqual(admin_words[0]["ocr_evidence"]["selected_engine"], "vietocr")

        # align_edited_text_to_words with inserted token + newline preserves canonical non-None boxes.
        aligned = align_edited_text_to_words("Sáng sớm\nđẹp", normalized)
        self.assertEqual(len(aligned), 3)
        self.assertEqual(aligned[2]["line_index"], 1)
        for idx, item in enumerate(aligned):
            self.assertIsInstance(item["bounding_box"], list)
            self.assertEqual(item["bbox"], item["bounding_box"])
            self.assertIsNotNone(ReadingContentService._valid_bbox(item["bounding_box"]))
            coerced = _coerce_word_bounding_box(item, idx, len(aligned))
            self.assertIsNotNone(ReadingContentService._valid_bbox(coerced))

        # Legacy dict-shaped bbox in staging DB rows also coerces cleanly to 4-float list.
        legacy_coerced = _coerce_word_bounding_box(
            {"text": "Mèo", "bbox": {"x": 0.1, "y": 0.2, "w": 0.12, "h": 0.05}},
            0,
            1,
        )
        self.assertEqual(legacy_coerced, [0.1, 0.2, 0.12, 0.05])
        self.assertIsNotNone(ReadingContentService._valid_bbox(legacy_coerced))

    def test_admin_system_health_reports_remote_ocr_worker_healthy(self):
        from unittest.mock import AsyncMock, MagicMock

        from app.api.routes.system import AdminSystemService
        from app.services.admin_ocr_local import LocalOcrConfig

        async def _scenario() -> None:
            repo = MagicMock()
            repo.probe_database = AsyncMock(return_value=True)
            voice = MagicMock()
            voice.probe_tts = AsyncMock(return_value=("HEALTHY", "Local TTS (VieNeu-TTS) đang sẵn sàng."))
            voice.probe_stt = AsyncMock(return_value=("HEALTHY", "Local STT (Sherpa-ONNX) đang sẵn sàng."))

            remote_payload = {
                "mode": "remote_worker",
                "ready": True,
                "heartbeat_ttl_seconds": 45,
                "engines": {
                    "paddleocr": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
                    "vietocr": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
                    "tesseract_vie": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
                },
                "workers": [
                    {
                        "worker_id": "win-ocr-c-test",
                        "hostname": "c",
                        "status": "IDLE",
                        "online": True,
                        "model_profile": "FLOW1_EXTERNAL_TRDG",
                        "engines": {},
                    }
                ],
                "queue": {},
            }
            running_mock = MagicMock()
            running_mock.done.return_value = False
            workers_arg = {
                "viread_ocr_outbox": None,
                "viread_ocr_training": None,
                "book_quality": running_mock,
                "admin_ai_workflow": running_mock,
                "parent_book_submission": None,
                "active_model_registry": None,
                "local_trainer_process": None,
            }

            with (
                patch("app.api.routes.system.is_remote_ocr_mode", return_value=True),
                patch("app.api.routes.system.collect_remote_ocr_health", new=AsyncMock(return_value=remote_payload)),
                patch("app.api.routes.system.LocalOcrConfig.from_environment", return_value=LocalOcrConfig()),
                patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock(return_value=("HEALTHY", "Local AI ready"))),
                patch(
                    "app.api.routes.system.probe_storage_health",
                    return_value={"id": "storage", "label": "Supabase Storage", "status": "HEALTHY", "detail_status": "healthy", "safe_message": "Storage OK"},
                ),
            ):
                health = await AdminSystemService(repo, voice).health(workers=workers_arg)

            # Honest reporting: disabled/unobserved workers are NEVER false-greened to HEALTHY
            self.assertEqual(health.overall_status, "DEGRADED")
            by_id = {item.id: item for item in health.services}
            self.assertEqual(by_id["paddleocr"].status, "HEALTHY")
            self.assertEqual(by_id["paddleocr"].detail_status, "healthy")
            self.assertIn("FLOW1_EXTERNAL_TRDG", by_id["paddleocr"].safe_message)
            self.assertEqual(by_id["vietocr"].status, "HEALTHY")
            self.assertEqual(by_id["tesseract"].status, "HEALTHY")
            self.assertEqual(by_id["tesseract_vie"].status, "HEALTHY")
            self.assertEqual(by_id["ocr_worker"].status, "HEALTHY")
            self.assertEqual(by_id["ocr_worker"].detail_status, "healthy")
            self.assertEqual(by_id["viread_ocr_outbox"].status, "DEGRADED")
            self.assertEqual(by_id["viread_ocr_outbox"].detail_status, "disabled")
            self.assertEqual(by_id["parent_book_submission"].status, "DEGRADED")
            self.assertEqual(by_id["parent_book_submission"].detail_status, "disabled")
            for expected_worker_id in (
                "ocr_worker",
                "parent_book_submission",
                "book_quality",
                "admin_ai_workflow",
                "viread_ocr_outbox",
                "viread_ocr_training",
                "reading_reminder",
                "reading_presence",
                "karaoke_processing",
                "active_model_registry",
            ):
                self.assertIn(expected_worker_id, by_id)

        asyncio.run(_scenario())

    def test_soft_delete_cancels_open_jobs_and_rejects_late_worker_completion_with_409(self) -> None:
        async def _scenario() -> None:
            state = InMemoryDbState()
            admin_id = uuid4()
            book_id = uuid4()
            page_id = uuid4()
            img_sha = "c" * 64
            state.tables[Book].append(
                Book(
                    Id=book_id,
                    Name="Sách thử",
                    Title="Sách thử",
                    Author="Tác giả",
                    MinGrade=1,
                    MaxGrade=3,
                    LifecycleStatus="ACTIVE",
                    VisibilityScope="CATALOG",
                    IsDeleted=False,
                    CreatedBy=admin_id,
                )
            )
            state.tables[BookPage].append(
                BookPage(
                    Id=page_id,
                    BookId=book_id,
                    PageNumber=1,
                    ImagePath="books/b/p1.png",
                    Width=800,
                    Height=1000,
                    LifecycleStatus="PROCESSING",
                    ProcessingMeta={},
                )
            )

            db = FakeAsyncSession(state)
            svc = OcrInferenceJobService(db)
            job = await svc.enqueue_job(
                job_kind=JOB_KIND_ADMIN_UPLOAD,
                owner_user_id=admin_id,
                book_id=book_id,
                page_id=page_id,
                image_path="books/b/p1.png",
                image_sha256=img_sha,
            )
            await db.commit()
            claimed = await svc.claim_next_job(worker_id="win-ocr-1")
            assert claimed is not None

            # Admin soft-deletes book while worker is mid-OCR
            state.tables[Book][0].IsDeleted = True
            state.tables[Book][0].DeletedAt = datetime.now(timezone.utc)
            cancelled = await svc.cancel_for_book(book_id, reason="BOOK_SOFT_DELETED")
            await db.commit()
            self.assertEqual(cancelled, 1)
            self.assertEqual(job.Status, "CANCELLED")
            self.assertEqual(job.CancelledReason, "BOOK_SOFT_DELETED")

            # Even if job hadn't been cancelled yet, _is_target_still_current catches IsDeleted
            still_ok, stale_reason = await svc._is_target_still_current(job)
            self.assertFalse(still_ok)
            self.assertEqual(stale_reason, "BOOK_SOFT_DELETED")

            from fastapi import HTTPException

            with self.assertRaises(HTTPException) as ctx:
                await svc.complete_job(
                    job_id=job.Id,
                    worker_id="win-ocr-1",
                    fencing_token=int(claimed["fencing_token"]),
                    source_sha256=img_sha,
                    full_text="Trang đã xóa",
                    words=[{"word_index": 0, "line_index": 0, "text": "Trang", "bbox": [0.1, 0.1, 0.2, 0.05]}],
                    ocr_meta={},
                    no_text_detected=False,
                    model_profile="ORIGINAL",
                    model_sha256="380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59",
                    engine_diagnostics={},
                    duration_ms=120,
                )
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(ctx.exception.detail["code"], "BOOK_SOFT_DELETED")
            self.assertEqual(len(state.tables[PageRevision]), 0)

        asyncio.run(_scenario())

    def test_enqueue_job_reuses_tenant_safe_sha256_cache_and_isolates_tenants_and_models(self) -> None:
        async def _scenario() -> None:
            state = InMemoryDbState()
            parent_a = uuid4()
            parent_b = uuid4()
            book_a = uuid4()
            book_b = uuid4()
            sub_a1 = uuid4()
            sub_a2 = uuid4()
            sub_b1 = uuid4()
            img_sha = "d" * 64
            model_sha_1 = "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
            model_sha_2 = "e" * 64

            for bid, owner in ((book_a, parent_a), (book_b, parent_b)):
                state.tables[Book].append(
                    Book(
                        Id=bid,
                        Name="Sách riêng",
                        Title="Sách riêng",
                        MinGrade=1,
                        MaxGrade=3,
                        LifecycleStatus="ACTIVE",
                        VisibilityScope="PARENT_PRIVATE",
                        OwnerParentId=owner,
                        ModerationStatus="ACTIVE",
                        IsDeleted=False,
                    )
                )
            for sid, bid, owner in (
                (sub_a1, book_a, parent_a),
                (sub_a2, book_a, parent_a),
                (sub_b1, book_b, parent_b),
            ):
                state.tables[ParentBookPageSubmission].append(
                    ParentBookPageSubmission(
                        Id=sid,
                        BookId=bid,
                        OwnerParentId=owner,
                        BatchId=uuid4(),
                        BatchTotalPages=1,
                        SourcePageNumber=1,
                        SourceStoragePath=f"private/{owner}/{sid}.png",
                        SourceSha256=img_sha,
                        ImageWidth=800,
                        ImageHeight=1000,
                        WorkflowStatus="CHECKING",
                        OcrStatus="PENDING",
                        ProofreadStatus="PENDING",
                        ToolCheckStatus="PENDING",
                        SubmissionVersion=1,
                        OptimisticLockVersion=1,
                        TempExpiresAt=datetime.now(timezone.utc) + timedelta(hours=1),
                    )
                )

            db = FakeAsyncSession(state)
            svc = OcrInferenceJobService(db)
            job1 = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=parent_a,
                book_id=book_a,
                submission_id=sub_a1,
                image_path=f"private/{parent_a}/{sub_a1}.png",
                image_sha256=img_sha,
                expected_version=1,
            )
            self.assertEqual(job1.Status, "QUEUED")
            claimed = await svc.claim_next_job(worker_id="win-ocr-1")
            assert claimed is not None
            await svc.complete_job(
                job_id=job1.Id,
                worker_id="win-ocr-1",
                fencing_token=int(claimed["fencing_token"]),
                source_sha256=img_sha,
                full_text="Con mèo",
                words=[
                    {"word_index": 0, "line_index": 0, "text": "Con", "bbox": [0.1, 0.1, 0.1, 0.05]},
                    {"word_index": 1, "line_index": 0, "text": "mèo", "bbox": [0.22, 0.1, 0.1, 0.05]},
                ],
                ocr_meta={"engine": "hybrid"},
                no_text_detected=False,
                model_profile="ORIGINAL",
                model_sha256=model_sha_1,
                engine_diagnostics={},
                duration_ms=410,
                schedule_post_ocr=False,
            )

            # Same tenant + same SHA-256 + same active model/config/pipeline -> 0 worker compute cache hit!
            job2 = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=parent_a,
                book_id=book_a,
                submission_id=sub_a2,
                image_path=f"private/{parent_a}/{sub_a2}.png",
                image_sha256=img_sha,
                expected_version=1,
            )
            self.assertEqual(job2.Status, "SUCCEEDED")
            self.assertEqual(job2.WorkerId, "ocr-cache")
            self.assertEqual(job2.DurationMs, 0)
            self.assertEqual(job2.ResultPayload["words"], job1.ResultPayload["words"])

            # Different tenant (Parent B) with same SHA-256 -> MUST NOT hit Parent A's cache!
            job_other_tenant = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=parent_b,
                book_id=book_b,
                submission_id=sub_b1,
                image_path=f"private/{parent_b}/{sub_b1}.png",
                image_sha256=img_sha,
                expected_version=1,
            )
            self.assertEqual(job_other_tenant.Status, "QUEUED")

            # Same tenant, different active model SHA -> MUST NOT hit old model cache!
            job_new_model = await svc.enqueue_job(
                job_kind=JOB_KIND_PARENT_SUBMISSION,
                owner_user_id=parent_a,
                book_id=book_a,
                submission_id=sub_a2,
                image_path=f"private/{parent_a}/{sub_a2}.png",
                image_sha256=img_sha,
                expected_version=1,
                processing_meta={"active_model_sha256": model_sha_2},
            )
            self.assertEqual(job_new_model.Status, "QUEUED")

        asyncio.run(_scenario())


if __name__ == "__main__":
    unittest.main()
