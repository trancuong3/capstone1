"""Wave 2 + Wave 3 Backend Slice 2A unit tests (Parent Private Books, Flow 2, Book Content Quality).

Fully offline (no live PostgreSQL, Supabase, or Ollama server required).
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import unittest
import unicodedata
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from fastapi import FastAPI, HTTPException, UploadFile
from PIL import Image, ImageDraw
from pydantic import ValidationError
from starlette.datastructures import Headers

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import book_content_quality as bcq_routes
from app.api.routes import parent_private_book as ppb_routes
from app.jobs import book_quality_worker
from app.jobs import parent_book_submission_worker
from app.models.book import Book
from app.models.parent_private_book import (
    ParentBookFlow2Candidate,
    ParentBookModerationRequest,
    ParentBookOcrContributionConsent,
    ParentBookOcrContributionConsentEvent,
    ParentBookPageSubmission,
)
from app.repositories.book_content_quality_repository import (
    BookContentQualityRepository,
    _escape_ilike_pattern,
)
from app.repositories.parent_flow2_contribution_repository import (
    ParentFlow2ContributionRepository,
)
from app.schemas.book_content_quality import (
    BookQualityBookDecisionRequest,
    BookQualityReportAdminPage,
)
from app.schemas.parent_private_book import (
    AdminFlow2CandidateDecisionRequest,
    AdminSuspendPrivateBookResponse,
    AdminUserBookDecisionRequest,
    ParentAddPageRequest,
    ParentCancelSubmissionResponse,
    ParentOcrContributionStateRead,
    ParentOcrContributionUpdateRequest,
    ParentPrivateBookUpdate,
    ParentRetrySubmissionRequest,
    ParentSubmissionEditRequest,
)
from app.services.admin_ai_workflow_service import AdminAiWorkflowService
from app.services.admin_ocr_local import LocalCorrectionError
from app.services.book_content_quality_service import BookContentQualityService
from app.services.book_quality_ollama import (
    OllamaTextFinding,
    _decode_model_response,
    _unique_excerpt_span,
    analyse_with_ollama,
)
from app.services.ocr_ai.exceptions import OcrConfigurationError
from app.services.parent_flow2_contribution_service import ParentFlow2ContributionService
from app.services.parent_private_book_pipeline import (
    PipelineHooks,
    _extract_ocr_words_and_text,
    _valid_box,
    align_edited_text_to_words,
    build_proofread_suggestions,
    process_submission_stages,
)
from app.services.parent_private_book_service import ParentPrivateBookService
from app.services.rate_limiter import clear_rate_limits, rate_limiter

PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
ADMIN_ID = UUID("22222222-2222-4222-8222-222222222222")
BOOK_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
PAGE_ID = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
REVISION_ID = UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
SUB_ID = UUID("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
CAND_ID = UUID("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")


def _png_bytes(size: tuple[int, int] = (320, 120), *, with_text: bool = True) -> bytes:
    img = Image.new("RGB", size, (255, 255, 255))
    if with_text:
        draw = ImageDraw.Draw(img)
        draw.rectangle((20, 20, 300, 90), outline=(0, 0, 0), width=3)
        for x in range(30, 290, 12):
            draw.line((x, 30, x + 5, 80), fill=(10, 10, 10), width=2)
    buf = BytesIO()
    img.save(buf, format="PNG")
    img.close()
    return buf.getvalue()


def _make_book(**overrides: object) -> SimpleNamespace:
    now = datetime(2026, 11, 25, tzinfo=timezone.utc)
    defaults = dict(
        Id=BOOK_ID,
        Name="Sách riêng kiểm thử",
        Title="Sách riêng kiểm thử",
        Author="Tác giả",
        MinGrade=1,
        MaxGrade=3,
        LifecycleStatus="ACTIVE",
        VisibilityScope="PARENT_PRIVATE",
        OwnerParentId=PARENT_ID,
        ModerationStatus="ACTIVE",
        SuspendedReason=None,
        SourceDeclaration="[SELF_AUTHORED] Tự sáng tác",
        IsDeleted=False,
        CreatedAt=now,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_submission(**overrides: object) -> SimpleNamespace:
    now = datetime(2026, 11, 25, tzinfo=timezone.utc)
    defaults = dict(
        Id=SUB_ID,
        BookId=BOOK_ID,
        OwnerParentId=PARENT_ID,
        BatchId=uuid4(),
        BatchTotalPages=1,
        SourcePageNumber=1,
        TargetPageNumber=1,
        SourceFileName="page1.png",
        SourceFormat="IMAGE",
        SourceStoragePath=f"private-books/{PARENT_ID}/{BOOK_ID}/staging/{SUB_ID}/page-1.png",
        SourceSha256="a" * 64,
        ImageWidth=640,
        ImageHeight=480,
        SourceType="SELF_AUTHORED",
        SourceNote="Ghi chú nguồn ban đầu",
        SubmissionVersion=1,
        OptimisticLockVersion=1,
        WorkflowStatus="CHECKING",
        OcrStatus="PENDING",
        OcrText=None,
        OcrWordsJson=[],
        OcrMetaJson={},
        OcrHash=None,
        OcrErrorCode=None,
        IsImageOnly=False,
        ProofreadStatus="PENDING",
        ProofreadText=None,
        ProofreadHash=None,
        ProofreadSuggestionsJson=[],
        UncertainWordIndicesJson=[],
        ProofreadProviderEventsJson=[],
        ProofreadErrorCode=None,
        SpellingAcceptedAt=None,
        CandidateText=None,
        CandidateHash=None,
        CandidateWordsJson=[],
        ToolCheckStatus="PENDING",
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
        WorkerId="worker-1",
        LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=10),
        RetryAfter=None,
        Attempts=1,
        TempExpiresAt=now + timedelta(days=7),
        CreatedAt=now,
        UpdatedAt=now,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class Group1OrmForeignKeyTests(unittest.TestCase):
    def test_orm_cascades_and_outbox_fk_match_migrations(self):
        def _fk(col):
            fks = list(col.foreign_keys)
            self.assertEqual(len(fks), 1, f"Expected 1 FK on {col}")
            return fks[0]

        self.assertEqual(_fk(Book.__table__.c.owner_parent_id).ondelete, "CASCADE")
        self.assertEqual(
            _fk(ParentBookPageSubmission.__table__.c.owner_parent_id).ondelete,
            "CASCADE",
        )
        self.assertEqual(
            _fk(ParentBookModerationRequest.__table__.c.owner_parent_id).ondelete,
            "CASCADE",
        )
        self.assertEqual(
            _fk(ParentBookOcrContributionConsent.__table__.c.owner_parent_id).ondelete,
            "CASCADE",
        )
        self.assertEqual(
            _fk(ParentBookOcrContributionConsentEvent.__table__.c.owner_parent_id).ondelete,
            "CASCADE",
        )
        actor_col = ParentBookOcrContributionConsentEvent.__table__.c.actor_id
        self.assertTrue(actor_col.nullable)
        self.assertEqual(_fk(actor_col).ondelete, "SET NULL")

        self.assertEqual(
            _fk(ParentBookFlow2Candidate.__table__.c.owner_parent_id).ondelete,
            "CASCADE",
        )
        outbox_fk = _fk(ParentBookFlow2Candidate.__table__.c.outbox_event_id)
        self.assertEqual(outbox_fk.target_fullname, "viread_ocr_outbox.id")
        self.assertEqual(outbox_fk.ondelete, "SET NULL")


class Group2PipelineAndWorkerTests(unittest.IsolatedAsyncioTestCase):
    def test_valid_box_rejects_bool_nan_inf_and_zero_width_after_clamp(self):
        self.assertIsNone(_valid_box([True, 0.1, 0.2, 0.1]))
        self.assertIsNone(_valid_box([0.1, False, 0.2, 0.1]))
        self.assertIsNone(_valid_box([float("nan"), 0.1, 0.2, 0.1]))
        self.assertIsNone(_valid_box([0.1, 0.1, float("inf"), 0.1]))
        self.assertIsNone(_valid_box([1.0, 0.1, 0.0005, 0.1]))
        self.assertIsNone(_valid_box([0.9999999, 0.1, 0.00000001, 0.1]))
        self.assertEqual(_valid_box([0.1, 0.2, 0.3, 0.1]), [0.1, 0.2, 0.3, 0.1])
        self.assertEqual(_valid_box({"x": 0.9, "y": 0.2, "w": 0.1005, "h": 0.1}), [0.9, 0.2, 0.1, 0.1])

    def test_extract_ocr_reads_metadata_key_and_en_dash_alignment(self):
        raw = {
            "text": "– Xin chào",
            "words": [
                {"text": "–", "line_index": 0, "bounding_box": [0.02, 0.1, 0.04, 0.05]},
                {"text": "Xin", "line_index": 0, "bounding_box": [0.1, 0.1, 0.2, 0.05], "ocr_confidence": 0.95},
                {"text": "chào", "line_index": 0, "bounding_box": [0.35, 0.1, 0.2, 0.05], "ocr_confidence": True},
            ],
            "metadata": {"engine": "vietocr_v2", "checkpoint_sha256": "abc"},
        }
        text_val, words, meta = _extract_ocr_words_and_text(raw)
        self.assertEqual(text_val, "– Xin chào")
        self.assertEqual(meta, {"engine": "vietocr_v2", "checkpoint_sha256": "abc"})
        self.assertEqual([w["text"] for w in words], ["Xin", "chào"])
        self.assertEqual(words[0]["ocr_confidence"], 0.95)
        self.assertIsNone(words[1]["ocr_confidence"])

        # build_proofread_suggestions aligns with normalize_word so en-dash doesn't shift indices
        self.assertEqual(build_proofread_suggestions(words, "– Xin chào", set()), [])
        diffs = build_proofread_suggestions(words, "– Xin chao", set())
        self.assertEqual(len(diffs), 1)
        self.assertEqual(diffs[0]["word_index"], 1)
        self.assertEqual(diffs[0]["original"], "chào")
        self.assertEqual(diffs[0]["suggested"], "chao")

        # align_edited_text_to_words preserves original OCR boxes across leading en-dash
        aligned = align_edited_text_to_words("– Xin chào!", words)
        self.assertEqual(len(aligned), 2)
        self.assertEqual(aligned[0]["bounding_box"], [0.1, 0.1, 0.2, 0.05])
        self.assertEqual(aligned[1]["bounding_box"], [0.35, 0.1, 0.2, 0.05])

    async def test_pipeline_ocr_config_error_and_incomplete_chunks_and_worker_fencing(self):
        # 1) OcrConfigurationError (no .code attribute) fails cleanly and checks worker_id
        sub = _make_submission(
            OcrStatus="COMPLETED",
            ProofreadStatus="COMPLETED",
            ToolCheckStatus="PENDING",
            CandidateText="Mèo con đi học rất ngoan.",
            CandidateHash="c" * 64,
            WorkerId="worker-active",
        )
        db = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock(), refresh=AsyncMock())

        class _ConfigFailSafety:
            async def analyze(self, _text: str):
                raise OcrConfigurationError("local ollama model missing")

        with patch("app.services.parent_private_book_pipeline.ParentPrivateBookRepository") as repo_cls:
            repo = SimpleNamespace(
                get_submission=AsyncMock(return_value=sub),
                list_committed_page_texts=AsyncMock(return_value=[]),
            )
            repo_cls.return_value = repo
            # Wrong worker_id -> stale write is discarded (NOT marked CHECK_FAILED!)
            await process_submission_stages(
                db,
                SUB_ID,
                worker_id="stale-worker",
                hooks=PipelineHooks(safety_orchestrator_factory=_ConfigFailSafety),
            )
            self.assertEqual(sub.WorkflowStatus, "CHECKING")
            db.commit.assert_not_awaited()

            # Matching worker_id -> persists TOOL_CHECK_CONFIG_INVALID cleanly without AttributeError
            await process_submission_stages(
                db,
                SUB_ID,
                worker_id="worker-active",
                hooks=PipelineHooks(safety_orchestrator_factory=_ConfigFailSafety),
            )
            self.assertEqual(sub.WorkflowStatus, "CHECK_FAILED")
            self.assertEqual(sub.ToolCheckErrorCode, "TOOL_CHECK_CONFIG_INVALID")
            db.commit.assert_awaited_once()

        # 2) Partial chunks (all_chunks_completed=False) fails closed with INCOMPLETE_CHUNK_COVERAGE
        sub2 = _make_submission(
            OcrStatus="COMPLETED",
            ProofreadStatus="COMPLETED",
            ToolCheckStatus="PENDING",
            CandidateText="Mèo con đi học rất ngoan.",
            CandidateHash="c" * 64,
            WorkerId="worker-active",
        )
        db2 = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock(), refresh=AsyncMock())

        class _PartialChunksSafety:
            async def analyze(self, _text: str):
                return {
                    "suitability": "SUITABLE",
                    "findings": [],
                    "chunks_total": 3,
                    "chunks_completed": 2,
                    "all_chunks_completed": False,
                    "provider_events": [
                        {"provider": "ollama_local", "chunk_id": 0, "availability": True},
                        {"provider": "ollama_local", "chunk_id": 1, "availability": True},
                    ],
                }

        with patch("app.services.parent_private_book_pipeline.ParentPrivateBookRepository") as repo_cls:
            repo_cls.return_value = SimpleNamespace(
                get_submission=AsyncMock(return_value=sub2),
                list_committed_page_texts=AsyncMock(return_value=[]),
            )
            await process_submission_stages(
                db2,
                SUB_ID,
                worker_id="worker-active",
                hooks=PipelineHooks(safety_orchestrator_factory=_PartialChunksSafety),
            )
            self.assertEqual(sub2.WorkflowStatus, "CHECK_FAILED")
            self.assertEqual(sub2.ToolCheckErrorCode, "INCOMPLETE_CHUNK_COVERAGE")

    async def test_pipeline_is_image_only_fallback_and_retry_reset(self):
        # 1) Stuck CHECKING + IsImageOnly=True transitions to NEEDS_ADMIN_REVIEW instead of looping
        sub = _make_submission(
            WorkflowStatus="CHECKING",
            OcrStatus="NO_TEXT_DETECTED",
            IsImageOnly=True,
            ProofreadStatus="SKIPPED",
            ToolCheckStatus="PENDING",
            CandidateHash=None,
            WorkerId="worker-img",
        )
        db = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock(), refresh=AsyncMock())
        with patch("app.services.parent_private_book_pipeline.ParentPrivateBookRepository") as repo_cls:
            repo_cls.return_value = SimpleNamespace(
                get_submission=AsyncMock(return_value=sub),
                list_committed_page_texts=AsyncMock(return_value=[]),
            )
            await process_submission_stages(db, SUB_ID, worker_id="worker-img")
        self.assertEqual(sub.WorkflowStatus, "NEEDS_ADMIN_REVIEW")
        self.assertEqual(sub.ToolCheckStatus, "FLAGGED")
        self.assertTrue(sub.ToolCheckScopeJson.get("requires_admin_visual_review"))
        self.assertIsNotNone(sub.CandidateHash)
        db.commit.assert_awaited_once()

        # 2) retry_submission(stage="AUTO") on IsImageOnly resets OCR + IsImageOnly=False
        retry_sub = _make_submission(
            WorkflowStatus="NEEDS_RECHECK",
            OcrStatus="NO_TEXT_DETECTED",
            IsImageOnly=True,
            ProofreadStatus="SKIPPED",
            ToolCheckStatus="NEEDS_MANUAL_REVIEW",
        )
        svc_db = SimpleNamespace(refresh=AsyncMock())
        svc = ParentPrivateBookService(svc_db)  # type: ignore[arg-type]
        svc._require_parent = AsyncMock()
        svc._sync_remote_ocr_for_submissions = AsyncMock()
        svc.repo = SimpleNamespace(
            get_owned_private_book=AsyncMock(return_value=_make_book()),
            get_owned_submission=AsyncMock(return_value=retry_sub),
            commit=AsyncMock(),
        )
        await svc.retry_submission(
            PARENT_ID, BOOK_ID, SUB_ID, ParentRetrySubmissionRequest(stage="AUTO")
        )
        self.assertEqual(retry_sub.OcrStatus, "PENDING")
        self.assertFalse(retry_sub.IsImageOnly)
        self.assertEqual(retry_sub.ProofreadStatus, "PENDING")
        self.assertEqual(retry_sub.ToolCheckStatus, "PENDING")
        self.assertEqual(retry_sub.WorkflowStatus, "CHECKING")

    async def test_submission_worker_run_once_starts_heartbeat_and_releases_lease_on_cancel(self):
        renew_calls: list[tuple[UUID, str]] = []
        release_calls: list[tuple[UUID, str]] = []

        @asynccontextmanager
        async def _fake_session():
            yield SimpleNamespace()

        async def _fake_renew(sub_id: UUID, w_id: str, **_kw):
            renew_calls.append((sub_id, w_id))
            return True

        async def _fake_release(sub_id: UUID, w_id: str):
            release_calls.append((sub_id, w_id))

        async def _slow_process(_db, _sub_id, **_kw):
            await asyncio.sleep(0.06)

        with (
            patch.object(parent_book_submission_worker, "AsyncSessionLocal", _fake_session),
            patch.object(parent_book_submission_worker, "is_remote_ocr_mode", return_value=False),
            patch.object(parent_book_submission_worker, "is_heavy_workers_disabled", return_value=False),
            patch.object(parent_book_submission_worker, "HEARTBEAT_SECONDS", 0.01),
            patch.object(parent_book_submission_worker, "_renew_submission_lease", side_effect=_fake_renew),
            patch.object(parent_book_submission_worker, "_release_submission_lease", side_effect=_fake_release),
            patch.object(parent_book_submission_worker, "ParentPrivateBookRepository") as repo_cls,
            patch("app.services.parent_private_book_pipeline.process_submission_stages", side_effect=_slow_process),
        ):
            repo_cls.return_value = SimpleNamespace(
                claim_next_checking_submission=AsyncMock(return_value=SimpleNamespace(Id=SUB_ID))
            )
            ran = await parent_book_submission_worker.run_once(worker_id="w-hb")
            self.assertTrue(ran)
            self.assertGreaterEqual(len(renew_calls), 1)
            self.assertEqual(renew_calls[0], (SUB_ID, "w-hb"))

        # CancelledError during processing releases the lease cleanly
        async def _cancel_process(_db, _sub_id, **_kw):
            raise asyncio.CancelledError()

        with (
            patch.object(parent_book_submission_worker, "AsyncSessionLocal", _fake_session),
            patch.object(parent_book_submission_worker, "is_remote_ocr_mode", return_value=False),
            patch.object(parent_book_submission_worker, "is_heavy_workers_disabled", return_value=False),
            patch.object(parent_book_submission_worker, "_release_submission_lease", side_effect=_fake_release),
            patch.object(parent_book_submission_worker, "ParentPrivateBookRepository") as repo_cls,
            patch("app.services.parent_private_book_pipeline.process_submission_stages", side_effect=_cancel_process),
        ):
            repo_cls.return_value = SimpleNamespace(
                claim_next_checking_submission=AsyncMock(return_value=SimpleNamespace(Id=SUB_ID))
            )
            with self.assertRaises(asyncio.CancelledError):
                await parent_book_submission_worker.run_once(worker_id="w-cancel")
            self.assertEqual(release_calls, [(SUB_ID, "w-cancel")])


class Group2ServiceAndRouteHardeningTests(unittest.IsolatedAsyncioTestCase):
    async def test_update_book_handles_concurrent_new_page_without_silent_retirement(self):
        book = _make_book(Title="Tên cũ")
        page1_id = uuid4()
        page2_id = uuid4()
        page1 = SimpleNamespace(Id=page1_id, ImagePath="private-books/p/b/p1.png", Width=400, Height=300, PageNumber=1, LifecycleStatus="ACTIVE")
        page2 = SimpleNamespace(Id=page2_id, ImagePath="private-books/p/b/p2.png", Width=400, Height=300, PageNumber=2, LifecycleStatus="ACTIVE")

        list_pages_calls = 0

        async def _list_committed_pages(_book_id, *, lock=False):
            nonlocal list_pages_calls
            list_pages_calls += 1
            if list_pages_calls == 1:
                return [(page1, None)]  # Initial snapshot only sees page 1
            return [(page1, None), (page2, None)]  # Page 2 committed concurrently!

        added_subs: list = []
        uploaded: list[str] = []

        db = SimpleNamespace(refresh=AsyncMock())
        svc = ParentPrivateBookService(db)  # type: ignore[arg-type]
        svc._require_parent = AsyncMock()
        svc._sync_remote_ocr_for_submissions = AsyncMock()
        svc._safe_revoke_flow2_contributions = AsyncMock()
        svc._load_contribution_states = AsyncMock(return_value={BOOK_ID: None})
        svc.repo = SimpleNamespace(
            get_owned_private_book=AsyncMock(return_value=book),
            list_committed_pages=AsyncMock(side_effect=_list_committed_pages),
            list_submissions_for_book=AsyncMock(return_value=[]),
            rollback=AsyncMock(),
            add_submissions=AsyncMock(side_effect=lambda rows: added_subs.extend(rows)),
            supersede_open_moderation_requests_for_book=AsyncMock(),
            add_audit_log=AsyncMock(),
            commit=AsyncMock(),
            committed_page_counts=AsyncMock(return_value={BOOK_ID: 0}),
            is_private_book_readable=AsyncMock(return_value=False),
        )

        with (
            patch("app.services.parent_private_book_service.download_object", return_value=b"IMG"),
            patch(
                "app.services.parent_private_book_service.upload_object",
                side_effect=lambda path, *_a, **_kw: uploaded.append(path),
            ),
        ):
            res = await svc.update_book(PARENT_ID, BOOK_ID, ParentPrivateBookUpdate(title="Tên mới"))

        self.assertEqual(res.title, "Tên mới")
        self.assertEqual(len(uploaded), 2)
        self.assertEqual(len(added_subs), 2)
        self.assertEqual(sorted(s.TargetPageNumber for s in added_subs), [1, 2])
        self.assertGreaterEqual(svc.repo.rollback.await_count, 2)

    async def test_edit_submission_uses_model_fields_set_to_clear_source_note(self):
        book = _make_book()
        sub = _make_submission(SourceNote="Ghi chú cũ", WorkflowStatus="NEEDS_ADMIN_REVIEW")
        db = SimpleNamespace(refresh=AsyncMock())
        svc = ParentPrivateBookService(db)  # type: ignore[arg-type]
        svc._require_parent = AsyncMock()
        svc._sync_remote_ocr_for_submissions = AsyncMock()
        svc.repo = SimpleNamespace(
            get_owned_private_book=AsyncMock(return_value=book),
            get_owned_submission=AsyncMock(return_value=sub),
            supersede_open_moderation_requests=AsyncMock(),
            commit=AsyncMock(),
            rollback=AsyncMock(),
        )

        # Sending explicit empty source_note clears SourceNote to None and resets check
        await svc.edit_submission(
            PARENT_ID,
            BOOK_ID,
            SUB_ID,
            ParentSubmissionEditRequest(source_note=""),
        )
        self.assertIsNone(sub.SourceNote)
        self.assertEqual(sub.SubmissionVersion, 2)
        svc.repo.commit.assert_awaited_once()

    async def test_admin_decide_submission_enforces_book_before_submission_lock_order(self):
        lock_order: list[str] = []
        book = _make_book()
        sub = _make_submission(WorkflowStatus="PENDING_ADMIN", CandidateHash="h" * 64)
        open_req = SimpleNamespace(
            Id=uuid4(),
            Status="PENDING_ADMIN",
            PreviousStatus=None,
            DecidedBy=None,
            DecidedAt=None,
            DecisionReason=None,
            OptimisticLockVersion=1,
            UpdatedAt=datetime.now(timezone.utc),
        )

        async def _get_sub(_sub_id, *, lock=False):
            if lock:
                lock_order.append("submission")
            return sub

        async def _get_book(_book_id, *, lock=False):
            if lock:
                lock_order.append("book")
            return book

        svc = ParentPrivateBookService(SimpleNamespace(refresh=AsyncMock()))  # type: ignore[arg-type]
        svc._require_admin = AsyncMock()
        svc.repo = SimpleNamespace(
            get_submission=AsyncMock(side_effect=_get_sub),
            get_private_book=AsyncMock(side_effect=_get_book),
            list_moderation_history=AsyncMock(return_value=[open_req]),
            get_open_moderation_request=AsyncMock(return_value=open_req),
            add_audit_log=AsyncMock(return_value=SimpleNamespace(Id=uuid4())),
            commit=AsyncMock(),
        )
        await svc.admin_decide_submission(
            ADMIN_ID,
            SUB_ID,
            AdminUserBookDecisionRequest(
                decision="APPROVE",
                reason="Đã kiểm tra nội dung an toàn cho học sinh tiểu học.",
                expected_submission_version=1,
                expected_snapshot_hash="h" * 64,
                expected_lock_version=1,
            ),
        )
        self.assertEqual(lock_order, ["book", "submission"])

    async def test_add_page_to_book_rolls_back_before_storage_and_cleans_up_on_error(self):
        events: list[str] = []
        book = _make_book()
        sub = _make_submission(
            WorkflowStatus="PASSED_READY_TO_ADD",
            OcrStatus="COMPLETED",
            ProofreadStatus="COMPLETED",
            ToolCheckStatus="PASSED",
            ToolCheckSuitability="SUITABLE",
            ToolCheckInputHash="h" * 64,
            CandidateHash="h" * 64,
            CandidateText="Mèo con",
            CandidateWordsJson=[
                {"word_index": 0, "line_index": 0, "text": "Mèo", "bounding_box": [0.1, 0.1, 0.2, 0.05]},
                {"word_index": 1, "line_index": 0, "text": "con", "bounding_box": [0.35, 0.1, 0.2, 0.05]},
            ],
        )

        async def _get_book(_bid, _aid, *, lock=False):
            if lock:
                events.append("lock_book")
            return book

        async def _get_sub(_bid, _sid, _aid, *, lock=False):
            if lock:
                events.append("lock_sub")
            return sub

        async def _rollback():
            events.append("rollback")

        def _download(path, *, bucket_name):
            events.append("download")
            return b"PNG"

        def _upload(path, *_a, **_kw):
            events.append("upload")

        def _delete(path, *, bucket_name):
            events.append("delete_cleanup")

        svc = ParentPrivateBookService(SimpleNamespace(refresh=AsyncMock()))  # type: ignore[arg-type]
        svc._require_parent = AsyncMock()
        svc.repo = SimpleNamespace(
            get_owned_private_book=AsyncMock(side_effect=_get_book),
            get_owned_submission=AsyncMock(side_effect=_get_sub),
            rollback=AsyncMock(side_effect=_rollback),
            page_number_exists=AsyncMock(return_value=False),
            create_committed_page=AsyncMock(side_effect=RuntimeError("db write failed")),
        )
        with (
            patch("app.services.parent_private_book_service.download_object", side_effect=_download),
            patch("app.services.parent_private_book_service.upload_object", side_effect=_upload),
            patch("app.services.parent_private_book_service.delete_object", side_effect=_delete),
        ):
            with self.assertRaises(RuntimeError):
                await svc.add_page_to_book(
                    PARENT_ID,
                    BOOK_ID,
                    SUB_ID,
                    ParentAddPageRequest(
                        expected_submission_version=1,
                        expected_candidate_hash="h" * 64,
                    ),
                )

        # Rollback occurred BEFORE download/upload, locks acquired AFTER upload, cleanup ran on DB failure
        self.assertEqual(
            events,
            ["rollback", "download", "upload", "lock_book", "lock_sub", "rollback", "delete_cleanup"],
        )

    async def test_serialize_book_summaries_batches_readable_private_book_ids(self):
        books = [_make_book(Id=uuid4()), _make_book(Id=uuid4()), _make_book(Id=uuid4())]
        svc = ParentPrivateBookService(SimpleNamespace())  # type: ignore[arg-type]
        svc._load_contribution_states = AsyncMock(return_value={b.Id: None for b in books})
        svc.repo = SimpleNamespace(
            committed_page_counts=AsyncMock(return_value={b.Id: 1 for b in books}),
            list_submissions_for_books=AsyncMock(return_value=[]),
            readable_private_book_ids=AsyncMock(return_value={books[0].Id, books[2].Id}),
            is_private_book_readable=AsyncMock(side_effect=AssertionError("N+1 must not be called")),
        )
        summaries = await svc._serialize_book_summaries(PARENT_ID, books)
        self.assertEqual([s.readable_for_children for s in summaries], [True, False, True])
        svc.repo.readable_private_book_ids.assert_awaited_once()

    async def test_routes_upload_close_response_models_bounds_default_status_and_rate_limit(self):
        # 1) Response models & defaults
        routes_by_name = {r.name: r for r in ppb_routes.router.routes}
        self.assertIs(routes_by_name["cancel_my_submission"].response_model, ParentCancelSubmissionResponse)
        self.assertIs(routes_by_name["suspend_admin_user_book"].response_model, AdminSuspendPrivateBookResponse)

        sig_list = inspect.signature(ppb_routes.list_admin_flow2_candidates)
        self.assertIsNone(sig_list.parameters["candidate_status"].default.default)

        # 2) FastAPI integration: UploadFile closed on error, Form bounds enforced (422), rate limit returns 429
        app = FastAPI()
        app.include_router(ppb_routes.router, prefix="/books")
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ID
        app.dependency_overrides[get_db] = lambda: SimpleNamespace()

        clear_rate_limits()
        rate_limiter.set_override("private_book_upload", max_requests=2, window_seconds=60.0)
        try:
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                # Out-of-range target_page_number (> 32767) -> 422
                bad_page = await client.post(
                    f"/books/my-books/{BOOK_ID}/submissions",
                    files={"file": ("p.png", _png_bytes(), "image/png")},
                    data={"idempotency_key": "k1", "target_page_number": "40000"},
                )
                self.assertEqual(bad_page.status_code, 422)

                # Overlong source_note (> 1000) -> 422
                bad_note = await client.post(
                    f"/books/my-books/{BOOK_ID}/submissions",
                    files={"file": ("p.png", _png_bytes(), "image/png")},
                    data={"idempotency_key": "k2", "source_note": "x" * 1001},
                )
                self.assertEqual(bad_note.status_code, 422)

                # 3rd request within window hits rate limiter -> 429
                throttled = await client.post(
                    f"/books/my-books/{BOOK_ID}/submissions",
                    files={"file": ("p.png", _png_bytes(), "image/png")},
                    data={"idempotency_key": "k3"},
                )
                self.assertEqual(throttled.status_code, 429)
                self.assertIn("Retry-After", throttled.headers)
        finally:
            clear_rate_limits()

        # Verify UploadFile.close() called in finally even when service raises HTTPException
        fake_upload = UploadFile(
            filename="p.png", file=BytesIO(b"123"), headers=Headers({"content-type": "image/png"})
        )
        fake_upload.close = AsyncMock()  # type: ignore[method-assign]
        fake_req = SimpleNamespace(base_url="http://test/")
        fake_resp = SimpleNamespace(headers={})
        with patch.object(
            ParentPrivateBookService,
            "submit_pages",
            new=AsyncMock(side_effect=HTTPException(status_code=409, detail="boom")),
        ):
            with self.assertRaises(HTTPException):
                await ppb_routes.submit_my_private_book_pages(
                    BOOK_ID,
                    fake_req,  # type: ignore[arg-type]
                    fake_resp,  # type: ignore[arg-type]
                    file=fake_upload,
                    idempotency_key="k",
                    actor_id=PARENT_ID,
                    db=SimpleNamespace(),  # type: ignore[arg-type]
                )
        fake_upload.close.assert_awaited_once()


class Group3Flow2ContributionTests(unittest.IsolatedAsyncioTestCase):
    async def test_outbox_conflict_sql_resets_skipped_and_failed_rows_to_pending(self):
        executed_sql: list[str] = []

        async def _execute(stmt, params=None):
            executed_sql.append(str(stmt))
            return SimpleNamespace(scalar_one=lambda: uuid4())

        repo = ParentFlow2ContributionRepository(SimpleNamespace(execute=AsyncMock(side_effect=_execute)))  # type: ignore[arg-type]
        await repo.enqueue_candidate_outbox(
            candidate_id=CAND_ID,
            page_id=PAGE_ID,
            revision_id=REVISION_ID,
            actor_id=ADMIN_ID,
            payload_json="{}",
        )
        sql = executed_sql[0]
        self.assertIn("IN ('SKIPPED', 'FAILED')", sql)
        self.assertIn("THEN 'PENDING'", sql)
        self.assertIn("THEN EXCLUDED.payload", sql)
        self.assertIn("THEN 0", sql)

    async def test_revoke_training_jobs_catches_only_undefined_table_and_reraises_other_errors(self):
        class _UndefinedTableErr(Exception):
            sqlstate = "42P01"

        @asynccontextmanager
        async def _nested():
            yield

        # 1) UndefinedTable -> returns cancelled_jobs = 0 cleanly
        call_idx = 0

        async def _exec_undef(stmt, params=None):
            nonlocal call_idx
            call_idx += 1
            if call_idx == 1:
                return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [CAND_ID]))
            if call_idx in (2, 3):
                return SimpleNamespace(rowcount=1)
            if call_idx == 4:
                return SimpleNamespace(all=lambda: [(uuid4(),)])
            raise _UndefinedTableErr("relation public.viread_ocr_training_jobs does not exist")

        repo1 = ParentFlow2ContributionRepository(
            SimpleNamespace(execute=AsyncMock(side_effect=_exec_undef), begin_nested=_nested)  # type: ignore[arg-type]
        )
        out = await repo1.revoke_candidates_and_downstream(
            book_id=BOOK_ID, page_id=None, reason="OPT_OUT", now=datetime.now(timezone.utc)
        )
        self.assertEqual(out["cancelled_jobs"], 0)
        self.assertEqual(out["archived_datasets"], 1)

        # 2) Unexpected RuntimeError -> logged and re-raised (not swallowed!)
        call_idx2 = 0

        async def _exec_boom(stmt, params=None):
            nonlocal call_idx2
            call_idx2 += 1
            if call_idx2 == 1:
                return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [CAND_ID]))
            if call_idx2 in (2, 3):
                return SimpleNamespace(rowcount=1)
            if call_idx2 == 4:
                return SimpleNamespace(all=lambda: [(uuid4(),)])
            raise RuntimeError("connection dropped")

        repo2 = ParentFlow2ContributionRepository(
            SimpleNamespace(execute=AsyncMock(side_effect=_exec_boom), begin_nested=_nested)  # type: ignore[arg-type]
        )
        with self.assertLogs(
            "app.repositories.parent_flow2_contribution_repository", level="ERROR"
        ):
            with self.assertRaises(RuntimeError):
                await repo2.revoke_candidates_and_downstream(
                    book_id=BOOK_ID, page_id=None, reason="OPT_OUT", now=datetime.now(timezone.utc)
                )

    async def test_reopen_candidate_clears_stale_fields_and_consent_optin_rolls_back_before_storage(self):
        # 1) Candidate reopen clears every stale field
        book = _make_book()
        page = SimpleNamespace(
            Id=PAGE_ID,
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=REVISION_ID,
            ImagePath="private-books/u/b/p.png",
        )
        rev = SimpleNamespace(
            Id=REVISION_ID,
            VerificationStatus="VERIFIED",
            ContentHash="h" * 64,
            ProcessingMeta={"source_image_path": "private-books/u/b/p.png"},
        )
        sub = _make_submission(
            WorkflowStatus="ADDED_TO_BOOK",
            OcrStatus="COMPLETED",
            ProofreadStatus="COMPLETED",
            ToolCheckStatus="PASSED",
            ToolCheckSuitability="SUITABLE",
            ToolCheckInputHash="h" * 64,
            CandidateHash="h" * 64,
            SourceType="SELF_AUTHORED",
        )
        consent = SimpleNamespace(Status="OPTED_IN", RightsConfirmed=True, ConsentVersion=3)
        stale_cand = SimpleNamespace(
            Id=CAND_ID,
            Status="REVOKED",
            ConsentVersion=1,
            VerifiedLabel="Old label",
            VerifiedLabelSha256="1" * 64,
            VerifiedBy=ADMIN_ID,
            VerifiedAt=datetime.now(timezone.utc),
            RejectionCode="OTHER",
            RejectionReason="old",
            OutboxEventId=uuid4(),
            SampleId=uuid4(),
            RevokedAt=datetime.now(timezone.utc),
            RevokeReason="PARENT_OPTED_OUT",
            PiiCheckStatus="CLEAR",
            PiiFlagsJson=[],
            QualityMetricsJson={},
            ProposedLabel="Old",
            RightsBasis="SELF_AUTHORED",
            UpdatedAt=datetime.now(timezone.utc),
        )

        svc = ParentFlow2ContributionService(SimpleNamespace())  # type: ignore[arg-type]
        svc.repo = SimpleNamespace(
            get_candidate_by_idempotency_key=AsyncMock(return_value=stale_cand),
            rollback=AsyncMock(),
        )
        res = await svc.recruit_committed_page(
            book=book,
            page=page,
            revision=rev,
            submission=sub,
            consent=consent,
            preloaded_extracted=[
                {
                    "line_index": 0,
                    "eligible": True,
                    "crop_box": [10, 10, 200, 60],
                    "image_sha256": "f" * 64,
                    "proposed_label": "Mèo con đi học",
                    "pii_flags": [],
                    "quality_metrics": {"width": 190, "height": 50},
                }
            ],
        )
        self.assertEqual(res["recruited_candidates"], 1)
        self.assertEqual(stale_cand.Status, "PENDING_VERIFICATION")
        self.assertEqual(stale_cand.ConsentVersion, 3)
        self.assertIsNone(stale_cand.VerifiedLabel)
        self.assertIsNone(stale_cand.VerifiedLabelSha256)
        self.assertIsNone(stale_cand.VerifiedBy)
        self.assertIsNone(stale_cand.VerifiedAt)
        self.assertIsNone(stale_cand.RejectionCode)
        self.assertIsNone(stale_cand.RejectionReason)
        self.assertIsNone(stale_cand.OutboxEventId)
        self.assertIsNone(stale_cand.SampleId)
        self.assertIsNone(stale_cand.RevokedAt)
        self.assertIsNone(stale_cand.RevokeReason)

        # 2) update_book_contribution_consent rolls back BEFORE download_object and locks Book -> Consent AFTER
        events: list[str] = []
        word = SimpleNamespace(WordIndex=0, LineIndex=0, Text="Mèo", BoundingBox=[0.1, 0.2, 0.6, 0.4])

        async def _get_owned_book(_bid, _aid, *, lock=False):
            events.append("lock_book" if lock else "read_book")
            return book

        async def _get_consent(_bid, *, lock=False):
            if lock:
                events.append("lock_consent")
            return None

        async def _rollback():
            events.append("rollback")

        def _download(_path, *, bucket_name):
            events.append("download")
            return _png_bytes()

        svc2 = ParentFlow2ContributionService(SimpleNamespace())  # type: ignore[arg-type]
        svc2._require_parent = AsyncMock()
        svc2.repo = SimpleNamespace(
            get_owned_private_book=AsyncMock(side_effect=_get_owned_book),
            list_active_committed_pages=AsyncMock(return_value=[(page, rev)]),
            get_committed_submission_for_revision=AsyncMock(return_value=sub),
            list_revision_words=AsyncMock(return_value=[word]),
            rollback=AsyncMock(side_effect=_rollback),
            get_consent=AsyncMock(side_effect=_get_consent),
            save_consent=AsyncMock(),
            add_consent_event=AsyncMock(),
            get_candidate_by_idempotency_key=AsyncMock(return_value=None),
            get_prior_admin_verified_candidate=AsyncMock(return_value=None),
            create_candidate=AsyncMock(),
            add_audit_log=AsyncMock(),
            commit=AsyncMock(),
            get_candidate_counts_by_book=AsyncMock(return_value={}),
        )
        with patch("app.services.parent_flow2_contribution_service.download_object", side_effect=_download):
            await svc2.update_book_contribution_consent(
                PARENT_ID,
                BOOK_ID,
                ParentOcrContributionUpdateRequest(enabled=True, rights_confirmed=True),
            )
        self.assertLess(events.index("rollback"), events.index("download"))
        self.assertLess(events.index("download"), events.index("lock_book"))
        self.assertLess(events.index("lock_book"), events.index("lock_consent"))

    async def test_admin_decide_candidate_canonical_lock_order_and_list_default_none(self):
        sig = inspect.signature(ParentFlow2ContributionService.admin_list_candidates)
        self.assertIsNone(sig.parameters["status_filter"].default)

        lock_order: list[str] = []
        book = _make_book()
        consent = SimpleNamespace(
            Status="OPTED_IN", RightsConfirmed=True, ConsentVersion=1, NoticeVersion="v1-2026-11-22"
        )
        cand = SimpleNamespace(
            Id=CAND_ID,
            BookId=BOOK_ID,
            PageId=PAGE_ID,
            RevisionId=REVISION_ID,
            LineIndex=0,
            ConsentVersion=1,
            SourceContentHash="h" * 64,
            ImageSha256="f" * 64,
            ProposedLabel="Mèo con đi học",
            RightsBasis="SELF_AUTHORED",
            PiiCheckStatus="CLEAR",
            PiiFlagsJson=[],
            Status="PENDING_VERIFICATION",
            OutboxEventId=None,
            VerifiedLabel=None,
            VerifiedLabelSha256=None,
            VerifiedBy=None,
            VerifiedAt=None,
            UpdatedAt=datetime.now(timezone.utc),
        )
        page = SimpleNamespace(Id=PAGE_ID, LifecycleStatus="ACTIVE", CurrentVerifiedRevisionId=REVISION_ID)
        rev = SimpleNamespace(Id=REVISION_ID, VerificationStatus="VERIFIED", ContentHash="h" * 64)

        async def _get_book(_bid, *, lock=False):
            if lock:
                lock_order.append("book")
            return book

        async def _get_consent(_bid, *, lock=False):
            if lock:
                lock_order.append("consent")
            return consent

        async def _get_cand(_cid, *, lock=False):
            if lock:
                lock_order.append("candidate")
            return cand

        svc = ParentFlow2ContributionService(SimpleNamespace())  # type: ignore[arg-type]
        svc._require_admin = AsyncMock()
        svc.repo = SimpleNamespace(
            get_candidate=AsyncMock(side_effect=_get_cand),
            get_private_book=AsyncMock(side_effect=_get_book),
            get_consent=AsyncMock(side_effect=_get_consent),
            get_page_and_revision=AsyncMock(return_value=(page, rev)),
            enqueue_candidate_outbox=AsyncMock(return_value=uuid4()),
            add_audit_log=AsyncMock(return_value=SimpleNamespace(Id=uuid4())),
            commit=AsyncMock(),
        )
        res = await svc.admin_decide_candidate(
            ADMIN_ID,
            CAND_ID,
            AdminFlow2CandidateDecisionRequest(decision="APPROVE", verified_label="Mèo con đi học"),
        )
        self.assertEqual(res.status, "SYNC_QUEUED")
        self.assertEqual(lock_order, ["book", "consent", "candidate"])


class Group4BookContentQualityTests(unittest.IsolatedAsyncioTestCase):
    async def test_ilike_escapes_backslash_and_claim_next_scan_rechecks_under_book_lock(self):
        self.assertEqual(_escape_ilike_pattern(r"a\b%c_d"), r"%a\\b\%c\_d%")

        # claim_next_scan: 1st scalar -> run, 2nd scalar -> locked book id, 3rd scalar -> conflicting active run!
        run = SimpleNamespace(
            Id=uuid4(),
            BookId=BOOK_ID,
            Status="QUEUED",
            WorkerId=None,
            LeaseExpiresAt=None,
            AttemptCount=0,
            StartedAt=None,
            UpdatedAt=None,
        )
        conflict_id = uuid4()
        db = SimpleNamespace(
            scalar=AsyncMock(side_effect=[run, BOOK_ID, conflict_id]),
            rollback=AsyncMock(),
            commit=AsyncMock(),
            refresh=AsyncMock(),
        )
        repo = BookContentQualityRepository(db)  # type: ignore[arg-type]
        claimed = await repo.claim_next_scan("worker-a")
        self.assertIsNone(claimed)
        db.rollback.assert_awaited_once()
        db.commit.assert_not_awaited()

    async def test_decide_book_approve_merges_admin_ai_workflow_and_blocks_unassessed_image_safety(self):
        text_val = "Mèo con đi học."
        text_hash = AdminAiWorkflowService._hash(text_val)
        page = SimpleNamespace(
            Id=PAGE_ID, PageNumber=1, LifecycleStatus="ACTIVE", CurrentVerifiedRevisionId=REVISION_ID
        )
        revision = SimpleNamespace(
            Id=REVISION_ID,
            VerificationStatus="VERIFIED",
            ContentHash="rev-hash",
            VerifiedText=text_val,
            ProcessingMeta={
                "admin_ai_workflow": {
                    "image_safety_status": "ADMIN_CONFIRMED_SAFE",
                    "source_image_sha256": "9" * 64,
                    "rights_evidence_id": str(uuid4()),
                    "rights_evidence_version": 4,
                }
            },
        )
        workflow = SimpleNamespace(
            Id=uuid4(),
            PageId=PAGE_ID,
            PageRevisionId=REVISION_ID,
            Status="READY_FOR_ADMIN_REVIEW",
            SafetyStatus="PROVISIONAL",
            CandidateHash=text_hash,
            CandidateText=text_val,
            SafetyInputHash=text_hash,
            Suitability="SUITABLE",
            Findings=[],
            ProofreadText=text_val,
            CorrectionSuggestions=[],
            OcrApprovedAt=None,
            OcrApprovedBy=None,
            FinalApprovedTextHash=None,
            SafetyConfirmedAt=None,
            SafetyConfirmedBy=None,
            ImageSafetyStatus="ADMIN_CONFIRMED_SAFE",
            ReviewEvents=[],
        )
        book_row = SimpleNamespace(Id=BOOK_ID, Title="Sách", Author="TG", LifecycleStatus="DRAFT")
        row = (page, revision, workflow, "fh", "sh")
        decisions: list = []

        repo = SimpleNamespace(
            role=AsyncMock(return_value="admin"),
            book=AsyncMock(return_value=book_row),
            book_assessment_rows=AsyncMock(return_value=[row]),
            book_decisions=AsyncMock(side_effect=lambda _bid: list(decisions)),
            get_rights_evidence=AsyncMock(return_value=None),
            profile_name=AsyncMock(return_value="Admin QA"),
            add_book_decision=AsyncMock(
                side_effect=lambda **kw: decisions.append(
                    SimpleNamespace(
                        Id=uuid4(),
                        ActorId=kw["actor_id"],
                        Action=kw["action"],
                        Metadata=kw["metadata"],
                        CreatedAt=datetime.now(timezone.utc),
                    )
                )
            ),
            commit=AsyncMock(),
        )
        svc = BookContentQualityService(repo)  # type: ignore[arg-type]
        await svc.decide_book(
            ADMIN_ID,
            BOOK_ID,
            BookQualityBookDecisionRequest(decision="APPROVE", reason="Đạt kiểm duyệt toàn sách."),
        )
        merged = revision.ProcessingMeta["admin_ai_workflow"]
        self.assertEqual(merged["safety_status"], "CONFIRMED")
        self.assertEqual(merged["image_safety_status"], "ADMIN_CONFIRMED_SAFE")
        self.assertEqual(merged["source_image_sha256"], "9" * 64)
        self.assertEqual(merged["rights_evidence_version"], 4)

        # Unassessed image safety (not ADMIN_CONFIRMED_SAFE in workflow or revision meta) -> 409
        revision_unassessed = SimpleNamespace(
            Id=REVISION_ID,
            VerificationStatus="VERIFIED",
            ContentHash="rev-hash",
            VerifiedText=text_val,
            ProcessingMeta={},
        )
        workflow_unassessed = SimpleNamespace(**{**workflow.__dict__, "ImageSafetyStatus": "UNASSESSED_NO_VISION_MODEL"})
        repo.book_assessment_rows = AsyncMock(return_value=[(page, revision_unassessed, workflow_unassessed, "fh", "sh")])
        decisions.clear()
        with self.assertRaises(HTTPException) as ctx:
            await svc.decide_book(
                ADMIN_ID,
                BOOK_ID,
                BookQualityBookDecisionRequest(decision="APPROVE", reason="Thử duyệt chưa kiểm ảnh."),
            )
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_ensure_page_ai_workflows_does_not_commit_inside_for_update_loop(self):
        p1, r1 = uuid4(), uuid4()
        p2, r2 = uuid4(), uuid4()
        wf1 = SimpleNamespace(
            Id=uuid4(),
            PageRevisionId=r1,
            Status="FAILED",
            Stage="PROOFREADING",
            CandidateText="a",
            CandidateHash="ha",
            SafetyInputHash=None,
            SafetyStatus="PENDING",
            Suitability=None,
            Findings=[],
            SafetyHistory=[],
            SafetyMetadata={},
            SafetyConfirmedAt=None,
            SafetyConfirmedBy=None,
            ReviewEvents=[],
        )
        wf2 = SimpleNamespace(
            Id=uuid4(),
            PageRevisionId=r2,
            Status="READY_FOR_ADMIN_REVIEW",
            Stage="READY_FOR_ADMIN_REVIEW",
            CandidateText="b",
            CandidateHash="hb",
            SafetyInputHash="stale-hash",
            SafetyStatus="STALE",
            Suitability="SUITABLE",
            Findings=[],
            SafetyHistory=[],
            SafetyMetadata={},
            SafetyConfirmedAt=None,
            SafetyConfirmedBy=None,
            ReviewEvents=[],
        )
        rows = [
            (
                SimpleNamespace(Id=p1, LifecycleStatus="ACTIVE", CurrentVerifiedRevisionId=r1),
                SimpleNamespace(Id=r1, VerificationStatus="VERIFIED", VerifiedText="a"),
                wf1,
            ),
            (
                SimpleNamespace(Id=p2, LifecycleStatus="ACTIVE", CurrentVerifiedRevisionId=r2),
                SimpleNamespace(Id=r2, VerificationStatus="VERIFIED", VerifiedText="b"),
                wf2,
            ),
        ]
        db = SimpleNamespace(commit=AsyncMock())
        repo = SimpleNamespace(
            db=db,
            book=AsyncMock(),
            book_assessment_rows=AsyncMock(return_value=rows),
        )
        svc = BookContentQualityService(repo)  # type: ignore[arg-type]
        await svc._ensure_page_ai_workflows(ADMIN_ID, BOOK_ID)
        # Single commit AFTER loop (not 2+ commits inside loop!)
        db.commit.assert_awaited_once()
        self.assertEqual(wf1.Status, "QUEUED")
        self.assertEqual(wf2.Status, "QUEUED")

    async def test_book_quality_ollama_nfc_matching_and_rejects_nan_infinity(self):
        # 1) Reject NaN / Infinity in Pydantic model and JSON response
        with self.assertRaises(ValidationError):
            OllamaTextFinding(
                excerpt="trời mua",
                issue_type="SPELLING_SUSPECTED",
                severity="MEDIUM",
                explanation="Lỗi dấu.",
                confidence=float("nan"),
            )
        for bad_const in ("NaN", "Infinity", "-Infinity"):
            raw_json = (
                '{"findings":[{"excerpt":"trời mua","issue_type":"SPELLING_SUSPECTED",'
                f'"severity":"MEDIUM","explanation":"Lỗi","confidence":{bad_const}'
                "}]}"
            )
            with self.assertRaises(LocalCorrectionError) as caught:
                _decode_model_response({"message": {"content": raw_json}})
            self.assertEqual(caught.exception.status_code, 502)

        # 2) NFD source matches NFC Ollama excerpt and preserves exact raw source slice
        nfd_source = unicodedata.normalize("NFD", "Hôm nay trời mua rất to.")
        nfc_excerpt = unicodedata.normalize("NFC", "trời mua")
        span = _unique_excerpt_span(nfd_source, nfc_excerpt)
        self.assertIsNotNone(span)
        assert span is not None
        self.assertEqual(unicodedata.normalize("NFC", nfd_source[span[0] : span[1]]), nfc_excerpt)

        async def _handler(_req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "message": {
                        "content": json.dumps(
                            {
                                "findings": [
                                    {
                                        "excerpt": nfc_excerpt,
                                        "issue_type": "SPELLING_SUSPECTED",
                                        "severity": "MEDIUM",
                                        "explanation": unicodedata.normalize("NFD", "Nghi thiếu dấu."),
                                        "suggested_correction": unicodedata.normalize("NFD", "trời mưa"),
                                        "confidence": 0.85,
                                    }
                                ]
                            },
                            ensure_ascii=False,
                        )
                    }
                },
            )

        res = await analyse_with_ollama(
            nfd_source, page_number=1, transport=httpx.MockTransport(_handler)
        )
        self.assertEqual(len(res.findings), 1)
        f = res.findings[0]
        self.assertEqual(nfd_source[f.excerpt_start : f.excerpt_end], f.excerpt)
        self.assertEqual(f.explanation, unicodedata.normalize("NFC", f.explanation))
        self.assertEqual(f.suggested_correction, unicodedata.normalize("NFC", "trời mưa"))

    async def test_bcq_routes_response_model_and_parent_report_rate_limit(self):
        routes_by_name = {r.name: r for r in bcq_routes.router.routes}
        self.assertIs(routes_by_name["list_admin_book_reports"].response_model, BookQualityReportAdminPage)

        app = FastAPI()
        app.include_router(bcq_routes.router)
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ID
        app.dependency_overrides[get_db] = lambda: SimpleNamespace()

        clear_rate_limits()
        rate_limiter.set_override("book_content_report", max_requests=1, window_seconds=60.0)
        try:
            with patch.object(
                BookContentQualityService,
                "create_parent_report",
                new=AsyncMock(side_effect=HTTPException(status_code=404, detail="not found")),
            ):
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                    body = {
                        "idempotency_key": str(uuid4()),
                        "issue_type": "SPELLING_ERROR",
                        "description": "Lỗi chính tả",
                    }
                    first = await client.post(f"/catalog/{BOOK_ID}/reports", json=body)
                    self.assertEqual(first.status_code, 404)
                    second = await client.post(f"/catalog/{BOOK_ID}/reports", json=body)
                    self.assertEqual(second.status_code, 429)
                    self.assertIn("Retry-After", second.headers)
        finally:
            clear_rate_limits()

    async def test_book_quality_worker_no_nested_session_and_lease_lost_fencing(self):
        # 1) Missing book exits outer AsyncSessionLocal BEFORE calling _mark_scan_unavailable
        open_sessions = 0
        max_concurrent_sessions = 0
        scan_id = uuid4()
        run_missing_book = SimpleNamespace(
            Id=scan_id,
            BookId=None,
            Status="RUNNING",
            WorkerId="w-1",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=10),
            ErrorSummary=None,
            CompletedAt=None,
        )

        @asynccontextmanager
        async def _tracking_session():
            nonlocal open_sessions, max_concurrent_sessions
            open_sessions += 1
            max_concurrent_sessions = max(max_concurrent_sessions, open_sessions)
            try:
                yield SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock())
            finally:
                open_sessions -= 1

        with (
            patch.object(book_quality_worker, "AsyncSessionLocal", _tracking_session),
            patch.object(book_quality_worker, "HEARTBEAT_SECONDS", 60),
            patch.object(book_quality_worker, "BookContentQualityRepository") as repo_cls,
        ):
            repo_cls.return_value = SimpleNamespace(
                scan_run=AsyncMock(return_value=run_missing_book),
                renew_scan_lease=AsyncMock(return_value=True),
            )
            await book_quality_worker._process_claimed_scan(scan_id, "w-1")

        self.assertEqual(max_concurrent_sessions, 1, "Must never open nested AsyncSessionLocal")
        self.assertEqual(run_missing_book.Status, "FAILED")
        self.assertIsNone(run_missing_book.WorkerId)

        # 2) Lost lease stops _process_page_scan and _add_cross_page_findings from writing
        stolen_run = SimpleNamespace(
            Id=scan_id,
            BookId=BOOK_ID,
            Status="RUNNING",
            WorkerId="other-worker",
            LeaseExpiresAt=datetime.now(timezone.utc) + timedelta(minutes=10),
        )
        with (
            patch.object(book_quality_worker, "AsyncSessionLocal", _tracking_session),
            patch.object(book_quality_worker, "BookContentQualityRepository") as repo_cls,
        ):
            repo_mock = SimpleNamespace(
                scan_run=AsyncMock(return_value=stolen_run),
                scan_page_context=AsyncMock(),
                page_scans=AsyncMock(),
            )
            repo_cls.return_value = repo_mock
            with self.assertRaises(book_quality_worker.WorkerLeaseLost):
                await book_quality_worker._process_page_scan(
                    uuid4(), scan_id=scan_id, worker_id="w-1"
                )
            repo_mock.scan_page_context.assert_not_awaited()

            with self.assertRaises(book_quality_worker.WorkerLeaseLost):
                await book_quality_worker._add_cross_page_findings(scan_id, worker_id="w-1")
            repo_mock.page_scans.assert_not_awaited()

        # 3) Transient heartbeat error retries instead of setting lease_lost; renew->False sets lease_lost
        stop_ev = asyncio.Event()
        lost_ev = asyncio.Event()
        renew_outcomes = [RuntimeError("transient"), False]

        async def _renew_side_effect(*_a, **_kw):
            outcome = renew_outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        with (
            patch.object(book_quality_worker, "AsyncSessionLocal", _tracking_session),
            patch.object(book_quality_worker, "BookContentQualityRepository") as repo_cls,
        ):
            repo_cls.return_value = SimpleNamespace(
                renew_scan_lease=AsyncMock(side_effect=_renew_side_effect)
            )
            with self.assertLogs("app.jobs.book_quality_worker", level="ERROR"):
                await book_quality_worker._heartbeat(
                    scan_id, "w-1", stop_ev, lost_ev, heartbeat_seconds=0.005
                )
        self.assertTrue(lost_ev.is_set())
        self.assertTrue(stop_ev.is_set())


class Group5SubmissionTestProbeHardeningTests(unittest.TestCase):
    def test_submission_ollama_probe_validates_model_and_chat_endpoint(self):
        src = (
            Path(__file__).resolve().parent / "test_parent_book_submission.py"
        ).read_text(encoding="utf-8")
        self.assertIn("trust_env=False", src)
        self.assertIn('ollama_base + "/api/tags"', src)
        self.assertIn('ollama_base + "/api/chat"', src)
        self.assertIn("model_present", src)


if __name__ == "__main__":
    unittest.main()
