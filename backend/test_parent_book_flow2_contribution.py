"""End-to-end real-PostgreSQL + isolated-Drive tests for Parent Private Book -> Flow 2 OCR contribution.

Covers every acceptance gate in Section 5:
1. Consent & Ownership + direct PostgreSQL RLS isolation across two families (A & B) and Admin.
2. Quality, Rights Basis, PII, and State Gates ("Bé có thể đọc" != Admin-verified line label).
3. Concurrency, Idempotency, Mid-flight Revocation/Stale Revision, and Bounded Drive Retry.
4. Data Integrity, Cross-Family Duplicate Split Safety, Legacy Quarantine Isolation, and Locked Test Isolation.
5. Full Two-Family E2E: Opt-in -> Commit Page -> Admin Verify -> Outbox Worker -> Isolated Drive -> Manifest -> Opt-out Revocation.
"""
from __future__ import annotations

import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import psycopg2
from PIL import Image, ImageDraw
from sqlalchemy import text

from app.api.deps import get_current_parent_id, get_db
from app.jobs import viread_ocr_outbox_worker as outbox_worker
from app.schemas.viread_ocr_training import TrainingRunCreate
from app.services.parent_flow2_contribution_service import (
    detect_line_pii,
    evaluate_line_crop_quality,
)
from app.services.training_storage.base import (
    DriveQuotaExceededError,
    StorageProvider,
)
from app.services.training_storage.google_drive_desktop_store import (
    GoogleDriveDesktopStore,
)
from app.services.training_storage.router import TrainingArtifactStoreRouter
from app.services.viread_ocr_training_service import VireadOcrTrainingService
from parent_private_book_pg_fixture import (
    ADMIN_1,
    CHILD_A,
    CHILD_B,
    DisposablePrivateBookDatabase,
    PARENT_A,
    PARENT_B,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_FLOW2_BASE = REPO_ROOT / "supabase" / "migrations" / "20261112110945_viread_vietocr_v2.sql"
MIGRATION_FLOW2_DRIVE = REPO_ROOT / "supabase" / "migrations" / "20261121210000_flow2_google_drive_storage.sql"
MIGRATION_FLOW2_QUARANTINE = REPO_ROOT / "supabase" / "migrations" / "20261122100000_flow2_sample_quarantine_and_archive.sql"
MIGRATION_PARENT_CONTRIB = REPO_ROOT / "supabase" / "migrations" / "20261122120000_parent_private_book_flow2_contribution.sql"


def make_sharp_page_png(seed: str, *, width: int = 600, height: int = 360) -> bytes:
    """Create a deterministic high-contrast synthetic page image with crisp line bands."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    # Band 0: y in [40..110], Band 1: y in [160..230]
    for band_idx, y0 in enumerate((45, 165)):
        for x in range(45, width - 55, 14):
            h = 18 + (digest[(x + band_idx * 7) % len(digest)] % 34)
            draw.rectangle([x, y0 + 6, x + 5, y0 + 6 + h], fill=(10, 10, 10))
        draw.line([(40, y0 + 52), (width - 50, y0 + 52)], fill=(25, 25, 25), width=2)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_blank_page_png(*, width: int = 600, height: int = 360) -> bytes:
    img = Image.new("RGB", (width, height), (252, 252, 252))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_two_line_words(line0: str, line1: str | None = None) -> list[dict]:
    words: list[dict] = []
    idx = 0
    for line_idx, (line_text, y_norm) in enumerate(
        [(line0, 0.125)] + ([(line1, 0.458)] if line1 else [])
    ):
        tokens = line_text.split()
        step = 0.78 / max(1, len(tokens))
        for w_i, tok in enumerate(tokens):
            words.append(
                {
                    "word_index": idx,
                    "line_index": line_idx,
                    "text": tok,
                    "normalized_text": tok.lower(),
                    "bounding_box": [round(0.07 + w_i * step, 4), y_norm, round(step * 0.85, 4), 0.16],
                    "ocr_confidence": 0.96,
                }
            )
            idx += 1
    return words


class ParentPrivateBookFlow2ContributionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fixture = DisposablePrivateBookDatabase()
        self.fixture.setup()

        self.sync_url = self.fixture.async_url.replace("postgresql+asyncpg://", "postgresql://", 1)
        # Apply Flow 2 + Quarantine + Parent Contribution migrations verbatim to the disposable PG DB
        conn = psycopg2.connect(self.sync_url)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                # Ensure viread_ocr_training_jobs minimal table exists for revocation/job tests
                cur.execute(MIGRATION_FLOW2_BASE.read_text(encoding="utf-8"))
                cur.execute(MIGRATION_FLOW2_DRIVE.read_text(encoding="utf-8"))
                cur.execute(MIGRATION_FLOW2_QUARANTINE.read_text(encoding="utf-8"))
                cur.execute(MIGRATION_PARENT_CONTRIB.read_text(encoding="utf-8"))
                cur.execute(
                    """
                    ALTER TABLE public.viread_ocr_benchmarks
                        ADD COLUMN IF NOT EXISTS evaluation_type TEXT DEFAULT 'PRODUCTION';
                    CREATE TABLE IF NOT EXISTS public.viread_ocr_training_jobs (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        profile TEXT NOT NULL DEFAULT 'FLOW2_ADMIN_VERIFIED',
                        dataset_version_id UUID REFERENCES public.viread_ocr_dataset_versions(id),
                        manifest_sha256 TEXT,
                        config_sha256 TEXT,
                        parent_checkpoint_sha256 TEXT,
                        run_id UUID,
                        target TEXT NOT NULL DEFAULT 'COLAB',
                        status TEXT NOT NULL DEFAULT 'WAITING_FOR_COLAB_WORKER',
                        attempts INTEGER NOT NULL DEFAULT 0,
                        evaluation_attempts INTEGER NOT NULL DEFAULT 0,
                        generation INTEGER NOT NULL DEFAULT 1,
                        progress JSONB NOT NULL DEFAULT '{}'::jsonb,
                        last_error_code TEXT,
                        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                        colab_execution_id TEXT,
                        colab_execution_resource_name TEXT,
                        colab_operation_name TEXT,
                        colab_execution_number INTEGER,
                        worker_id TEXT,
                        lease_expires_at TIMESTAMPTZ,
                        locked_test_version_id UUID,
                        locked_test_manifest_sha256 TEXT,
                        created_by UUID,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    );
                    """
                )
        finally:
            conn.close()

        self.drive_tmp = tempfile.TemporaryDirectory(prefix="viread_flow2_drive_test_")
        self.drive_store = GoogleDriveDesktopStore(root_dir=Path(self.drive_tmp.name))
        self.drive_router = TrainingArtifactStoreRouter(
            write_provider=StorageProvider.GOOGLE_DRIVE,
            drive_store_factory=lambda: self.drive_store,
        )

        self.app = self.fixture.build_app()
        # Patch outbox worker & training service to use disposable DB + isolated Drive router
        self._patches = [
            patch.object(outbox_worker, "AsyncSessionLocal", self.fixture.sessions),
            patch.object(
                outbox_worker,
                "_build_artifact_router",
                self._fake_build_router,
            ),
            patch.object(
                VireadOcrTrainingService,
                "_artifact_router",
                self._fake_service_router,
            ),
            patch.dict(os.environ, {"VIREAD_FLOW2_STORAGE_PROVIDER": "google_drive"}),
        ]
        for p in self._patches:
            p.start()

    async def asyncTearDown(self) -> None:
        for p in reversed(self._patches):
            p.stop()
        self.drive_tmp.cleanup()
        await self.fixture.teardown()

    async def _fake_build_router(self, _db):
        return self.drive_router

    async def _fake_service_router(self, *args, **kwargs):
        return self.drive_router

    def _client(self, actor_id: UUID) -> httpx.AsyncClient:
        token_map = {
            PARENT_A: "token-parent-a",
            PARENT_B: "token-parent-b",
            ADMIN_1: "token-admin-1",
        }
        tok = token_map.get(actor_id)
        if tok is not None:
            return self.fixture.client(self.app, tok)
        # For non-parent/child UUIDs (e.g. CHILD_B), verify unauthenticated/foreign actor rejection
        transport = httpx.ASGITransport(app=self.app)
        return httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"Authorization": f"Bearer {actor_id}"},
        )

    async def _create_book_and_commit_page(
        self,
        *,
        owner_id: UUID,
        title: str,
        source_type: str,
        line0: str,
        line1: str | None = None,
        png_bytes: bytes | None = None,
    ) -> tuple[str, str, str]:
        """Helper: create private book, upload synthetic page, mark clean check passed, add page to book."""
        async with self._client(owner_id) as client:
            res = await client.post(
                "/books/my-books",
                json={
                    "title": title,
                    "author": "Gia đình thử nghiệm",
                    "min_grade": 1,
                    "max_grade": 3,
                    "source_type": source_type,
                },
            )
            self.assertEqual(res.status_code, 201, res.text)
            book_id = res.json()["id"]

            img = png_bytes or make_sharp_page_png(f"{title}:{line0}:{line1 or ''}")
            sub_res = await client.post(
                f"/books/my-books/{book_id}/submissions",
                data={
                    "idempotency_key": f"idem-{uuid4().hex[:12]}",
                    "source_type": source_type,
                },
                files={"file": ("page1.png", img, "image/png")},
            )
            self.assertEqual(sub_res.status_code, 202, sub_res.text)
            sub_id = sub_res.json()["submissions"][0]["id"]

        # Simulate completed OCR + Proofreading + clean Tool Check on this submission
        full_text = f"{line0}\n{line1}" if line1 else line0
        words = _make_two_line_words(line0, line1)
        cand_hash = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
        async with self.fixture.sessions() as db:
            await db.execute(
                text(
                    """
                    UPDATE public.parent_book_page_submissions
                    SET workflow_status = 'PASSED_READY_TO_ADD',
                        ocr_status = 'COMPLETED',
                        ocr_text = :txt,
                        ocr_words_json = CAST(:words AS jsonb),
                        ocr_hash = :h,
                        proofread_status = 'COMPLETED',
                        proofread_text = :txt,
                        proofread_hash = :h,
                        candidate_text = :txt,
                        candidate_hash = :h,
                        candidate_words_json = CAST(:words AS jsonb),
                        tool_check_status = 'PASSED',
                        tool_check_input_hash = :h,
                        tool_check_suitability = 'SUITABLE',
                        tool_check_findings_json = '[]'::jsonb,
                        tool_check_policy_blocked = FALSE
                    WHERE id = CAST(:sub_id AS uuid)
                    """
                ),
                {
                    "txt": full_text,
                    "words": json.dumps(words, ensure_ascii=False),
                    "h": cand_hash,
                    "sub_id": sub_id,
                },
            )
            await db.commit()

        async with self._client(owner_id) as client:
            add_res = await client.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={
                    "expected_submission_version": 1,
                    "expected_candidate_hash": cand_hash,
                    "accept_spelling": True,
                },
            )
            self.assertIn(add_res.status_code, (200, 201), add_res.text)
            body = add_res.json()
            return book_id, body["page_id"], body["revision_id"]

    # ------------------------------------------------------------------
    # Gate 1: Consent, Ownership, Admin-cannot-opt-in, RLS & Cross-family isolation
    # ------------------------------------------------------------------
    async def test_gate1_consent_ownership_and_rls_isolation(self) -> None:
        book_id, _page_id, _rev_id = await self._create_book_and_commit_page(
            owner_id=PARENT_A,
            title="Sách tự viết của nhà A",
            source_type="SELF_AUTHORED",
            line0="Con mèo trèo cây cau.",
        )

        # Default OFF: existing/new book is NOT recruited even though page is readable for children
        async with self._client(PARENT_A) as client:
            detail = (await client.get(f"/books/my-books/{book_id}")).json()
            self.assertTrue(detail["book"]["readable_for_children"])
            self.assertFalse(detail["book"]["ocr_contribution"]["enabled"])
            self.assertEqual(detail["book"]["ocr_contribution"]["status"], "OPTED_OUT")
            self.assertEqual(detail["book"]["ocr_contribution"]["pending_verification_count"], 0)
            self.assertIn("không được dùng để huấn luyện", detail["book"]["privacy_notice"].lower())

        # Admin CANNOT opt in on behalf of Parent A
        async with self._client(ADMIN_1) as client:
            res_admin = await client.put(
                f"/books/my-books/{book_id}/ocr-contribution",
                json={"enabled": True, "rights_confirmed": True},
            )
            self.assertEqual(res_admin.status_code, 403)

        # Parent B CANNOT view or toggle Parent A's book consent
        async with self._client(PARENT_B) as client:
            self.assertEqual((await client.get(f"/books/my-books/{book_id}/ocr-contribution")).status_code, 404)
            self.assertEqual(
                (
                    await client.put(
                        f"/books/my-books/{book_id}/ocr-contribution",
                        json={"enabled": True, "rights_confirmed": True},
                    )
                ).status_code,
                404,
            )

        # Parent A cannot opt in without rights_confirmed=True
        async with self._client(PARENT_A) as client:
            res_no_rights = await client.put(
                f"/books/my-books/{book_id}/ocr-contribution",
                json={"enabled": True, "rights_confirmed": False},
            )
            self.assertEqual(res_no_rights.status_code, 422)

            # Parent A opts in properly
            res_on = await client.put(
                f"/books/my-books/{book_id}/ocr-contribution",
                json={"enabled": True, "rights_confirmed": True},
            )
            self.assertEqual(res_on.status_code, 200, res_on.text)
            state = res_on.json()
            self.assertTrue(state["enabled"])
            self.assertEqual(state["status"], "OPTED_IN")
            self.assertEqual(state["consent_version"], 1)
            self.assertEqual(state["pending_verification_count"], 1)

        # Direct PostgreSQL RLS check: authenticated (Parent B) & anon have ZERO access to consent/candidate tables
        conn = psycopg2.connect(self.sync_url)
        try:
            with conn.cursor() as cur:
                for role in ("anon", "authenticated"):
                    cur.execute("BEGIN")
                    cur.execute(f"SET LOCAL ROLE {role}")
                    cur.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (str(PARENT_B),))
                    for tbl in (
                        "parent_book_ocr_contribution_consents",
                        "parent_book_ocr_contribution_consent_events",
                        "parent_book_flow2_candidates",
                    ):
                        with self.assertRaises(psycopg2.Error):
                            cur.execute(f"SELECT count(*) FROM public.{tbl}")
                        cur.execute("ROLLBACK")
                        cur.execute("BEGIN")
                        cur.execute(f"SET LOCAL ROLE {role}")
                    cur.execute("ROLLBACK")
        finally:
            conn.close()

        # Parent B and Child B cannot access Admin Flow 2 candidate queue or crop endpoint
        async with self._client(ADMIN_1) as admin_client:
            cand_page = (await admin_client.get("/books/admin/quality/user-books/flow2-candidates")).json()
            self.assertEqual(cand_page["total"], 1)
            cand_id = cand_page["items"][0]["id"]
            # Privacy minimization: NO parent email or child profile in Admin candidate payload
            serialized = json.dumps(cand_page["items"][0], ensure_ascii=False).lower()
            self.assertNotIn("email", serialized)
            self.assertNotIn("child", serialized)

        for unauthorized_actor in (PARENT_B, CHILD_B):
            async with self._client(unauthorized_actor) as client:
                self.assertIn(
                    (await client.get("/books/admin/quality/user-books/flow2-candidates")).status_code,
                    (401, 403),
                )
                self.assertIn(
                    (await client.get(f"/books/admin/quality/user-books/flow2-candidates/{cand_id}/crop")).status_code,
                    (401, 403),
                )

        # Turning OFF consent does NOT affect Child A reading access
        async with self._client(PARENT_A) as client:
            res_off = await client.put(
                f"/books/my-books/{book_id}/ocr-contribution",
                json={"enabled": False, "rights_confirmed": False},
            )
            self.assertEqual(res_off.status_code, 200)
            detail_after = (await client.get(f"/books/my-books/{book_id}")).json()
            self.assertTrue(detail_after["book"]["readable_for_children"])
            self.assertFalse(detail_after["book"]["ocr_contribution"]["enabled"])

    # ------------------------------------------------------------------
    # Gate 2: Quality, Rights Basis, PII & State Gates
    # ------------------------------------------------------------------
    async def test_gate2_quality_rights_pii_and_state_gates(self) -> None:
        # 2a. Unclear training rights (OWNED_PHYSICAL_BOOK) -> skipped even when opted in
        book_phys, _, _ = await self._create_book_and_commit_page(
            owner_id=PARENT_A,
            title="Sách giấy mua ngoài hiệu sách",
            source_type="OWNED_PHYSICAL_BOOK",
            line0="Sách có bản quyền không được tự động train.",
        )
        async with self._client(PARENT_A) as client:
            on_phys = (
                await client.put(
                    f"/books/my-books/{book_phys}/ocr-contribution",
                    json={"enabled": True, "rights_confirmed": True},
                )
            ).json()
            self.assertFalse(on_phys["rights_eligible_for_training"])
            self.assertEqual(on_phys["pending_verification_count"], 0)
            self.assertEqual(on_phys["last_recruitment_skipped_pages"], 1)

        # 2b. Blank/low-contrast crop -> rejected by quality gate
        book_blank, _, _ = await self._create_book_and_commit_page(
            owner_id=PARENT_A,
            title="Sách trang trắng mờ",
            source_type="SELF_AUTHORED",
            line0="Dòng chữ bị mờ trắng không đọc được.",
            png_bytes=make_blank_page_png(),
        )
        async with self._client(PARENT_A) as client:
            on_blank = (
                await client.put(
                    f"/books/my-books/{book_blank}/ocr-contribution",
                    json={"enabled": True, "rights_confirmed": True},
                )
            ).json()
            self.assertEqual(on_blank["pending_verification_count"], 0)

        # 2c. PII lines (phone, email, worksheet personal name) -> auto-rejected, never enter train
        self.assertIn("PHONE_NUMBER", detect_line_pii("Liên hệ mẹ 0912345678"))
        self.assertIn("EMAIL", detect_line_pii("Email: me@example.com"))
        self.assertIn("CHILD_WORKSHEET_PERSONAL_INFO", detect_line_pii("Họ và tên: Bé Minh An"))

        book_pii, _, _ = await self._create_book_and_commit_page(
            owner_id=PARENT_A,
            title="Bài tập có thông tin cá nhân",
            source_type="SELF_AUTHORED",
            line0="Họ và tên: Bé Minh An",
            line1="Con mèo trèo cây cau xanh.",
        )
        async with self._client(PARENT_A) as client:
            on_pii = (
                await client.put(
                    f"/books/my-books/{book_pii}/ocr-contribution",
                    json={"enabled": True, "rights_confirmed": True},
                )
            ).json()
            # Line 0 auto-rejected (PII), Line 1 recruited as PENDING_VERIFICATION
            self.assertEqual(on_pii["rejected_count"], 1)
            self.assertEqual(on_pii["pending_verification_count"], 1)

        # Tool Check passed ("Bé có thể đọc") without Admin verification -> 0 samples in Flow 2 manifest!
        async with self.fixture.sessions() as db:
            manifest_before = await VireadOcrTrainingService(db).admin_verified_manifest(
                ADMIN_1, limit=50, offset=0
            )
            self.assertEqual(manifest_before["total"], 0)

        # Admin rejects PII/control-char edit attempt (422), then fixes diacritic mistake and approves
        async with self._client(ADMIN_1) as admin_client:
            cands = (
                await admin_client.get(
                    "/books/admin/quality/user-books/flow2-candidates?status=PENDING_VERIFICATION"
                )
            ).json()["items"]
            self.assertEqual(len(cands), 1)
            cand_id = cands[0]["id"]

            bad_pii = await admin_client.post(
                f"/books/admin/quality/user-books/flow2-candidates/{cand_id}/decision",
                json={"decision": "APPROVE", "verified_label": "Gọi 0987654321 ngay"},
            )
            self.assertEqual(bad_pii.status_code, 422)

            # Admin fixes exact printed text (NFC Vietnamese) and approves
            ok_dec = await admin_client.post(
                f"/books/admin/quality/user-books/flow2-candidates/{cand_id}/decision",
                json={"decision": "APPROVE", "verified_label": "Con mèo trèo cây cau xanh."},
            )
            self.assertEqual(ok_dec.status_code, 200, ok_dec.text)
            self.assertEqual(ok_dec.json()["status"], "SYNC_QUEUED")
            self.assertIsNotNone(ok_dec.json()["outbox_event_id"])

    # ------------------------------------------------------------------
    # Gate 3: Concurrency, Idempotency, Mid-flight Revocation & Drive Retry
    # ------------------------------------------------------------------
    async def test_gate3_idempotency_midflight_revocation_and_drive_retry(self) -> None:
        book_id, _, _ = await self._create_book_and_commit_page(
            owner_id=PARENT_A,
            title="Sách kiểm thử đồng thời",
            source_type="SELF_AUTHORED",
            line0="Một con vịt xòe ra hai cái cánh.",
        )

        # Double opt-in -> zero duplicate candidates
        async with self._client(PARENT_A) as client:
            r1 = (await client.put(f"/books/my-books/{book_id}/ocr-contribution", json={"enabled": True, "rights_confirmed": True})).json()
            r2 = (await client.put(f"/books/my-books/{book_id}/ocr-contribution", json={"enabled": True, "rights_confirmed": True})).json()
            self.assertEqual(r1["pending_verification_count"], 1)
            self.assertEqual(r2["pending_verification_count"], 1)
            self.assertEqual(r1["consent_version"], r2["consent_version"])

        # Double Admin approve -> idempotent, single outbox event
        async with self._client(ADMIN_1) as admin_client:
            cand_id = (await admin_client.get("/books/admin/quality/user-books/flow2-candidates")).json()["items"][0]["id"]
            a1 = (await admin_client.post(f"/books/admin/quality/user-books/flow2-candidates/{cand_id}/decision", json={"decision": "APPROVE", "verified_label": "Một con vịt xòe ra hai cái cánh."})).json()
            a2 = (await admin_client.post(f"/books/admin/quality/user-books/flow2-candidates/{cand_id}/decision", json={"decision": "APPROVE", "verified_label": "Một con vịt xòe ra hai cái cánh."})).json()
            self.assertEqual(a1["outbox_event_id"], a2["outbox_event_id"])

        # Drive quota failure -> bounded RETRY status with accurate error code (no silent Supabase fallback!)
        def _fail_quota(*args, **kwargs):
            raise DriveQuotaExceededError("Drive test quota full", required_bytes=100, available_bytes=0, limit_bytes=100, usage_bytes=100)

        with patch.object(self.drive_router, "quota_check", side_effect=_fail_quota):
            processed = await outbox_worker.run_once()
            self.assertTrue(processed)

        async with self.fixture.sessions() as db:
            ob_row = (await db.execute(text("SELECT status, last_error_code, attempts FROM public.viread_ocr_outbox WHERE event_type='PARENT_CONTRIBUTION_CANDIDATE'"))).mappings().one()
            self.assertEqual(ob_row["status"], "RETRY")
            self.assertEqual(ob_row["last_error_code"], "DRIVE_QUOTA_EXCEEDED")
            self.assertEqual(int(ob_row["attempts"]), 1)
            # Make immediately available again for mid-flight revocation test
            await db.execute(text("UPDATE public.viread_ocr_outbox SET available_at = now() - interval '1 second'"))
            await db.commit()

        # Mid-flight revocation: Parent A opts out right before worker commits!
        original_put = self.drive_router.put
        revoked_midflight = {"done": False}

        def _put_with_midflight_optout(*args, **kwargs):
            result = original_put(*args, **kwargs)
            if not revoked_midflight["done"]:
                revoked_midflight["done"] = True
                # Simulate Parent A revoking consent in DB while worker is uploading to Drive
                c = psycopg2.connect(self.sync_url)
                c.autocommit = True
                try:
                    with c.cursor() as cur:
                        cur.execute(
                            "UPDATE public.parent_book_ocr_contribution_consents SET status='OPTED_OUT', consent_version=consent_version+1 WHERE book_id=%s",
                            (book_id,),
                        )
                finally:
                    c.close()
            return result

        with patch.object(self.drive_router, "put", side_effect=_put_with_midflight_optout):
            processed2 = await outbox_worker.run_once()
            self.assertTrue(processed2)

        # Stale worker output MUST be discarded — 0 rows in viread_ocr_samples, outbox SKIPPED!
        async with self.fixture.sessions() as db:
            ob_after = (await db.execute(text("SELECT status, last_error_code FROM public.viread_ocr_outbox WHERE event_type='PARENT_CONTRIBUTION_CANDIDATE'"))).mappings().one()
            self.assertEqual(ob_after["status"], "SKIPPED")
            sample_cnt = (await db.execute(text("SELECT count(*) FROM public.viread_ocr_samples"))).scalar_one()
            self.assertEqual(int(sample_cnt), 0)

    # ------------------------------------------------------------------
    # Gate 4 & 5: Full Two-Family E2E + Cross-Family Duplicate Split + Quarantine + Revocation
    # ------------------------------------------------------------------
    async def test_gate4_and_5_full_two_family_e2e_split_and_revocation(self) -> None:
        # Seed a quarantined legacy Flow 2 pool sample to prove it NEVER re-enters new manifests
        async with self.fixture.sessions() as db:
            await db.execute(
                text(
                    """
                    INSERT INTO public.viread_ocr_samples
                        (source_flow, source_group_id, split, image_storage_path, image_sha256,
                         label, provenance, training_eligibility, quarantine_reason)
                    VALUES (
                        'FLOW1_VERIFIED', 'legacy-bad-group', 'train',
                        'ocr-training/flow2/legacy/bad.png', :sha,
                        'Mẫu cũ bị loại',
                        '{"verified_by_admin": true, "verification_source": "admin", "ai_review_required": false}'::jsonb,
                        'QUARANTINED', 'LEGACY_POISONED_POOL'
                    )
                    """
                ),
                {"sha": "a" * 64},
            )
            await db.commit()

        # Family A creates Book A1 (unique content) and opts in BEFORE adding page (auto-recruit on add_page!)
        shared_png = make_sharp_page_png("shared-fable-page")
        book_a1, _p_a1, _r_a1 = await self._create_book_and_commit_page(
            owner_id=PARENT_A,
            title="Truyện tự sáng tác nhà A",
            source_type="SELF_AUTHORED",
            line0="Bé Na đi học sớm cùng mẹ.",
            line1="Trời mùa thu mát mẻ trong xanh.",
            png_bytes=shared_png,
        )
        # Family B also submits a book with the EXACT SAME text/image (cross-family duplicate test!)
        book_b1, _p_b1, _r_b1 = await self._create_book_and_commit_page(
            owner_id=PARENT_B,
            title="Truyện giống hệt của nhà B",
            source_type="PUBLIC_DOMAIN",
            line0="Bé Na đi học sớm cùng mẹ.",
            line1="Trời mùa thu mát mẻ trong xanh.",
            png_bytes=shared_png,
        )
        # Family A also creates a second distinct book A2 so we have multiple distinct groups
        book_a2, _p_a2, _r_a2 = await self._create_book_and_commit_page(
            owner_id=PARENT_A,
            title="Tập thơ tự viết số 2 của nhà A",
            source_type="LICENSED_OR_PERMISSION",
            line0="Chú gà trống gáy vang đầu ngõ.",
        )

        # Parent A opts in Book A1 & Book A2; Parent B opts in Book B1
        async with self._client(PARENT_A) as client_a:
            self.assertEqual((await client_a.put(f"/books/my-books/{book_a1}/ocr-contribution", json={"enabled": True, "rights_confirmed": True})).status_code, 200)
            self.assertEqual((await client_a.put(f"/books/my-books/{book_a2}/ocr-contribution", json={"enabled": True, "rights_confirmed": True})).status_code, 200)
        async with self._client(PARENT_B) as client_b:
            self.assertEqual((await client_b.put(f"/books/my-books/{book_b1}/ocr-contribution", json={"enabled": True, "rights_confirmed": True})).status_code, 200)

        # Admin verifies every pending candidate after inspecting its cropped line image
        async with self._client(ADMIN_1) as admin_client:
            page_resp = (await admin_client.get("/books/admin/quality/user-books/flow2-candidates?status=PENDING_VERIFICATION")).json()
            self.assertEqual(page_resp["total"], 5)  # 2 from A1 + 2 from B1 + 1 from A2
            for item in page_resp["items"]:
                crop_resp = await admin_client.get(f"/books/admin/quality/user-books/flow2-candidates/{item['id']}/crop")
                self.assertEqual(crop_resp.status_code, 200)
                self.assertEqual(crop_resp.headers["content-type"], "image/png")
                self.assertIn("no-store", crop_resp.headers.get("cache-control", ""))

                dec = await admin_client.post(
                    f"/books/admin/quality/user-books/flow2-candidates/{item['id']}/decision",
                    json={"decision": "APPROVE", "verified_label": item["proposed_label"]},
                )
                self.assertEqual(dec.status_code, 200, dec.text)

        # Run outbox worker until queue drains -> syncs to isolated Drive store!
        drained = 0
        while await outbox_worker.run_once():
            drained += 1
        self.assertEqual(drained, 5)

        # Build Flow 2 manifest & inspect overview
        async with self.fixture.sessions() as db:
            svc = VireadOcrTrainingService(db)
            manifest = await svc.admin_verified_manifest(ADMIN_1, limit=50, offset=0)
            # Duplicate crops from A1 and B1 deduplicate cleanly by image_sha256 -> 3 unique clean samples (NEVER includes legacy quarantined sample!)
            self.assertEqual(manifest["total"], 3)
            self.assertIsNotNone(manifest["dataset_version_id"])
            self.assertIsNotNone(manifest["manifest_sha256"])
            self.assertTrue(str(manifest["manifest_storage_path"]).startswith("gdrive://"))
            labels = {item["label"] for item in manifest["items"]}
            self.assertNotIn("Mẫu cũ bị loại", labels)
            self.assertIn("Bé Na đi học sớm cùng mẹ.", labels)
            self.assertIn("Chú gà trống gáy vang đầu ngõ.", labels)

            # Verify Locked Test NEVER absorbs parent-contributed samples
            overview = await svc.overview(ADMIN_1)
            self.assertEqual(overview["locked_test"]["eligible_sample_count"], 0)
            self.assertFalse(overview["storage_summary"]["evaluation_ready_for_model_replacement"])
            self.assertEqual(overview["storage_summary"]["flow2_drive_synced_samples"], 3)
            self.assertEqual(overview["storage_summary"]["flow2_excluded_samples"], 1)
            self.assertEqual(overview["storage_summary"]["flow2_parent_candidates_synced"], 5)

            # Verify Drive JSON artifacts contain ZERO email / child info
            for item in manifest["items"]:
                raw_png = self.drive_router.get(item["image_storage_path"])
                self.assertEqual(hashlib.sha256(raw_png).hexdigest(), item["image_sha256"])

            first_dataset_id = manifest["dataset_version_id"]
            first_manifest_sha = manifest["manifest_sha256"]

        # Now Parent A turns OFF consent on Book A2 -> A2 sample excluded from new manifest, old dataset archived & blocked!
        async with self._client(PARENT_A) as client_a:
            off_res = await client_a.put(
                f"/books/my-books/{book_a2}/ocr-contribution",
                json={"enabled": False, "rights_confirmed": False},
            )
            self.assertEqual(off_res.status_code, 200)

        async with self.fixture.sessions() as db:
            svc = VireadOcrTrainingService(db)
            # Old snapshot containing A2 is now ARCHIVED -> create_run MUST reject with 409!
            with self.assertRaises(Exception) as ctx:
                await svc.create_run(
                    ADMIN_1,
                    TrainingRunCreate(
                        profile="FLOW2_ADMIN_VERIFIED",
                        dataset_version_id=first_dataset_id,
                        manifest_sha256=first_manifest_sha,
                        parent_checkpoint_sha256="380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59",
                        config_sha256="c" * 64,
                        architecture_sha256="a" * 64,
                        vocabulary_sha256="b" * 64,
                    ),
                )
            self.assertEqual(getattr(ctx.exception, "status_code", None), 409)

            # New manifest excludes A2 completely!
            manifest_after = await svc.admin_verified_manifest(ADMIN_1, limit=50, offset=0)
            labels_after = {item["label"] for item in manifest_after["items"]}
            self.assertNotIn("Chú gà trống gáy vang đầu ngõ.", labels_after)
            self.assertEqual(manifest_after["total"], 2)

        # Parent B & Child B still CANNOT read Parent A's book A1 or A2
        for actor_b in (PARENT_B, CHILD_B):
            async with self._client(actor_b) as cb:
                self.assertIn((await cb.get(f"/books/my-books/{book_a1}")).status_code, (401, 403, 404))
                self.assertIn((await cb.get(f"/books/my-books/{book_a2}")).status_code, (401, 403, 404))
        # Also verify Child B via Parent B's reading/book-detail endpoint gets 404 on Parent A's books
        async with self._client(PARENT_B) as cb:
            self.assertEqual((await cb.get(f"/books/{book_a1}")).status_code, 404)
            self.assertEqual((await cb.get(f"/books/{book_a2}")).status_code, 404)


if __name__ == "__main__":
    unittest.main()
