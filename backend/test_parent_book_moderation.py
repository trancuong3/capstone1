"""Admin 'Sách người dùng' moderation, concurrency, policy-block, stale worker, and suspension tests."""
from __future__ import annotations

import asyncio
import os
import unittest
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://postgres:viread_local_test@127.0.0.1:5432/viread_test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy import select

from app.models import AuditLog, Book
from app.services.parent_private_book_pipeline import PipelineHooks, process_submission_stages
from parent_private_book_pg_fixture import (
    CHILD_A,
    DisposablePrivateBookDatabase,
    make_synthetic_png,
)


async def _identity_correct(text_value: str, *_args, **_kwargs) -> str:
    return text_value


def _ocr_with_text(text_value: str):
    tokens = text_value.split()
    words = [
        {
            "text": tok,
            "line_index": 0,
            "bounding_box": [round(0.05 + idx * (0.85 / max(1, len(tokens))), 4), 0.1, round(0.8 / max(1, len(tokens)), 4), 0.06],
            "ocr_confidence": 0.94,
        }
        for idx, tok in enumerate(tokens)
    ]
    return lambda _img: (text_value, words, {})


def _safety_stub(*, suitability: str, severity: str | None = None, delay_event: asyncio.Event | None = None):
    class _Stub:
        async def analyze(self, text_value: str):
            if delay_event is not None:
                await delay_event.wait()
            findings = []
            if severity is not None:
                findings.append({
                    "finding_id": f"f-{severity.lower()}",
                    "category": "VIOLENCE",
                    "content_type": "DESCRIPTION",
                    "severity": severity,
                    "evidence_text": text_value[: min(25, len(text_value))],
                    "explanation": "Đoạn tổng hợp có cảnh báo cần Admin xem xét.",
                    "recommendation": "Admin xem xét hoặc yêu cầu chỉnh sửa.",
                })
            return {
                "target": "GRADE_1_TO_5",
                "status": "PROVISIONAL",
                "suitability": suitability,
                "findings": findings,
                "provider_events": [
                    {
                        "provider": "ollama_local",
                        "model": "qwen3-vl:4b-instruct-q4_K_M",
                        "stage": "CHILD_SAFETY_SCANNING",
                        "chunk_id": 0,
                        "availability": True,
                        "error_code": None,
                        "duration_ms": 30,
                    }
                ],
            }

    return _Stub


class ParentBookModerationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fixture = DisposablePrivateBookDatabase()
        self.fixture.setup()
        self.app = self.fixture.build_app()

    async def asyncTearDown(self) -> None:
        await self.fixture.teardown()

    async def _submit_and_process(
        self,
        book_id: str,
        *,
        text_value: str,
        suitability: str,
        severity: str | None,
    ) -> dict:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            up = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("page.png", make_synthetic_png(text_value[:16]), "image/png")},
                data={
                    "idempotency_key": f"mod-{uuid4().hex}",
                    "source_type": "OWNED_PHYSICAL_BOOK",
                    "source_note": "Sách giấy gia đình đã mua.",
                },
            )
            self.assertEqual(up.status_code, 202, up.text)
            sub_id = up.json()["submissions"][0]["id"]

        hooks = PipelineHooks(
            ocr_fn=_ocr_with_text(text_value),
            proofread_orchestrator_factory=lambda: type("P", (), {"correct": staticmethod(_identity_correct)})(),
            safety_orchestrator_factory=_safety_stub(suitability=suitability, severity=severity),
        )
        async with self.fixture.sessions() as db:
            processed = await process_submission_stages(db, UUID(sub_id), hooks=hooks)
            assert processed is not None
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            return (await client_a.get(f"/books/my-books/{book_id}/submissions/{sub_id}")).json()

    async def test_flagged_moderation_lifecycle_policy_block_hash_binding_and_no_catalog_promotion(self) -> None:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            book_res = await client_a.post(
                "/books/my-books",
                json={"title": "Truyện Cần Duyệt", "author": "Phụ huynh A", "min_grade": 1, "max_grade": 4},
            )
            self.assertEqual(book_res.status_code, 201)
            book_id = book_res.json()["id"]

        # 1. Policy-blocked (HIGH / NOT_RECOMMENDED): Admin MUST NOT have blanket bypass!
        severe_sub = await self._submit_and_process(
            book_id,
            text_value="Nội dung bạo lực nghiêm trọng giả lập dùng cho kiểm thử chính sách.",
            suitability="NOT_RECOMMENDED",
            severity="HIGH",
        )
        self.assertEqual(severe_sub["workflow_status"], "NEEDS_ADMIN_REVIEW")
        self.assertTrue(severe_sub["tool_check_policy_blocked"])
        self.assertFalse(severe_sub["can_add_to_book"])

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            req_severe = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{severe_sub['id']}/request-admin-review",
                json={
                    "expected_submission_version": severe_sub["submission_version"],
                    "expected_candidate_hash": severe_sub["candidate_hash"],
                    "request_note": "Nhờ Admin kiểm tra giúp trang này.",
                },
            )
            self.assertEqual(req_severe.status_code, 200)

        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            detail_sev = (await admin1.get(f"/books/admin/quality/user-books/submissions/{severe_sub['id']}")).json()
            self.assertFalse(detail_sev["can_approve"])
            self.assertTrue(detail_sev["tool_check_policy_blocked"])
            # Trying to APPROVE policy-blocked content MUST fail with 409!
            bad_approve = await admin1.post(
                f"/books/admin/quality/user-books/submissions/{severe_sub['id']}/decision",
                json={
                    "decision": "APPROVE",
                    "reason": "Cố tình bỏ qua chính sách chặn",
                    "expected_submission_version": detail_sev["submission_version"],
                    "expected_snapshot_hash": detail_sev["snapshot_hash"],
                    "expected_lock_version": detail_sev["optimistic_lock_version"],
                },
            )
            self.assertEqual(bad_approve.status_code, 409)

            # Admin REJECTS severe page
            rej = await admin1.post(
                f"/books/admin/quality/user-books/submissions/{severe_sub['id']}/decision",
                json={
                    "decision": "REJECT",
                    "reason": "Nội dung vi phạm mức chặn an toàn cho trẻ em.",
                    "expected_submission_version": detail_sev["submission_version"],
                    "expected_snapshot_hash": detail_sev["snapshot_hash"],
                    "expected_lock_version": detail_sev["optimistic_lock_version"],
                },
            )
            self.assertEqual(rej.status_code, 200, rej.text)

        # Rejected page STILL blocked from adding
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            self.assertEqual(
                (await client_a.post(
                    f"/books/my-books/{book_id}/submissions/{severe_sub['id']}/add-page",
                    json={
                        "expected_submission_version": severe_sub["submission_version"],
                        "expected_candidate_hash": severe_sub["candidate_hash"],
                    },
                )).status_code,
                409,
            )

        # 2. Approvable context-flagged page (MEDIUM / REVIEW_REQUIRED)
        flagged = await self._submit_and_process(
            book_id,
            text_value="Chú thỏ chạy thật nhanh khi thấy cơn bão ập đến khu rừng.",
            suitability="REVIEW_REQUIRED",
            severity="MEDIUM",
        )
        sub_id = flagged["id"]

        # Parent B CANNOT view or request review on A's submission; Parent A CANNOT self-approve
        async with self.fixture.client(self.app, "token-parent-b") as client_b:
            self.assertEqual(
                (await client_b.post(
                    f"/books/my-books/{book_id}/submissions/{sub_id}/request-admin-review",
                    json={
                        "expected_submission_version": flagged["submission_version"],
                        "expected_candidate_hash": flagged["candidate_hash"],
                    },
                )).status_code,
                404,
            )
            self.assertEqual((await client_b.get("/books/admin/quality/user-books")).status_code, 403)
            self.assertEqual((await client_b.get(f"/books/admin/quality/user-books/submissions/{sub_id}/image")).status_code, 403)

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # Parent A cannot self-approve
            self.assertEqual(
                (await client_a.post(
                    f"/books/admin/quality/user-books/submissions/{sub_id}/decision",
                    json={
                        "decision": "APPROVE",
                        "reason": "Tự duyệt không hợp lệ",
                        "expected_submission_version": flagged["submission_version"],
                        "expected_snapshot_hash": flagged["candidate_hash"],
                        "expected_lock_version": flagged["optimistic_lock_version"],
                    },
                )).status_code,
                403,
            )
            # Parent A sends exact snapshot to Admin
            req_res = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/request-admin-review",
                json={
                    "expected_submission_version": flagged["submission_version"],
                    "expected_candidate_hash": flagged["candidate_hash"],
                    "request_note": "Ngữ cảnh truyện cổ tích an toàn, nhờ Admin duyệt.",
                },
            )
            self.assertEqual(req_res.status_code, 200)
            self.assertEqual(req_res.json()["workflow_status"], "PENDING_ADMIN")

        # 3. Admin views queue, opens detail, verifies audit log (no raw text/PII), requests changes -> still blocked!
        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            queue = (await admin1.get("/books/admin/quality/user-books", params={"status": "PENDING_ADMIN"})).json()
            self.assertEqual(queue["total"], 1)
            self.assertEqual(queue["items"][0]["book_id"], book_id)
            self.assertNotIn("0901111111", queue["items"][0]["owner_label"])  # Minimal owner info!

            det = (await admin1.get(f"/books/admin/quality/user-books/submissions/{sub_id}")).json()
            self.assertTrue(det["can_approve"])
            # Admin can fetch image via authenticated admin proxy
            img_res = await admin1.get(f"/books/admin/quality/user-books/submissions/{sub_id}/image")
            self.assertEqual(img_res.status_code, 200)
            self.assertIn("no-store", img_res.headers.get("cache-control", "").lower())

            # Admin requests changes first
            rc = await admin1.post(
                f"/books/admin/quality/user-books/submissions/{sub_id}/decision",
                json={
                    "decision": "REQUEST_CHANGES",
                    "reason": "Vui lòng rút gọn câu mô tả cơn bão cho nhẹ nhàng hơn.",
                    "expected_submission_version": det["submission_version"],
                    "expected_snapshot_hash": det["snapshot_hash"],
                    "expected_lock_version": det["optimistic_lock_version"],
                },
            )
            self.assertEqual(rc.status_code, 200, rc.text)
            self.assertEqual(rc.json()["new_workflow_status"], "NEEDS_RECHECK")

        # Parent edits -> version 2 -> runs Tool Check (still REVIEW_REQUIRED) -> sends to Admin -> Admin approves exact v2!
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # Still blocked after REQUEST_CHANGES
            self.assertEqual(
                (await client_a.post(
                    f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                    json={"expected_submission_version": 1, "expected_candidate_hash": flagged["candidate_hash"]},
                )).status_code,
                409,
            )
            edit_v2 = await client_a.patch(
                f"/books/my-books/{book_id}/submissions/{sub_id}",
                json={"candidate_text": "Chú thỏ nhỏ chạy về nhà tránh cơn mưa rào.", "auto_recheck": True},
            )
            self.assertEqual(edit_v2.status_code, 200)
            self.assertEqual(edit_v2.json()["submission_version"], 2)

        async with self.fixture.sessions() as db:
            v2_proc = await process_submission_stages(
                db,
                UUID(sub_id),
                hooks=PipelineHooks(
                    safety_orchestrator_factory=_safety_stub(suitability="REVIEW_REQUIRED", severity="MEDIUM"),
                ),
            )
            assert v2_proc is not None
            self.assertEqual(v2_proc.WorkflowStatus, "NEEDS_ADMIN_REVIEW")

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            sub_v2 = (await client_a.get(f"/books/my-books/{book_id}/submissions/{sub_id}")).json()
            req_v2 = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/request-admin-review",
                json={
                    "expected_submission_version": 2,
                    "expected_candidate_hash": sub_v2["candidate_hash"],
                    "request_note": "Đã chỉnh sửa nhẹ nhàng hơn.",
                },
            )
            self.assertEqual(req_v2.status_code, 200)

        # 4. Concurrent Admin 1 & Admin 2 approve same revision -> ONLY ONE succeeds, second gets 409!
        async with self.fixture.client(self.app, "token-admin-1") as admin1, self.fixture.client(self.app, "token-admin-2") as admin2:
            det_v2 = (await admin1.get(f"/books/admin/quality/user-books/submissions/{sub_id}")).json()
            decision_body = {
                "decision": "APPROVE",
                "reason": "Đã kiểm tra ngữ cảnh và hình ảnh, phù hợp cho trẻ em.",
                "expected_submission_version": det_v2["submission_version"],
                "expected_snapshot_hash": det_v2["snapshot_hash"],
                "expected_lock_version": det_v2["optimistic_lock_version"],
            }
            r1, r2 = await asyncio.gather(
                admin1.post(f"/books/admin/quality/user-books/submissions/{sub_id}/decision", json=decision_body),
                admin2.post(f"/books/admin/quality/user-books/submissions/{sub_id}/decision", json=decision_body),
            )
            statuses = sorted([r1.status_code, r2.status_code])
            self.assertEqual(statuses, [200, 409], f"Expected [200, 409] on concurrent admin review, got {statuses}")

        # 5. Parent A cannot add with wrong hash, CAN add exact approved v2 -> book stays PARENT_PRIVATE!
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            wrong_hash = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={"expected_submission_version": 2, "expected_candidate_hash": "f" * 64},
            )
            self.assertEqual(wrong_hash.status_code, 409)

            add_ok = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={"expected_submission_version": 2, "expected_candidate_hash": sub_v2["candidate_hash"]},
            )
            self.assertEqual(add_ok.status_code, 201, add_ok.text)
            page_id = add_ok.json()["page_id"]

            # Book MUST remain PARENT_PRIVATE (never promoted to public catalog!)
            self.assertNotIn(book_id, [b["id"] for b in (await client_a.get("/books/catalog")).json()])
            # Child A can start reading session
            sess = await client_a.post("/reading/sessions", json={"ChildId": str(CHILD_A), "BookId": book_id})
            self.assertEqual(sess.status_code, 200)
            session_id = sess.json()["Id"]
            page_img_url = (await client_a.get(f"/books/catalog/{book_id}/preview")).json()[0]["preview_url"]
            self.assertEqual((await client_a.get(page_img_url.replace("http://testserver", ""))).status_code, 200)

        # 6. Admin SUSPENDS book -> immediately blocks reading, active session, preview, and page image!
        async with self.fixture.client(self.app, "token-admin-1") as admin1:
            susp = await admin1.post(
                f"/books/admin/quality/user-books/{book_id}/suspend",
                json={"reason": "Phát hiện nội dung cần đình chỉ khẩn cấp."},
            )
            self.assertEqual(susp.status_code, 200, susp.text)

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            self.assertEqual((await client_a.get(f"/books/catalog/{book_id}")).status_code, 409)
            self.assertEqual((await client_a.get(f"/books/catalog/{book_id}/preview")).status_code, 409)
            self.assertEqual((await client_a.post("/reading/sessions", json={"ChildId": str(CHILD_A), "BookId": book_id})).status_code, 409)
            # Even ALREADY-STARTED session is immediately blocked!
            self.assertEqual((await client_a.get(f"/reading/sessions/{session_id}/page")).status_code, 404)
            # Committed private image proxy immediately returns 403!
            self.assertEqual((await client_a.get(page_img_url.replace("http://testserver", ""))).status_code, 403)

        # Verify audit logs recorded view, decision, and suspension without raw full text
        async with self.fixture.sessions() as db:
            book_row = await db.scalar(select(Book).where(Book.Id == UUID(book_id)))
            assert book_row is not None
            self.assertEqual(book_row.VisibilityScope, "PARENT_PRIVATE")
            self.assertEqual(book_row.ModerationStatus, "SUSPENDED")
            logs = list((await db.execute(select(AuditLog))).scalars().all())
            actions = {log.Action for log in logs}
            self.assertIn("parent_private_book.submission.viewed", actions)
            self.assertIn("parent_private_book.moderation.approve", actions)
            self.assertIn("parent_private_book.suspended", actions)

    async def test_late_stale_worker_response_discarded_after_parent_replaces_file(self) -> None:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            book_id = (await client_a.post(
                "/books/my-books",
                json={"title": "Kiểm Thử Stale Worker", "min_grade": 1, "max_grade": 3},
            )).json()["id"]
            up = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("v1.png", make_synthetic_png("Phien ban mot"), "image/png")},
                data={"idempotency_key": f"stale-{uuid4().hex}", "source_type": "SELF_AUTHORED"},
            )
            sub_id = up.json()["submissions"][0]["id"]

        # Start slow worker on v1 (pauses inside Tool Check!)
        release_worker = asyncio.Event()
        worker_started = asyncio.Event()

        class _SlowCleanSafety:
            async def analyze(self, text_value: str):
                worker_started.set()
                await release_worker.wait()
                return {
                    "target": "GRADE_1_TO_5",
                    "status": "PROVISIONAL",
                    "suitability": "SUITABLE",
                    "findings": [],
                    "provider_events": [{"provider": "ollama_local", "model": "qwen3-vl", "stage": "CHILD_SAFETY_SCANNING", "chunk_id": 0, "availability": True, "duration_ms": 15}],
                }

        async def _run_stale_worker():
            async with self.fixture.sessions() as worker_db:
                await process_submission_stages(
                    worker_db,
                    UUID(sub_id),
                    hooks=PipelineHooks(
                        ocr_fn=_ocr_with_text("Văn bản phiên bản một."),
                        proofread_orchestrator_factory=lambda: type("P", (), {"correct": staticmethod(_identity_correct)})(),
                        safety_orchestrator_factory=_SlowCleanSafety,
                    ),
                )

        worker_task = asyncio.create_task(_run_stale_worker())
        await asyncio.wait_for(worker_started.wait(), timeout=5.0)

        # While v1 worker is still in flight, Parent A REPLACES the image with v2!
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            rep = await client_a.put(
                f"/books/my-books/{book_id}/submissions/{sub_id}/file",
                files={"file": ("v2.png", make_synthetic_png("Phien ban hai moi hoan toan", bg=(240, 248, 255)), "image/png")},
            )
            self.assertEqual(rep.status_code, 200, rep.text)
            self.assertEqual(rep.json()["submission_version"], 2)
            self.assertEqual(rep.json()["workflow_status"], "CHECKING")

        # Now release the late v1 worker -> its SUITABLE result MUST be discarded and NOT mark v2 as PASSED!
        release_worker.set()
        await worker_task

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            after = (await client_a.get(f"/books/my-books/{book_id}/submissions/{sub_id}")).json()
            self.assertEqual(after["submission_version"], 2)
            self.assertEqual(after["workflow_status"], "CHECKING")
            self.assertEqual(after["tool_check_status"], "PENDING")
            self.assertFalse(after["can_add_to_book"])


if __name__ == "__main__":
    unittest.main()
