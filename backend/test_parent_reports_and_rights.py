"""Focused unit and HTTP boundary tests for Parent reports, Rights profiles, and Workflow concurrency."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.book_content_quality import router as quality_router
from app.models.book_content_quality import BookContentRightsProfile
from app.schemas.book_content_quality import (
    BookContentReportCreate,
    BookContentReportStatusUpdate,
    BookContentRightsProfileUpsert,
)
from app.services.book_content_quality_service import BookContentQualityService
from app.services.ocr_ai.child_safety import ChildSafetyError, ChildSafetyOrchestrator
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.admin_ocr_local import LocalOcrConfig
import httpx
import json


ADMIN_ID = uuid4()
PARENT_A = uuid4()
PARENT_B = uuid4()
BOOK_ID = uuid4()
PAGE_ID = uuid4()
REV_1 = uuid4()
REV_2 = uuid4()


class _InMemoryQualityRepo:
    def __init__(self):
        self.roles = {ADMIN_ID: "admin", PARENT_A: "parent", PARENT_B: "parent"}
        self.profiles = {
            ADMIN_ID: SimpleNamespace(Id=ADMIN_ID, Role="admin", DisplayName="Admin ViRead", Active=1),
            PARENT_A: SimpleNamespace(Id=PARENT_A, Role="parent", DisplayName="Phụ huynh A", Active=1),
            PARENT_B: SimpleNamespace(Id=PARENT_B, Role="parent", DisplayName="Phụ huynh B", Active=1),
        }
        self.book_row = SimpleNamespace(
            Id=BOOK_ID, Title="Truyện Cổ Tích", LifecycleStatus="ACTIVE", ExpectedPageCount=None
        )
        self.page_row = SimpleNamespace(
            Id=PAGE_ID,
            BookId=BOOK_ID,
            PageNumber=2,
            ImagePath="books/test/p2.png",
            ContentType="CONTENT",
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=REV_1,
        )
        self.revisions = {
            REV_1: SimpleNamespace(
                Id=REV_1,
                PageId=PAGE_ID,
                VerificationStatus="VERIFIED",
                VerifiedText="Nội dung trang 2 bản cũ có nhiều câu chuyện hay cho bé.",
                DraftText="Nội dung trang 2 bản cũ có nhiều câu chuyện hay cho bé.",
                ContentHash="hash-v1",
            ),
            REV_2: SimpleNamespace(
                Id=REV_2,
                PageId=PAGE_ID,
                VerificationStatus="VERIFIED",
                VerifiedText="Nội dung trang 2 bản mới đã được chỉnh sửa an toàn.",
                DraftText="Nội dung trang 2 bản mới đã được chỉnh sửa an toàn.",
                ContentHash="hash-v2",
            ),
        }
        self.reports = {}
        self.histories = {}
        self.rights_profiles = {}
        self.other_books_pages = []
        self.db = SimpleNamespace(
            add=self._db_add,
            commit=AsyncMock(),
            rollback=AsyncMock(),
            refresh=AsyncMock(),
        )

    def _db_add(self, obj):
        if hasattr(obj, "ReportId") and hasattr(obj, "ToStatus"):
            obj.CreatedAt = getattr(obj, "CreatedAt", None) or datetime.now(timezone.utc)
            self.histories.setdefault(obj.ReportId, []).append(obj)

    async def role(self, actor_id):
        return self.roles.get(actor_id)

    async def profile_for_update(self, actor_id):
        return self.profiles.get(actor_id)

    async def profile_name(self, actor_id):
        p = self.profiles.get(actor_id)
        return p.DisplayName if p else None

    async def book(self, book_id, *, lock=False):
        return self.book_row if book_id == BOOK_ID else None

    async def page(self, page_id, *, lock=False):
        return self.page_row if page_id == PAGE_ID else None

    async def revision(self, page_id, revision_id):
        return self.revisions.get(revision_id) if page_id == PAGE_ID else None

    async def active_scan_for_book(self, _book_id, **_kwargs):
        return None

    async def add_scan_run(self, _run):
        return None

    async def add_report(self, report):
        now = datetime.now(timezone.utc)
        report.CreatedAt = now
        report.UpdatedAt = now
        self.reports[report.Id] = report

    async def add_report_history(self, history):
        history.CreatedAt = datetime.now(timezone.utc)
        self.histories.setdefault(history.ReportId, []).append(history)

    async def link_existing_findings_to_report(self, **_kwargs):
        return None

    async def report_by_idempotency_key(self, reporter_id, key):
        for r in self.reports.values():
            if r.ReporterId == reporter_id and r.IdempotencyKey == key:
                return r
        return None

    async def count_recent_reports(self, _reporter_id, _since):
        return 0

    async def report(self, report_id, *, lock=False):
        return self.reports.get(report_id)

    async def report_detail(self, report_id):
        r = self.reports.get(report_id)
        if r is None:
            return None
        return r, r.ReporterNameSnapshot

    async def report_history(self, report_id):
        return list(self.histories.get(report_id, []))

    async def findings_for_report(self, _report_id):
        return [
            (
                SimpleNamespace(
                    Id=uuid4(),
                    PageScanId=uuid4(),
                    BookId=BOOK_ID,
                    PageId=PAGE_ID,
                    PageRevisionId=REV_1,
                    IssueType="SPELLING_SUSPECTED",
                    Severity="MEDIUM",
                    OriginalExcerpt="internal admin finding",
                    ExcerptStart=0,
                    ExcerptEnd=8,
                    SuggestedCorrection=None,
                    Explanation="Internal quality note",
                    DetectionSource="RULE",
                    ModelName=None,
                    Confidence=None,
                    Status="NEEDS_REVIEW",
                    ReviewNote=None,
                    CreatedAt=datetime.now(timezone.utc),
                ),
                2,
            )
        ]

    async def commit(self):
        return None

    async def rollback(self):
        return None

    async def refresh(self, _entity):
        return None

    async def rights_profile(self, book_id, page_id=None, *, lock=False):
        return self.rights_profiles.get((book_id, page_id))

    async def add_rights_profile(self, profile):
        self.rights_profiles[(profile.BookId, profile.PageId)] = profile

    async def book_assessment_rows(self, _book_id, *, lock=False):
        return [(self.page_row, self.revisions[self.page_row.CurrentVerifiedRevisionId], None, None, None)]

    async def latest_revisions_by_page_for_book(self, _book_id):
        return {PAGE_ID: self.revisions[self.page_row.CurrentVerifiedRevisionId]}

    async def other_books_verified_pages(self, _exclude_book_id, *, limit=500):
        return list(self.other_books_pages)


class ParentReportAndRightsTests(unittest.IsolatedAsyncioTestCase):
    async def test_parent_reports_new_and_legacy_types_isolation_privacy_and_snapshot_change(self):
        repo = _InMemoryQualityRepo()
        service = BookContentQualityService(repo)

        # 1. Parent A creates book-level COPYRIGHT_CONCERN report and page-level CHILD_UNSAFE_CONTENT + legacy SPELLING_ERROR report.
        safety_key = uuid4()
        safety_report = await service.create_parent_report(
            PARENT_A,
            BOOK_ID,
            BookContentReportCreate(
                idempotency_key=safety_key,
                issue_type="CHILD_UNSAFE_CONTENT",
                description="Trang này có hình ảnh và đoạn mô tả đáng sợ cho bé lớp 1.",
                page_id=PAGE_ID,
                reported_text="đoạn mô tả",
            ),
        )
        self.assertEqual(safety_report.issue_type, "CHILD_UNSAFE_CONTENT")
        self.assertEqual(safety_report.page_id, PAGE_ID)
        self.assertEqual(safety_report.verified_text_snapshot, repo.revisions[REV_1].VerifiedText)
        # Parent view must NOT expose internal findings or admin reviewer IDs.
        self.assertEqual(safety_report.related_findings, [])
        self.assertIsNone(safety_report.reviewed_by)

        # Duplicate idempotency key returns the exact same report without creating a duplicate.
        dup_report = await service.create_parent_report(
            PARENT_A,
            BOOK_ID,
            BookContentReportCreate(
                idempotency_key=safety_key,
                issue_type="CHILD_UNSAFE_CONTENT",
                description="Gửi lại do mạng chậm.",
                page_id=PAGE_ID,
            ),
        )
        self.assertEqual(dup_report.id, safety_report.id)

        copyright_report = await service.create_parent_report(
            PARENT_A,
            BOOK_ID,
            BookContentReportCreate(
                idempotency_key=uuid4(),
                issue_type="COPYRIGHT_CONCERN",
                description="Nghi ngờ sách này trùng với sách có bản quyền của NXB khác.",
            ),
        )
        self.assertEqual(copyright_report.issue_type, "COPYRIGHT_CONCERN")
        self.assertIsNone(copyright_report.page_id)

        legacy_report = await service.create_parent_report(
            PARENT_A,
            BOOK_ID,
            BookContentReportCreate(
                idempotency_key=uuid4(),
                issue_type="SPELLING_ERROR",
                description="Sai chính tả từ đầu dòng.",
                page_id=PAGE_ID,
            ),
        )
        self.assertEqual(legacy_report.issue_type, "SPELLING_ERROR")

        # 2. Parent B CANNOT read Parent A's report (404 non-enumerating).
        with self.assertRaises(HTTPException) as forbidden_read:
            await service.get_parent_report(PARENT_B, safety_report.id)
        self.assertEqual(forbidden_read.exception.status_code, 404)

        # 3. Parent CANNOT perform Admin actions (403).
        with self.assertRaises(HTTPException) as parent_admin_op:
            await service.update_report_status(
                PARENT_A,
                safety_report.id,
                BookContentReportStatusUpdate(status="RESOLVED", resolution_note="Tự đóng"),
            )
        self.assertEqual(parent_admin_op.exception.status_code, 403)

        # 4. Page revision changes to REV_2: Admin detail preserves original snapshot AND flags page_revision_changed=True!
        repo.page_row.CurrentVerifiedRevisionId = REV_2
        admin_detail = await service.get_admin_report(ADMIN_ID, safety_report.id)
        self.assertEqual(admin_detail.verified_text_snapshot, repo.revisions[REV_1].VerifiedText)
        self.assertEqual(admin_detail.page_revision_id, REV_1)
        self.assertEqual(admin_detail.current_page_revision_id, REV_2)
        self.assertTrue(admin_detail.page_revision_changed)
        self.assertEqual(len(admin_detail.related_findings), 1)

        # 5. Admin transitions status with history and reason; Parent A sees updated status & feedback without internal admin identity.
        updated = await service.update_report_status(
            ADMIN_ID,
            safety_report.id,
            BookContentReportStatusUpdate(
                status="UNDER_REVIEW",
                resolution_note="Admin đang rà soát lại trang 2.",
            ),
        )
        self.assertEqual(updated.status, "UNDER_REVIEW")
        self.assertEqual(len(updated.history), 2)
        parent_view = await service.get_parent_report(PARENT_A, safety_report.id)
        self.assertEqual(parent_view.status, "UNDER_REVIEW")
        self.assertEqual(parent_view.admin_resolution_note, "Admin đang rà soát lại trang 2.")
        self.assertIsNone(parent_view.reviewed_by)
        self.assertIsNone(parent_view.reviewed_by_name)
        self.assertEqual(parent_view.related_findings, [])
        self.assertEqual(parent_view.history[-1].actor_name, "Admin ViRead")

    async def test_rights_profile_full_unknown_and_local_overlap_concerns(self):
        repo = _InMemoryQualityRepo()
        service = BookContentQualityService(repo)

        # 1. Unknown source / missing evidence CANNOT be marked REVIEWED.
        with self.assertRaises(HTTPException) as unknown_err:
            await service.upsert_rights_profile(
                ADMIN_ID,
                BOOK_ID,
                BookContentRightsProfileUpsert(
                    status="REVIEWED",
                    source_name="Không rõ",
                    usage_basis="UNKNOWN",
                ),
            )
        self.assertEqual(unknown_err.exception.status_code, 422)
        self.assertEqual(unknown_err.exception.detail["code"], "RIGHTS_EVIDENCE_REQUIRED")

        # 2. Local catalog overlap check with NO match must NEVER mark REVIEWED automatically.
        no_match = await service.run_rights_corpus_overlap_check(ADMIN_ID, BOOK_ID)
        self.assertEqual(no_match.reference_check_status, "NO_MATCH_IN_ALLOWED_CORPUS")
        self.assertEqual(no_match.status, "NOT_ASSESSED")

        # 3. Local catalog overlap check WITH matching passage marks CONCERNS_FOUND with citation.
        other_book_id = uuid4()
        repo.other_books_pages = [
            (
                other_book_id,
                "Sách Đối Chiếu Khác",
                5,
                "Nội dung trang 2 bản cũ có nhiều câu chuyện hay cho bé.",
            )
        ]
        overlap = await service.run_rights_corpus_overlap_check(ADMIN_ID, BOOK_ID)
        self.assertEqual(overlap.reference_check_status, "OVERLAP_CONCERN")
        self.assertEqual(overlap.status, "CONCERNS_FOUND")
        self.assertEqual(len(overlap.reference_check_evidence), 1)
        self.assertEqual(overlap.reference_check_evidence[0]["source_book_title"], "Sách Đối Chiếu Khác")
        self.assertEqual(overlap.reference_check_evidence[0]["scan_scope"], "INTERNAL_CATALOG_CORPUS")

        # Cannot clear OVERLAP_CONCERN to REVIEWED without an explicit note explaining resolution.
        with self.assertRaises(HTTPException) as overlap_note_err:
            await service.upsert_rights_profile(
                ADMIN_ID,
                BOOK_ID,
                BookContentRightsProfileUpsert(
                    status="REVIEWED",
                    source_name="Tác phẩm tự biên soạn",
                    rights_holder="ViRead",
                    usage_basis="WRITTEN_LICENSE",
                    evidence_reference="HD-2026-09",
                ),
            )
        self.assertEqual(overlap_note_err.exception.status_code, 422)
        self.assertEqual(overlap_note_err.exception.detail["code"], "RIGHTS_OVERLAP_EXPLANATION_REQUIRED")

        # 4. Full valid profile with evidence and resolution note marks REVIEWED and increments version.
        reviewed = await service.upsert_rights_profile(
            ADMIN_ID,
            BOOK_ID,
            BookContentRightsProfileUpsert(
                status="REVIEWED",
                source_name="Tác phẩm tự biên soạn ViRead",
                rights_holder="ViRead Editorial",
                usage_basis="WRITTEN_LICENSE",
                evidence_reference="HD-2026-09",
                evidence_url="https://example.org/contracts/HD-2026-09",
                notes="Đã đối chiếu hợp đồng bản quyền; cùng tác giả phát hành lại.",
            ),
        )
        self.assertEqual(reviewed.status, "REVIEWED")
        self.assertGreaterEqual(reviewed.profile_version, 2)
        self.assertEqual(reviewed.reviewed_by, ADMIN_ID)
        self.assertIsNotNone(reviewed.reviewed_at)

    async def test_child_safety_last_chunk_failure_blocks_and_never_claims_complete(self):
        calls = 0

        def handler(_request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(
                    200,
                    json={
                        "message": {
                            "content": json.dumps({"suitability": "SUITABLE", "findings": []})
                        }
                    },
                )
            return httpx.Response(503, json={"error": "local overloaded"})

        cfg = OcrCorrectionConfig(
            cloud_enabled=False,
            local=LocalOcrConfig(timeout_seconds=2),
        )
        long_text = ("Một câu chuyện vui vẻ ở sân trường tiểu học. " * 260) + "Đoạn cuối."
        with self.assertRaises(ChildSafetyError) as raised:
            await ChildSafetyOrchestrator(
                cfg, transport=httpx.MockTransport(handler)
            ).analyze(long_text)
        self.assertEqual(raised.exception.chunk_id, 1)
        self.assertEqual(raised.exception.code, "PROVIDER_UNAVAILABLE")

    def test_parent_cannot_access_admin_quality_and_rights_routes_via_http(self):
        db = MagicMock()
        db.scalar = AsyncMock(return_value="parent")
        app = FastAPI()
        app.include_router(quality_router, prefix="/books")
        app.dependency_overrides[get_db] = lambda: db
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_A
        client = TestClient(app)

        for method, path, body in (
            ("GET", "/books/admin/quality/books", None),
            ("GET", "/books/admin/quality/reports", None),
            ("GET", f"/books/admin/quality/books/{BOOK_ID}/rights-profile", None),
            (
                "PUT",
                f"/books/admin/quality/books/{BOOK_ID}/rights-profile",
                {"status": "REVIEWED", "source_name": "X", "usage_basis": "OWN_ORIGINAL", "notes": "N"},
            ),
            ("POST", f"/books/admin/quality/books/{BOOK_ID}/rights-profile/overlap-check", None),
        ):
            with self.subTest(method=method, path=path):
                resp = client.request(method, path, json=body)
                self.assertEqual(resp.status_code, 403)


if __name__ == "__main__":
    unittest.main()
