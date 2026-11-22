"""Regression tests for AUD-001, AUD-002, and AUD-003 (Catalog vs Private Book isolation & Moderation state integrity)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
import unittest
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:5432/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy import select

from app.models import BookPage, ParentBookModerationRequest, ParentBookPageSubmission
from app.services.parent_private_book_pipeline import PipelineHooks, process_submission_stages
from parent_private_book_pg_fixture import (
    DisposablePrivateBookDatabase,
    make_synthetic_png,
)


def _clean_ocr(_img_bytes: bytes):
    return (
        "Bé Na đọc truyện cổ tích.",
        [
            {"text": "Bé", "line_index": 0, "bounding_box": [0.1, 0.1, 0.1, 0.05], "ocr_confidence": 0.97},
            {"text": "Na", "line_index": 0, "bounding_box": [0.22, 0.1, 0.1, 0.05], "ocr_confidence": 0.97},
            {"text": "đọc", "line_index": 0, "bounding_box": [0.34, 0.1, 0.12, 0.05], "ocr_confidence": 0.96},
            {"text": "truyện", "line_index": 0, "bounding_box": [0.48, 0.1, 0.16, 0.05], "ocr_confidence": 0.96},
            {"text": "cổ", "line_index": 0, "bounding_box": [0.66, 0.1, 0.1, 0.05], "ocr_confidence": 0.95},
            {"text": "tích.", "line_index": 0, "bounding_box": [0.78, 0.1, 0.14, 0.05], "ocr_confidence": 0.95},
        ],
        {"engine": "test_clean"},
    )


class _CleanProofreader:
    async def correct(self, text_value: str, *_args, on_provider_event=None, **_kwargs) -> str:
        if on_provider_event:
            on_provider_event({
                "provider": "ollama_qwen3_vl",
                "model": "qwen3-vl:4b-instruct-q4_K_M",
                "chunk_id": 0,
                "availability": True,
                "duration_ms": 15,
            })
        return text_value


class _CleanSafety:
    async def analyze(self, _text_value: str):
        return {
            "target": "GRADE_1_TO_5",
            "status": "PROVISIONAL",
            "suitability": "SUITABLE",
            "findings": [],
            "provider_events": [
                {
                    "provider": "ollama_local",
                    "model": "qwen3-vl:4b-instruct-q4_K_M",
                    "stage": "CHILD_SAFETY_SCANNING",
                    "chunk_id": 0,
                    "availability": True,
                    "error_code": None,
                    "duration_ms": 20,
                }
            ],
        }


class _FlaggedLowSafety:
    async def analyze(self, text_value: str):
        return {
            "target": "GRADE_1_TO_5",
            "status": "PROVISIONAL",
            "suitability": "SUITABLE_WITH_GUIDANCE",
            "findings": [
                {
                    "finding_id": "f-low-1",
                    "category": "MILD_CONFLICT",
                    "content_type": "DESCRIPTION",
                    "severity": "LOW",
                    "evidence_text": text_value[:20],
                    "explanation": "Cần người lớn xem qua.",
                    "recommendation": "Admin xem xét.",
                }
            ],
            "provider_events": [
                {
                    "provider": "ollama_local",
                    "model": "qwen3-vl:4b-instruct-q4_K_M",
                    "stage": "CHILD_SAFETY_SCANNING",
                    "chunk_id": 0,
                    "availability": True,
                    "error_code": None,
                    "duration_ms": 20,
                }
            ],
        }


class AuditPrivateBookIsolationAndModerationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fixture = DisposablePrivateBookDatabase()
        self.fixture.setup()
        self.app = self.fixture.build_app()

    async def asyncTearDown(self) -> None:
        await self.fixture.teardown()

    async def _create_clean_committed_private_book(self) -> dict[str, str]:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            res = await client_a.post(
                "/books/my-books",
                json={
                    "title": "Nhật Ký Đọc Riêng Của Bé Na",
                    "author": "Ba của Na",
                    "min_grade": 1,
                    "max_grade": 3,
                    "source_type": "SELF_AUTHORED",
                    "source_note": "Truyện riêng gia đình tự biên soạn.",
                },
            )
            self.assertEqual(res.status_code, 201, res.text)
            book_id = res.json()["id"]

            up = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("na1.png", make_synthetic_png("Be Na doc truyen"), "image/png")},
                data={
                    "idempotency_key": f"aud-{uuid4().hex}",
                    "source_type": "SELF_AUTHORED",
                },
            )
            self.assertEqual(up.status_code, 202, up.text)
            sub_id = up.json()["submissions"][0]["id"]

        hooks = PipelineHooks(
            ocr_fn=_clean_ocr,
            proofread_orchestrator_factory=_CleanProofreader,
            safety_orchestrator_factory=_CleanSafety,
        )
        async with self.fixture.sessions() as db:
            processed = await process_submission_stages(db, UUID(sub_id), hooks=hooks)
            assert processed is not None
            cand_hash = processed.CandidateHash
            version = processed.SubmissionVersion

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            added = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={
                    "expected_submission_version": version,
                    "expected_candidate_hash": cand_hash,
                },
            )
            self.assertEqual(added.status_code, 201, added.text)
            body = added.json()
            return {
                "book_id": book_id,
                "submission_id": sub_id,
                "page_id": body["page_id"],
                "revision_id": body["revision_id"],
            }

    async def test_aud001_catalog_admin_ocr_and_page_routes_reject_parent_private_books(self) -> None:
        seeded = await self._create_clean_committed_private_book()
        book_id = seeded["book_id"]
        page_id = seeded["page_id"]
        revision_id = seeded["revision_id"]

        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            # 1. Catalog Admin page read endpoints must return 404 on private pages
            self.assertEqual(
                (await admin1.get(f"/books/admin/pages/{page_id}/processing")).status_code,
                404,
            )
            self.assertEqual(
                (await admin1.get(f"/books/admin/pages/{page_id}/revisions")).status_code,
                404,
            )
            self.assertEqual(
                (await admin1.get(f"/books/admin/pages/{page_id}/revisions/{revision_id}")).status_code,
                404,
            )
            self.assertEqual(
                (await admin1.get(f"/books/admin/pages/{page_id}/image")).status_code,
                404,
            )
            self.assertEqual(
                (
                    await admin1.get(
                        f"/books/admin/pages/{page_id}/revisions/{revision_id}/ai-workflows/latest"
                    )
                ).status_code,
                404,
            )

            # 2. Catalog Admin OCR mutation endpoints must return 404 and NEVER mutate/retire private books
            self.assertEqual(
                (
                    await admin1.post(
                        f"/books/admin/catalog/{book_id}/pages",
                        files={"image": ("inject.png", make_synthetic_png("Inject"), "image/png")},
                    )
                ).status_code,
                404,
            )
            self.assertEqual(
                (
                    await admin1.post(
                        f"/books/admin/pages/{page_id}/revisions/draft",
                        json={"expected_source_revision_id": revision_id},
                    )
                ).status_code,
                404,
            )
            self.assertEqual(
                (await admin1.delete(f"/books/admin/pages/{page_id}")).status_code,
                404,
            )

        # Verify Parent A's committed private page is still ACTIVE and readable!
        async with self.fixture.sessions() as db:
            page_row = await db.scalar(select(BookPage).where(BookPage.Id == UUID(page_id)))
            assert page_row is not None
            self.assertEqual(page_row.LifecycleStatus, "ACTIVE")

    async def test_aud002_unescalated_clean_private_submission_hidden_from_admin_and_committed_decision_guarded(
        self,
    ) -> None:
        seeded = await self._create_clean_committed_private_book()
        clean_sub_id = seeded["submission_id"]
        book_id = seeded["book_id"]

        # 1. Clean unescalated private submission must NOT be readable via Admin moderation detail/image
        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            self.assertEqual(
                (await admin1.get(f"/books/admin/quality/user-books/submissions/{clean_sub_id}")).status_code,
                404,
            )
            self.assertEqual(
                (
                    await admin1.get(
                        f"/books/admin/quality/user-books/submissions/{clean_sub_id}/image"
                    )
                ).status_code,
                404,
            )

        # 2. Escalated -> Approved -> Added to book: subsequent REJECT / REQUEST_CHANGES on ADDED_TO_BOOK must 409!
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            up2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("flagged.png", make_synthetic_png("Can duyet"), "image/png")},
                data={"idempotency_key": f"aud2-{uuid4().hex}"},
            )
            self.assertEqual(up2.status_code, 202)
            flagged_sub_id = up2.json()["submissions"][0]["id"]

        flagged_hooks = PipelineHooks(
            ocr_fn=_clean_ocr,
            proofread_orchestrator_factory=_CleanProofreader,
            safety_orchestrator_factory=_FlaggedLowSafety,
        )
        async with self.fixture.sessions() as db:
            proc2 = await process_submission_stages(db, UUID(flagged_sub_id), hooks=flagged_hooks)
            assert proc2 is not None
            v2 = proc2.SubmissionVersion
            h2 = proc2.CandidateHash

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            req = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{flagged_sub_id}/request-admin-review",
                json={
                    "expected_submission_version": v2,
                    "expected_candidate_hash": h2,
                    "request_note": "Nhờ Admin duyệt.",
                },
            )
            self.assertEqual(req.status_code, 200)

        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            det = (
                await admin1.get(f"/books/admin/quality/user-books/submissions/{flagged_sub_id}")
            ).json()
            app_res = await admin1.post(
                f"/books/admin/quality/user-books/submissions/{flagged_sub_id}/decision",
                json={
                    "decision": "APPROVE",
                    "reason": "Nội dung phù hợp cho trẻ đọc cùng phụ huynh.",
                    "expected_submission_version": det["submission_version"],
                    "expected_snapshot_hash": det["snapshot_hash"],
                    "expected_lock_version": det["optimistic_lock_version"],
                },
            )
            self.assertEqual(app_res.status_code, 200, app_res.text)

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            add2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{flagged_sub_id}/add-page",
                json={
                    "expected_submission_version": v2,
                    "expected_candidate_hash": h2,
                },
            )
            self.assertEqual(add2.status_code, 201, add2.text)

        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            det_committed = (
                await admin1.get(f"/books/admin/quality/user-books/submissions/{flagged_sub_id}")
            ).json()
            # Attempting REJECT or REQUEST_CHANGES on an already ADDED_TO_BOOK submission must fail with 409!
            for forbidden_decision in ("REJECT", "REQUEST_CHANGES"):
                bad_dec = await admin1.post(
                    f"/books/admin/quality/user-books/submissions/{flagged_sub_id}/decision",
                    json={
                        "decision": forbidden_decision,
                        "reason": "Thử đổi trạng thái bản đã thêm vào sách.",
                        "expected_submission_version": det_committed["submission_version"],
                        "expected_snapshot_hash": det_committed["snapshot_hash"],
                        "expected_lock_version": det_committed["optimistic_lock_version"],
                    },
                )
                self.assertEqual(bad_dec.status_code, 409, bad_dec.text)

    async def test_aud003_admin_suspend_book_closes_open_requests_leases_and_unconsumed_approvals(
        self,
    ) -> None:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            book_res = await client_a.post(
                "/books/my-books",
                json={"title": "Sách Sắp Đình Chỉ", "min_grade": 1, "max_grade": 3},
            )
            book_id = book_res.json()["id"]

            up_pending = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("p1.png", make_synthetic_png("Trang 1"), "image/png")},
                data={"idempotency_key": f"sus1-{uuid4().hex}"},
            )
            sub_pending_id = up_pending.json()["submissions"][0]["id"]

            up_approved = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("p2.png", make_synthetic_png("Trang 2"), "image/png")},
                data={"idempotency_key": f"sus2-{uuid4().hex}"},
            )
            sub_approved_id = up_approved.json()["submissions"][0]["id"]

            up_checking = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("p3.png", make_synthetic_png("Trang 3"), "image/png")},
                data={"idempotency_key": f"sus3-{uuid4().hex}"},
            )
            sub_checking_id = up_checking.json()["submissions"][0]["id"]

        flagged_hooks = PipelineHooks(
            ocr_fn=_clean_ocr,
            proofread_orchestrator_factory=_CleanProofreader,
            safety_orchestrator_factory=_FlaggedLowSafety,
        )
        async with self.fixture.sessions() as db:
            p1 = await process_submission_stages(db, UUID(sub_pending_id), hooks=flagged_hooks)
            assert p1 is not None
            p1_ver, p1_hash = int(p1.SubmissionVersion), p1.CandidateHash
            p2 = await process_submission_stages(db, UUID(sub_approved_id), hooks=flagged_hooks)
            assert p2 is not None
            p2_ver, p2_hash = int(p2.SubmissionVersion), p2.CandidateHash
            # Simulate active worker lease on sub_checking_id
            s3 = await db.scalar(
                select(ParentBookPageSubmission).where(
                    ParentBookPageSubmission.Id == UUID(sub_checking_id)
                )
            )
            assert s3 is not None
            s3.WorkerId = "worker-test-1"
            s3.LeaseExpiresAt = datetime.now(timezone.utc) + timedelta(minutes=5)
            await db.commit()

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_pending_id}/request-admin-review",
                json={
                    "expected_submission_version": p1_ver,
                    "expected_candidate_hash": p1_hash,
                },
            )
            await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_approved_id}/request-admin-review",
                json={
                    "expected_submission_version": p2_ver,
                    "expected_candidate_hash": p2_hash,
                },
            )

        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            det2 = (
                await admin1.get(f"/books/admin/quality/user-books/submissions/{sub_approved_id}")
            ).json()
            await admin1.post(
                f"/books/admin/quality/user-books/submissions/{sub_approved_id}/decision",
                json={
                    "decision": "APPROVE",
                    "reason": "Duyệt tạm trang 2",
                    "expected_submission_version": det2["submission_version"],
                    "expected_snapshot_hash": det2["snapshot_hash"],
                    "expected_lock_version": det2["optimistic_lock_version"],
                },
            )

            # Now suspend the entire book directly via /suspend
            sus = await admin1.post(
                f"/books/admin/quality/user-books/{book_id}/suspend",
                json={"reason": "Phát hiện vi phạm bản quyền nghiêm trọng trên toàn bộ sách."},
            )
            self.assertEqual(sus.status_code, 200, sus.text)

        async with self.fixture.sessions() as db:
            open_reqs = (
                await db.scalars(
                    select(ParentBookModerationRequest).where(
                        ParentBookModerationRequest.BookId == UUID(book_id),
                        ParentBookModerationRequest.Status == "PENDING_ADMIN",
                    )
                )
            ).all()
            self.assertEqual(len(open_reqs), 0)

            s2_after = await db.scalar(
                select(ParentBookPageSubmission).where(
                    ParentBookPageSubmission.Id == UUID(sub_approved_id)
                )
            )
            s3_after = await db.scalar(
                select(ParentBookPageSubmission).where(
                    ParentBookPageSubmission.Id == UUID(sub_checking_id)
                )
            )
            assert s2_after is not None and s3_after is not None
            self.assertIsNone(s2_after.ApprovedSnapshotHash)
            self.assertEqual(s2_after.WorkflowStatus, "REJECTED")
            self.assertIsNone(s3_after.WorkerId)
            self.assertIsNone(s3_after.LeaseExpiresAt)
            self.assertEqual(s3_after.WorkflowStatus, "REJECTED")
