"""Real PostgreSQL 18 + Migration + RLS + Storage + FastAPI isolation tests for Parent Private Books."""
from __future__ import annotations

import os
import unittest
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://postgres:viread_local_test@127.0.0.1:5432/viread_test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import psycopg2
from sqlalchemy import text

from app.services.parent_private_book_pipeline import PipelineHooks, process_submission_stages
from parent_private_book_pg_fixture import (
    ADMIN_1,
    CHILD_A,
    CHILD_B,
    DisposablePrivateBookDatabase,
    LEGACY_CATALOG_BOOK_ADMIN_CREATED,
    LEGACY_CATALOG_BOOK_NULL_CREATED,
    PARENT_A,
    PARENT_B,
    make_synthetic_png,
)


def _clean_ocr(_img_bytes: bytes):
    return (
        "Mèo con đi học buổi sáng.",
        [
            {"text": "Mèo", "line_index": 0, "bounding_box": [0.1, 0.1, 0.12, 0.05], "ocr_confidence": 0.96},
            {"text": "con", "line_index": 0, "bounding_box": [0.24, 0.1, 0.12, 0.05], "ocr_confidence": 0.95},
            {"text": "đi", "line_index": 0, "bounding_box": [0.38, 0.1, 0.08, 0.05], "ocr_confidence": 0.94},
            {"text": "học", "line_index": 0, "bounding_box": [0.48, 0.1, 0.12, 0.05], "ocr_confidence": 0.95},
            {"text": "buổi", "line_index": 0, "bounding_box": [0.62, 0.1, 0.12, 0.05], "ocr_confidence": 0.96},
            {"text": "sáng.", "line_index": 0, "bounding_box": [0.76, 0.1, 0.14, 0.05], "ocr_confidence": 0.95},
        ],
        {"engine": "test_clean"},
    )


class _CleanProofreader:
    async def correct(self, text_value, _img, _boxes, *, on_provider_event=None, **_kwargs):
        if on_provider_event:
            on_provider_event({
                "provider": "ollama_qwen3_vl",
                "model": "qwen3-vl:4b-instruct-q4_K_M",
                "chunk_id": 0,
                "availability": True,
                "duration_ms": 42,
            })
        return text_value


class _CleanSafety:
    async def analyze(self, text_value: str):
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
                    "duration_ms": 55,
                }
            ],
        }


class ParentPrivateBookAccessAndIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fixture = DisposablePrivateBookDatabase()
        self.fixture.setup()
        self.app = self.fixture.build_app()

    async def asyncTearDown(self) -> None:
        await self.fixture.teardown()

    async def _create_ready_private_book_for_a(self) -> dict:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            res = await client_a.post(
                "/books/my-books",
                json={
                    "title": "Truyện Riêng Nhà An",
                    "author": "Mẹ của An",
                    "min_grade": 1,
                    "max_grade": 3,
                    "source_type": "SELF_AUTHORED",
                    "source_note": "Gia đình tự viết truyện cho bé đọc tối.",
                },
            )
            self.assertEqual(res.status_code, 201, res.text)
            book = res.json()
            book_id = book["id"]

            upload = await client_a.post(
                f"/books/my-books/{book_id}/submissions",
                files={"file": ("trang1.png", make_synthetic_png("Meo con di hoc"), "image/png")},
                data={
                    "idempotency_key": f"clean-{uuid4().hex}",
                    "source_type": "SELF_AUTHORED",
                    "source_note": "Tự viết",
                },
            )
            self.assertEqual(upload.status_code, 202, upload.text)
            sub_id = upload.json()["submissions"][0]["id"]

        hooks = PipelineHooks(
            ocr_fn=_clean_ocr,
            proofread_orchestrator_factory=_CleanProofreader,
            safety_orchestrator_factory=_CleanSafety,
        )
        async with self.fixture.sessions() as db:
            processed = await process_submission_stages(db, UUID(sub_id), hooks=hooks)
            assert processed is not None
            self.assertEqual(processed.WorkflowStatus, "PASSED_READY_TO_ADD")
            cand_hash = processed.CandidateHash
            version = processed.SubmissionVersion

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            add_res = await client_a.post(
                f"/books/my-books/{book_id}/submissions/{sub_id}/add-page",
                json={
                    "expected_submission_version": version,
                    "expected_candidate_hash": cand_hash,
                },
            )
            self.assertEqual(add_res.status_code, 201, add_res.text)
            added = add_res.json()
            self.assertTrue(added["book_readable_for_children"])
            return {
                "book_id": book_id,
                "submission_id": sub_id,
                "page_id": added["page_id"],
                "revision_id": added["revision_id"],
            }

    async def test_migration_preserves_legacy_catalog_and_enforces_db_invariants(self) -> None:
        conn = psycopg2.connect(self.fixture.sync_url)
        try:
            with conn.cursor() as cur:
                # 1. Existing books remain CATALOG regardless of createdby
                cur.execute(
                    "SELECT id, visibility_scope, owner_parent_id, moderation_status FROM public.books WHERE id IN (%s, %s)",
                    (str(LEGACY_CATALOG_BOOK_ADMIN_CREATED), str(LEGACY_CATALOG_BOOK_NULL_CREATED)),
                )
                rows = {row[0]: row[1:] for row in cur.fetchall()}
                self.assertEqual(rows[str(LEGACY_CATALOG_BOOK_ADMIN_CREATED)], ("CATALOG", None, "ACTIVE"))
                self.assertEqual(rows[str(LEGACY_CATALOG_BOOK_NULL_CREATED)], ("CATALOG", None, "ACTIVE"))

                # 2. Constraint blocks PARENT_PRIVATE without owner_parent_id
                with self.assertRaises(psycopg2.Error):
                    cur.execute(
                        """
                        INSERT INTO public.books (title, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id)
                        VALUES ('Orphan Private', 1, 3, 'ACTIVE', 'PARENT_PRIVATE', NULL)
                        """
                    )
                conn.rollback()

                # 3. Constraint blocks CATALOG with non-null owner_parent_id
                with self.assertRaises(psycopg2.Error):
                    cur.execute(
                        """
                        INSERT INTO public.books (title, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id)
                        VALUES ('Bad Catalog', 1, 3, 'ACTIVE', 'CATALOG', %s)
                        """,
                        (str(PARENT_A),),
                    )
                conn.rollback()

                # 4. Trigger prevents promoting PARENT_PRIVATE -> CATALOG or changing owner_parent_id
                priv_id = str(uuid4())
                cur.execute(
                    """
                    INSERT INTO public.books (id, title, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id)
                    VALUES (%s, 'Stay Private', 1, 3, 'ACTIVE', 'PARENT_PRIVATE', %s)
                    """,
                    (priv_id, str(PARENT_A)),
                )
                conn.commit()

                with self.assertRaises(psycopg2.Error):
                    cur.execute(
                        "UPDATE public.books SET visibility_scope = 'CATALOG', owner_parent_id = NULL WHERE id = %s",
                        (priv_id,),
                    )
                conn.rollback()

                with self.assertRaises(psycopg2.Error):
                    cur.execute(
                        "UPDATE public.books SET owner_parent_id = %s WHERE id = %s",
                        (str(PARENT_B), priv_id),
                    )
                conn.rollback()

                # 5. ON DELETE RESTRICT prevents deleting owner profile from orphaning private book
                with self.assertRaises(psycopg2.Error):
                    cur.execute("DELETE FROM public.profiles WHERE id = %s", (str(PARENT_A),))
                conn.rollback()
        finally:
            conn.close()

    async def test_spoofed_owner_visibility_or_approval_fields_rejected(self) -> None:
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            for extra_payload in (
                {"owner_parent_id": str(PARENT_B)},
                {"visibility_scope": "CATALOG"},
                {"moderation_status": "ACTIVE"},
                {"created_by": str(ADMIN_1)},
                {"approved": True},
            ):
                res = await client_a.post(
                    "/books/my-books",
                    json={
                        "title": "Sách thử giả mạo",
                        "min_grade": 1,
                        "max_grade": 2,
                        **extra_payload,
                    },
                )
                self.assertEqual(res.status_code, 422, f"Expected 422 for {extra_payload}, got {res.status_code}")

            # Anonymous cannot create private book
        async with self.fixture.client(self.app, None) as anon:
            res = await anon.post(
                "/books/my-books",
                json={"title": "Anon book", "min_grade": 1, "max_grade": 2},
            )
            self.assertEqual(res.status_code, 401)

    async def test_draft_not_readable_and_full_cross_family_isolation_across_all_routes(self) -> None:
        # 1. Parent A creates an empty draft private book -> NOT readable in child reading routes
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            draft_res = await client_a.post(
                "/books/my-books",
                json={"title": "Bản Nháp Bí Mật Nhà An", "min_grade": 1, "max_grade": 3},
            )
            self.assertEqual(draft_res.status_code, 201)
            draft_id = draft_res.json()["id"]
            self.assertFalse(draft_res.json()["readable_for_children"])

            # Draft cannot be opened on child reading detail/session even by A
            self.assertEqual((await client_a.get(f"/books/catalog/{draft_id}")).status_code, 409)
            self.assertEqual(
                (await client_a.post("/reading/sessions", json={"ChildId": str(CHILD_A), "BookId": draft_id})).status_code,
                409,
            )

        # 2. Parent A creates & commits a ready private book
        ready = await self._create_ready_private_book_for_a()
        book_id = ready["book_id"]
        sub_id = ready["submission_id"]
        page_id = ready["page_id"]
        rev_id = ready["revision_id"]

        # 3. Verify Parent A & Child A CAN read ready private book & load authenticated images
        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # Shared catalog default list MUST NOT include private book!
            shared_catalog = await client_a.get("/books/catalog")
            self.assertEqual(shared_catalog.status_code, 200)
            shared_ids = [b["id"] for b in shared_catalog.json()]
            self.assertIn(str(LEGACY_CATALOG_BOOK_ADMIN_CREATED), shared_ids)
            self.assertNotIn(book_id, shared_ids)

            # Catalog with include_private=true DOES include A's ready private book
            with_private = await client_a.get("/books/catalog", params={"include_private": "true"})
            self.assertEqual(with_private.status_code, 200)
            self.assertIn(book_id, [b["id"] for b in with_private.json()])
            self.assertIn("no-store", with_private.headers.get("cache-control", "").lower())

            # Detail & preview work for A and return authenticated proxy URL (NOT signed URL)
            detail_a = await client_a.get(f"/books/catalog/{book_id}")
            self.assertEqual(detail_a.status_code, 200)
            self.assertEqual(detail_a.json()["visibility_scope"], "PARENT_PRIVATE")

            previews_a = await client_a.get(f"/books/catalog/{book_id}/preview")
            self.assertEqual(previews_a.status_code, 200)
            preview_url = previews_a.json()[0]["preview_url"]
            self.assertIn(f"/books/my-books/{book_id}/pages/{page_id}/image", preview_url)
            self.assertNotIn("token=", preview_url.lower())

            # A can fetch A's page image and staging submission image with Cache-Control: private, no-store
            page_img_a = await client_a.get(preview_url.replace("http://testserver", ""))
            self.assertEqual(page_img_a.status_code, 200)
            self.assertIn("no-store", page_img_a.headers.get("cache-control", "").lower())
            self.assertTrue(page_img_a.content.startswith(b"\x89PNG"))

            sub_img_path = f"/books/my-books/{book_id}/submissions/{sub_id}/image"
            sub_img_a = await client_a.get(sub_img_path)
            self.assertEqual(sub_img_a.status_code, 200)

            # Child A starts a real reading session & fetches page DTO with authenticated image_url
            sess_res = await client_a.post(
                "/reading/sessions",
                json={"ChildId": str(CHILD_A), "BookId": book_id, "SelectedPageId": page_id},
            )
            self.assertEqual(sess_res.status_code, 200, sess_res.text)
            session_id = sess_res.json()["Id"]

            page_dto_res = await client_a.get(f"/reading/sessions/{session_id}/page")
            self.assertEqual(page_dto_res.status_code, 200, page_dto_res.text)
            self.assertEqual(page_dto_res.json()["text"], "Mèo con đi học buổi sáng.")
            self.assertIn(f"/books/my-books/{book_id}/pages/{page_id}/image", page_dto_res.json()["image_url"])

            # A can save private book to Child A's collection
            coll_a = await client_a.put(
                f"/reading-management/collections/{book_id}",
                json={"child_id": str(CHILD_A), "collection_type": "FAVORITE"},
            )
            self.assertEqual(coll_a.status_code, 200, coll_a.text)

            # A CANNOT open reading session using Child B's ID (server checks child ownership!)
            spoof_child = await client_a.post(
                "/reading/sessions",
                json={"ChildId": str(CHILD_B), "BookId": book_id},
            )
            self.assertEqual(spoof_child.status_code, 404)

        # 4. Verify Parent B & Child B are 100% BLOCKED across EVERY route (uniform 404, zero existence leak!)
        async with self.fixture.client(self.app, "token-parent-b") as client_b:
            self.assertNotIn(book_id, [b["id"] for b in (await client_b.get("/books/catalog")).json()])
            self.assertNotIn(book_id, [b["id"] for b in (await client_b.get("/books/catalog", params={"include_private": "true"})).json()])
            self.assertNotIn(book_id, [b["id"] for b in (await client_b.get("/books/catalog", params={"search": "Riêng Nhà An"})).json()])
            self.assertEqual((await client_b.get("/books/my-books")).json(), [])
            self.assertEqual((await client_b.get(f"/books/my-books/{book_id}")).status_code, 404)
            self.assertEqual((await client_b.get(f"/books/my-books/{draft_id}")).status_code, 404)
            self.assertEqual((await client_b.get(f"/books/catalog/{book_id}")).status_code, 404)
            self.assertEqual((await client_b.get(f"/books/catalog/{draft_id}")).status_code, 404)
            self.assertEqual((await client_b.get(f"/books/catalog/{book_id}/preview")).status_code, 404)
            self.assertEqual((await client_b.get(f"/books/{book_id}/pages")).status_code, 404)
            self.assertEqual(
                (await client_b.post("/reading/sessions", json={"ChildId": str(CHILD_B), "BookId": book_id})).status_code,
                404,
            )
            # B tries to spoof Child A's ID to read A's book
            self.assertEqual(
                (await client_b.post("/reading/sessions", json={"ChildId": str(CHILD_A), "BookId": book_id})).status_code,
                404,
            )
            # B cannot read A's active reading session or page or history
            self.assertEqual((await client_b.get(f"/reading/sessions/{session_id}/page")).status_code, 404)
            self.assertEqual((await client_b.get(f"/reading/pages/{page_id}", params={"session_id": session_id})).status_code, 404)
            self.assertEqual((await client_b.get(f"/reading/history/{session_id}/book")).status_code, 404)
            # B cannot add A's private book to B's collection (must be 404, NOT 409!)
            self.assertEqual(
                (await client_b.put(
                    f"/reading-management/collections/{book_id}",
                    json={"child_id": str(CHILD_B), "collection_type": "FAVORITE"},
                )).status_code,
                404,
            )
            # B cannot report/probe A's private book
            self.assertEqual(
                (await client_b.post(
                    f"/books/catalog/{book_id}/reports",
                    json={
                        "idempotency_key": str(uuid4()),
                        "issue_type": "SPELLING_ERROR",
                        "description": "Probe A book",
                    },
                )).status_code,
                404,
            )
            # CRITICAL: B uses the EXACT valid image URLs returned to A -> MUST get 404!
            self.assertEqual((await client_b.get(preview_url.replace("http://testserver", ""))).status_code, 404)
            self.assertEqual((await client_b.get(sub_img_path)).status_code, 404)

        # 5. Verify Anonymous (logged-out) session is blocked on private books, images, and legacy routes
        async with self.fixture.client(self.app, None) as anon:
            legacy_list = await anon.get("/books/")
            self.assertEqual(legacy_list.status_code, 200)
            legacy_ids = [b["Id"] for b in legacy_list.json()]
            self.assertIn(str(LEGACY_CATALOG_BOOK_ADMIN_CREATED), legacy_ids)
            self.assertNotIn(book_id, legacy_ids)
            self.assertNotIn(draft_id, legacy_ids)

            self.assertEqual((await anon.get(f"/books/{book_id}/pages")).status_code, 404)
            self.assertEqual((await anon.get(f"/books/{draft_id}/pages")).status_code, 404)
            self.assertEqual((await anon.get(f"/books/my-books/{book_id}")).status_code, 401)
            self.assertEqual((await anon.get(preview_url.replace("http://testserver", ""))).status_code, 401)
            self.assertEqual((await anon.get(sub_img_path)).status_code, 401)

        # 6. Verify Admin catalog / metadata-quality / catalog quality endpoints NEVER mix private book A
        async with self.fixture.client(self.app, "token-admin-1") as admin:
            admin_cat = await admin.get("/books/admin/catalog")
            self.assertEqual(admin_cat.status_code, 200)
            cat_payload = admin_cat.json()
            cat_items = cat_payload["items"] if isinstance(cat_payload, dict) else cat_payload
            cat_ids = [
                (b["book"]["id"] if isinstance(b.get("book"), dict) else (b.get("id") or b.get("book_id")))
                for b in cat_items
            ]
            self.assertIn(str(LEGACY_CATALOG_BOOK_ADMIN_CREATED), cat_ids)
            self.assertNotIn(book_id, cat_ids)
            self.assertEqual((await admin.get(f"/books/admin/catalog/{book_id}")).status_code, 404)
            mq = await admin.get("/books/admin/metadata-quality")
            self.assertEqual(mq.status_code, 200)
            mq_payload = mq.json()
            mq_items = mq_payload["items"] if isinstance(mq_payload, dict) else mq_payload
            self.assertNotIn(book_id, [b.get("id") or b.get("book_id") for b in mq_items])
            qc = await admin.get("/books/admin/quality/books")
            self.assertEqual(qc.status_code, 200)
            self.assertNotIn(book_id, [b["book_id"] for b in qc.json()["items"]])

    async def test_direct_postgres_rls_and_storage_objects_isolation(self) -> None:
        ready = await self._create_ready_private_book_for_a()
        book_id = ready["book_id"]

        conn = psycopg2.connect(self.fixture.sync_url)
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                # Seed a storage.objects row in private bucket to test storage RESTRICTIVE RLS directly
                cur.execute(
                    """
                    INSERT INTO storage.objects (bucket_id, name, owner)
                    VALUES ('viread-private-books', %s, %s)
                    """,
                    (f"private-books/{PARENT_A}/{book_id}/pages/p1.png", str(PARENT_A)),
                )
            conn.commit()

            # Role anon: sees legacy catalog ONLY, 0 private books, 0 private storage objects, denied submissions
            with conn.cursor() as cur:
                cur.execute("SET LOCAL ROLE anon")
                cur.execute("SELECT id FROM public.books WHERE id = %s", (book_id,))
                self.assertEqual(cur.fetchall(), [])
                cur.execute("SELECT id FROM public.books WHERE id = %s", (str(LEGACY_CATALOG_BOOK_ADMIN_CREATED),))
                self.assertEqual(len(cur.fetchall()), 1)
                cur.execute("SELECT id FROM public.bookpages WHERE bookid = %s", (book_id,))
                self.assertEqual(cur.fetchall(), [])
                cur.execute("SELECT name FROM storage.objects WHERE bucket_id = 'viread-private-books'")
                self.assertEqual(cur.fetchall(), [])
                with self.assertRaises(psycopg2.Error):
                    cur.execute("SELECT id FROM public.parent_book_page_submissions")
            conn.rollback()

            # Role authenticated as Parent B: 0 rows for A's private book/pages/revisions/words/storage
            with conn.cursor() as cur:
                cur.execute("SET LOCAL ROLE authenticated")
                cur.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (str(PARENT_B),))
                cur.execute("SELECT id FROM public.books WHERE id = %s", (book_id,))
                self.assertEqual(cur.fetchall(), [])
                cur.execute("SELECT id FROM public.bookpages WHERE bookid = %s", (book_id,))
                self.assertEqual(cur.fetchall(), [])
                cur.execute("SELECT id FROM public.pagerevisions WHERE id = %s", (ready["revision_id"],))
                self.assertEqual(cur.fetchall(), [])
                cur.execute("SELECT id FROM public.pagerevisionwords WHERE pagerevisionid = %s", (ready["revision_id"],))
                self.assertEqual(cur.fetchall(), [])
                cur.execute("SELECT name FROM storage.objects WHERE bucket_id = 'viread-private-books'")
                self.assertEqual(cur.fetchall(), [])
            conn.rollback()

            # Role authenticated as Parent A: sees own ACTIVE private book in DB, but STILL denied direct storage.objects (must go via FastAPI proxy)
            with conn.cursor() as cur:
                cur.execute("SET LOCAL ROLE authenticated")
                cur.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (str(PARENT_A),))
                cur.execute("SELECT id FROM public.books WHERE id = %s", (book_id,))
                self.assertEqual(len(cur.fetchall()), 1)
                cur.execute("SELECT name FROM storage.objects WHERE bucket_id = 'viread-private-books'")
                self.assertEqual(cur.fetchall(), [])
            conn.rollback()

            # Deactivate Parent A -> book remains PARENT_PRIVATE and cannot be read via API
            with conn.cursor() as cur:
                cur.execute("UPDATE public.profiles SET active = 0 WHERE id = %s", (str(PARENT_A),))
                cur.execute("SELECT visibility_scope FROM public.books WHERE id = %s", (book_id,))
                self.assertEqual(cur.fetchone()[0], "PARENT_PRIVATE")
            conn.commit()
        finally:
            conn.close()

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # Deactivated owner loses access; book NEVER falls into public catalog
            self.assertEqual((await client_a.get(f"/books/catalog/{book_id}")).status_code, 403)
        async with self.fixture.client(self.app, None) as anon:
            self.assertNotIn(book_id, [b["Id"] for b in (await anon.get("/books/")).json()])

    async def test_list_my_private_books_paged_ordering_boundaries_search_and_isolation(self) -> None:
        # 1. Empty state (0 books) + anonymous blocked
        async with self.fixture.client(self.app, None) as anon:
            self.assertEqual((await anon.get("/books/my-books/paged")).status_code, 401)
        async with self.fixture.client(self.app, "token-admin-1") as admin:
            self.assertEqual((await admin.get("/books/my-books/paged")).status_code, 403)

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            empty_res = await client_a.get("/books/my-books/paged")
            self.assertEqual(empty_res.status_code, 200, empty_res.text)
            self.assertIn("no-store", empty_res.headers.get("cache-control", "").lower())
            self.assertEqual(
                empty_res.json(),
                {"items": [], "total": 0, "limit": 9, "offset": 0},
            )

        # 2. Seed 25 books for Parent A (some with IDENTICAL CreatedAt + duplicate titles) and 2 for Parent B
        conn = psycopg2.connect(self.fixture.sync_url)
        try:
            with conn.cursor() as cur:
                # 1 book check first
                first_id = str(uuid4())
                cur.execute(
                    """
                    INSERT INTO public.books (id, name, title, author, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id, moderation_status, createdat)
                    VALUES (%s, %s, %s, %s, 1, 3, 'ACTIVE', 'PARENT_PRIVATE', %s, 'ACTIVE', '2026-11-01T00:00:00Z')
                    """,
                    (first_id, "Sách Duy Nhất", "Sách Duy Nhất", "Mẹ An", str(PARENT_A)),
                )
            conn.commit()
        finally:
            conn.close()

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            one_res = await client_a.get("/books/my-books/paged", params={"limit": 9, "offset": 0})
            self.assertEqual(one_res.status_code, 200)
            self.assertEqual(one_res.json()["total"], 1)
            self.assertEqual([b["id"] for b in one_res.json()["items"]], [first_id])

        # Seed remaining 24 books for Parent A (total = 25), including 10 with identical timestamp & duplicate title
        same_ts_ids = [
            f"aa000000-0000-4000-8000-{idx:012d}" for idx in range(1, 11)
        ]
        conn = psycopg2.connect(self.fixture.sync_url)
        try:
            with conn.cursor() as cur:
                for idx in range(2, 16):
                    cur.execute(
                        """
                        INSERT INTO public.books (id, name, title, author, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id, moderation_status, createdat)
                        VALUES (%s, %s, %s, %s, 1, 3, 'ACTIVE', 'PARENT_PRIVATE', %s, 'ACTIVE', %s)
                        """,
                        (
                            str(uuid4()),
                            f"Truyện An #{idx:02d}",
                            f"Truyện An #{idx:02d}",
                            "Gia đình An",
                            str(PARENT_A),
                            f"2026-11-02T00:{idx:02d}:00Z",
                        ),
                    )
                for bid in same_ts_ids:
                    cur.execute(
                        """
                        INSERT INTO public.books (id, name, title, author, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id, moderation_status, createdat)
                        VALUES (%s, 'Truyện Trùng Tên', 'Truyện Trùng Tên', 'Tác giả đặc biệt', 1, 3, 'ACTIVE', 'PARENT_PRIVATE', %s, 'ACTIVE', '2026-11-10T12:00:00Z')
                        """,
                        (bid, str(PARENT_A)),
                    )
                # Parent B books + retired Parent A book must NOT leak into A's count or items
                cur.execute(
                    """
                    INSERT INTO public.books (id, name, title, author, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id, moderation_status, createdat)
                    VALUES (%s, 'Sách Đã Xóa A', 'Sách Đã Xóa A', 'Mẹ An', 1, 3, 'RETIRED', 'PARENT_PRIVATE', %s, 'ACTIVE', '2026-11-12T00:00:00Z')
                    """,
                    (str(uuid4()), str(PARENT_A)),
                )
                for b_idx in range(2):
                    cur.execute(
                        """
                        INSERT INTO public.books (id, name, title, author, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id, moderation_status, createdat)
                        VALUES (%s, %s, %s, 'Mẹ Bình', 1, 3, 'ACTIVE', 'PARENT_PRIVATE', %s, 'ACTIVE', '2026-11-11T00:00:00Z')
                        """,
                        (str(uuid4()), f"Sách Nhà Bình {b_idx}", f"Sách Nhà Bình {b_idx}", str(PARENT_B)),
                    )
            conn.commit()
        finally:
            conn.close()

        async with self.fixture.client(self.app, "token-parent-a") as client_a:
            # Traverse all pages (limit=9 -> pages of 9, 9, 7 = 25) with zero duplicates or omissions
            seen_ids: list[str] = []
            for offset, expected_len in ((0, 9), (9, 9), (18, 7), (27, 0)):
                res = await client_a.get("/books/my-books/paged", params={"limit": 9, "offset": offset})
                self.assertEqual(res.status_code, 200, res.text)
                payload = res.json()
                self.assertEqual(payload["total"], 25)
                self.assertEqual(payload["limit"], 9)
                self.assertEqual(payload["offset"], offset)
                self.assertEqual(len(payload["items"]), expected_len)
                seen_ids.extend(item["id"] for item in payload["items"])

            self.assertEqual(len(seen_ids), 25)
            self.assertEqual(len(set(seen_ids)), 25)

            # First 10 items are the identical-timestamp rows strictly ordered by Id DESC
            self.assertEqual(seen_ids[:10], list(reversed(same_ts_ids)))
            # Last item on last page is the oldest book
            self.assertEqual(seen_ids[-1], first_id)

            # Legacy GET /books/my-books remains 100% backwards-compatible (returns raw list in same order)
            legacy_res = await client_a.get("/books/my-books")
            self.assertEqual(legacy_res.status_code, 200)
            self.assertIsInstance(legacy_res.json(), list)
            self.assertEqual([b["id"] for b in legacy_res.json()], seen_ids)

            # Search filter applies to BOTH items and total
            search_res = await client_a.get(
                "/books/my-books/paged",
                params={"search": "Trùng Tên", "limit": 9, "offset": 0},
            )
            self.assertEqual(search_res.status_code, 200)
            self.assertEqual(search_res.json()["total"], 10)
            self.assertEqual(len(search_res.json()["items"]), 9)

            search_page2 = await client_a.get(
                "/books/my-books/paged",
                params={"search": "Trùng Tên", "limit": 9, "offset": 9},
            )
            self.assertEqual(search_page2.status_code, 200)
            self.assertEqual(search_page2.json()["total"], 10)
            self.assertEqual(len(search_page2.json()["items"]), 1)

        # Cross-family isolation: Parent B only sees Parent B's 2 books
        async with self.fixture.client(self.app, "token-parent-b") as client_b:
            b_res = await client_b.get("/books/my-books/paged", params={"limit": 9, "offset": 0})
            self.assertEqual(b_res.status_code, 200)
            self.assertEqual(b_res.json()["total"], 2)
            self.assertEqual(len(b_res.json()["items"]), 2)
            for item in b_res.json()["items"]:
                self.assertNotIn(item["id"], seen_ids)


class ParentPrivateBookPagedContractTests(unittest.IsolatedAsyncioTestCase):
    """DB-independent contract, route-precedence, auth, and SQL-clause tests for /books/my-books/paged."""

    async def test_paged_route_precedence_auth_headers_and_boundaries(self) -> None:
        from datetime import datetime, timezone
        from types import SimpleNamespace
        from unittest.mock import patch

        import httpx
        from fastapi import FastAPI
        from sqlalchemy.dialects import postgresql

        from app.api.deps import get_current_parent_id, get_db
        from app.api.routes.parent_private_book import router as ppb_router
        from app.repositories.parent_private_book_repository import ParentPrivateBookRepository
        from app.schemas.parent_private_book import ParentPrivateBookPageRead, ParentPrivateBookSummaryRead

        # 1. Verify /my-books/paged is registered BEFORE /my-books/{book_id}
        get_paths = [
            route.path
            for route in ppb_router.routes
            if "GET" in getattr(route, "methods", set())
        ]
        self.assertIn("/my-books/paged", get_paths)
        self.assertIn("/my-books/{book_id}", get_paths)
        self.assertLess(get_paths.index("/my-books/paged"), get_paths.index("/my-books/{book_id}"))

        # 2. Verify repository SQL compiles with family scoping + deterministic CreatedAt DESC, Id DESC tie-breaker
        captured_stmts: list = []

        class _FakeResult:
            def scalars(self):
                return SimpleNamespace(all=lambda: [])

        class _FakeSession:
            async def scalar(self, stmt):
                captured_stmts.append(stmt)
                return 25

            async def execute(self, stmt):
                captured_stmts.append(stmt)
                return _FakeResult()

        repo = ParentPrivateBookRepository(_FakeSession())  # type: ignore[arg-type]
        items, total = await repo.list_owned_private_books_paged(
            PARENT_A, ready_only=False, search="Mèo", limit=9, offset=9
        )
        self.assertEqual(total, 25)
        self.assertEqual(items, [])
        self.assertEqual(len(captured_stmts), 2)
        count_sql = str(captured_stmts[0].compile(dialect=postgresql.dialect()))
        page_sql = str(captured_stmts[1].compile(dialect=postgresql.dialect()))
        for sql in (count_sql, page_sql):
            self.assertIn("visibility_scope", sql)
            self.assertIn("owner_parent_id", sql)
            self.assertIn("lifecyclestatus", sql)
            self.assertIn("ILIKE", sql)
        self.assertIn("ORDER BY books.createdat DESC, books.id DESC", page_sql)
        self.assertIn("LIMIT", page_sql)
        self.assertIn("OFFSET", page_sql)

        # 3. Verify HTTP route returns typed envelope + private no-store headers + validates limit/offset
        app = FastAPI()
        app.include_router(ppb_router, prefix="/books")
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_A

        async def _fake_db():
            yield SimpleNamespace()

        app.dependency_overrides[get_db] = _fake_db
        sample_summary = ParentPrivateBookSummaryRead(
            id=UUID("aa000000-0000-4000-8000-000000000001"),
            title="Sách Riêng 1",
            author="Mẹ An",
            min_grade=1,
            max_grade=3,
            lifecycle_status="ACTIVE",
            moderation_status="ACTIVE",
            created_at=datetime(2026, 11, 20, tzinfo=timezone.utc),
        )

        async def _fake_list_books_paged(
            _self,
            actor_id,
            *,
            ready_only=False,
            search=None,
            limit=9,
            offset=0,
        ):
            self.assertEqual(actor_id, PARENT_A)
            self.assertFalse(ready_only)
            self.assertEqual(search, "An")
            return ParentPrivateBookPageRead(
                items=[sample_summary],
                total=10,
                limit=limit,
                offset=offset,
            )

        with patch(
            "app.services.parent_private_book_service.ParentPrivateBookService.list_books_paged",
            new=_fake_list_books_paged,
        ):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                res = await client.get(
                    "/books/my-books/paged",
                    params={"limit": 9, "offset": 9, "search": "An"},
                )
                self.assertEqual(res.status_code, 200, res.text)
                self.assertIn("no-store", res.headers.get("cache-control", "").lower())
                self.assertEqual(res.json()["total"], 10)
                self.assertEqual(res.json()["limit"], 9)
                self.assertEqual(res.json()["offset"], 9)
                self.assertEqual(len(res.json()["items"]), 1)

                # Invalid bounds rejected with 422
                self.assertEqual((await client.get("/books/my-books/paged", params={"limit": 0})).status_code, 422)
                self.assertEqual((await client.get("/books/my-books/paged", params={"limit": 51})).status_code, 422)
                self.assertEqual((await client.get("/books/my-books/paged", params={"offset": -1})).status_code, 422)


if __name__ == "__main__":
    unittest.main()
