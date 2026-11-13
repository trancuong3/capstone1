"""Disposable PostgreSQL and FastAPI coverage for repeated Admin OCR edits."""

import os
import unittest
import asyncio
import json
from uuid import UUID, uuid4
from unittest.mock import patch

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.api.deps import get_current_parent_id, get_db
from app.api.router import api_router
from app.models import BookPage, PageRevision, PageRevisionWord
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.repositories.reading_content_repository import ReadingContentRepository
from app.services.admin_ocr_service import AdminOcrService
from app.services.reading_content_service import ReadingContentService


POSTGRES_TEST_DATABASE_URL = os.getenv("ADMIN_OCR_TEST_DATABASE_URL")
ACTOR = UUID("11111111-1111-4111-8111-111111111111")
BOOK_ID = UUID("22222222-2222-4222-8222-222222222222")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")
R1_ID = UUID("44444444-4444-4444-8444-444444444441")


@unittest.skipUnless(
    POSTGRES_TEST_DATABASE_URL,
    "Set ADMIN_OCR_TEST_DATABASE_URL to run isolated PostgreSQL OCR coverage",
)
class AdminOcrPostgresIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.schema = f"admin_ocr_test_{uuid4().hex}"
        self.admin_engine = create_async_engine(
            POSTGRES_TEST_DATABASE_URL, poolclass=NullPool
        )
        async with self.admin_engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{self.schema}"'))
            await connection.execute(
                text(
                    "INSERT INTO public.profiles (id) VALUES (:id) ON CONFLICT DO NOTHING"
                ),
                {"id": ACTOR},
            )
            await connection.execute(
                text(
                    "INSERT INTO public.bookpages (id) VALUES (:id) ON CONFLICT DO NOTHING"
                ),
                {"id": PAGE_ID},
            )
            await connection.execute(
                text(
                    "INSERT INTO public.pagerevisions (id, pageid) "
                    "VALUES (:id, :page) ON CONFLICT DO NOTHING"
                ),
                {"id": R1_ID, "page": PAGE_ID},
            )

        self.engine = create_async_engine(
            POSTGRES_TEST_DATABASE_URL,
            connect_args={"server_settings": {"search_path": self.schema}},
            poolclass=NullPool,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            statements = (
                """
                CREATE TABLE profiles (
                    id uuid PRIMARY KEY,
                    role text NOT NULL
                )
                """,
                """
                CREATE TABLE books (
                    id uuid PRIMARY KEY,
                    name text,
                    title text NOT NULL,
                    author text,
                    mingrade smallint NOT NULL,
                    maxgrade smallint NOT NULL,
                    lifecyclestatus text NOT NULL,
                    createdby uuid,
                    createdat timestamptz NOT NULL DEFAULT now()
                )
                """,
                """
                CREATE TABLE bookpages (
                    id uuid PRIMARY KEY,
                    bookid uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    pagenumber smallint NOT NULL,
                    imagepath text NOT NULL,
                    width smallint NOT NULL,
                    height smallint NOT NULL,
                    featurepath text,
                    processingmeta jsonb NOT NULL DEFAULT '{}'::jsonb,
                    currentverifiedrevisionid uuid,
                    lifecyclestatus text NOT NULL,
                    createdat timestamptz NOT NULL DEFAULT now()
                )
                """,
                """
                CREATE TABLE pagerevisions (
                    id uuid PRIMARY KEY,
                    pageid uuid NOT NULL REFERENCES bookpages(id) ON DELETE CASCADE,
                    revisionno text NOT NULL,
                    verificationstatus text NOT NULL,
                    verifiedtext text,
                    drafttext text,
                    contenthash text NOT NULL,
                    processingmeta jsonb NOT NULL DEFAULT '{}'::jsonb,
                    verifiedby uuid REFERENCES profiles(id) ON DELETE SET NULL,
                    verifiedat timestamptz,
                    createdat timestamptz NOT NULL DEFAULT now(),
                    UNIQUE (pageid, revisionno)
                )
                """,
                """
                ALTER TABLE bookpages
                ADD CONSTRAINT bookpages_currentverifiedrevisionid_fkey
                FOREIGN KEY (currentverifiedrevisionid)
                REFERENCES pagerevisions(id) ON DELETE SET NULL
                """,
                """
                CREATE TABLE pagerevisionwords (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    pagerevisionid uuid NOT NULL REFERENCES pagerevisions(id) ON DELETE CASCADE,
                    wordindex smallint NOT NULL,
                    lineindex smallint NOT NULL,
                    text text NOT NULL,
                    normalizedtext text NOT NULL,
                    boundingbox jsonb NOT NULL,
                    ocrconfidence double precision,
                    UNIQUE (pagerevisionid, wordindex)
                )
                """,
            )
            for statement in statements:
                await connection.execute(text(statement))
            await connection.execute(
                text("INSERT INTO profiles (id, role) VALUES (:id, 'admin')"),
                {"id": ACTOR},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO books
                        (id, title, mingrade, maxgrade, lifecyclestatus)
                    VALUES (:id, 'Test book', 1, 3, 'ACTIVE')
                    """
                ),
                {"id": BOOK_ID},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO bookpages
                        (id, bookid, pagenumber, imagepath, width, height, lifecyclestatus)
                    VALUES (:id, :book, 1, 'source/page.png', 600, 800, 'ACTIVE')
                    """
                ),
                {"id": PAGE_ID, "book": BOOK_ID},
            )
            await connection.execute(
                text(
                    """
                    INSERT INTO pagerevisions
                        (id, pageid, revisionno, verificationstatus, verifiedtext,
                         drafttext, contenthash, verifiedby, verifiedat)
                    VALUES (:id, :page, '1', 'VERIFIED', 'Ngày xưa có bé.',
                            'Ngày xưa có bé.', 'r1-hash', :actor, now())
                    """
                ),
                {"id": R1_ID, "page": PAGE_ID, "actor": ACTOR},
            )
            await connection.execute(
                text(
                    """
                    UPDATE bookpages SET currentverifiedrevisionid = :revision
                    WHERE id = :page
                    """
                ),
                {"revision": R1_ID, "page": PAGE_ID},
            )
            word_rows = (
                ("Ngày", "ngày", 0.91, [0.1, 0.1, 0.2, 0.05]),
                ("xưa", "xưa", 0.82, [0.32, 0.1, 0.2, 0.05]),
                ("có", "có", None, [0.1, 0.2, 0.1, 0.04]),
                ("bé.", "bé", 0.7, [0.22, 0.2, 0.14, 0.04]),
            )
            for index, (word, normalized, confidence, bbox) in enumerate(word_rows):
                await connection.execute(
                    text(
                        """
                        INSERT INTO pagerevisionwords
                            (pagerevisionid, wordindex, lineindex, text,
                             normalizedtext, boundingbox, ocrconfidence)
                        VALUES (:revision, :index, 0, :word, :normalized,
                                CAST(:bbox AS jsonb), :confidence)
                        """
                    ),
                    {
                        "revision": R1_ID,
                        "index": index,
                        "word": word,
                        "normalized": normalized,
                        "bbox": json.dumps(bbox),
                        "confidence": confidence,
                    },
                )

            dual_engine_evidence = []
            for index, (word, _normalized, _confidence, _bbox) in enumerate(word_rows):
                dual_engine_evidence.append({
                    "contract": "hybrid_ocr_evidence_v4",
                    "engine_outputs": {
                        "paddleocr": word,
                        "vietocr": word,
                        "tesseract": None,
                    },
                    "engine_statuses": {
                        "paddleocr": "success",
                        "vietocr": "success",
                        "tesseract": "not_run",
                    },
                    "paddle_token_index": index,
                    "vietocr_token_index": index,
                    "source_text": word,
                    "alignment": "match",
                    "engine_agreement_score": 1.0,
                    "calibrated_word_accuracy": None,
                    "verification_source": None,
                    "reference_text": None,
                    "reference_alignment": None,
                    "selected_engine": "vietocr",
                    "selection_reason": "vietocr_nonempty_nonrepetitive_provisional",
                    "bbox_quality": "valid",
                    "crop_quality": "usable",
                    "crop_evidence": {
                        "status": "not_needed",
                        "reason": "engines_agree_but_agreement_is_not_verification",
                    },
                    "review_reason": "Both OCR engines agreed; no independent verification.",
                })
            await connection.execute(
                text(
                    """
                    UPDATE pagerevisions
                    SET processingmeta = CAST(:metadata AS jsonb)
                    WHERE id = :revision
                    """
                ),
                {
                    "revision": R1_ID,
                    "metadata": json.dumps({
                        "ocr_evidence_contract": "hybrid_ocr_evidence_v4",
                        "engine_statuses": {
                            "paddleocr": "success",
                            "vietocr": "success",
                            "tesseract": "not_run",
                        },
                        "word_review_statuses": ["verified"] * len(word_rows),
                        "word_score_sources": [None] * len(word_rows),
                        "word_evidence_v2": dual_engine_evidence,
                        "word_evidence_v2_authoritative": True,
                    }),
                },
            )

    async def asyncTearDown(self):
        await self.engine.dispose()
        async with self.admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
            await connection.execute(
                text("DELETE FROM public.viread_ocr_outbox WHERE page_id = :page"),
                {"page": PAGE_ID},
            )
            await connection.execute(
                text("DELETE FROM public.pagerevisions WHERE pageid = :page"),
                {"page": PAGE_ID},
            )
            await connection.execute(
                text("DELETE FROM public.bookpages WHERE id = :page"),
                {"page": PAGE_ID},
            )
            await connection.execute(
                text("DELETE FROM public.profiles WHERE id = :actor"),
                {"actor": ACTOR},
            )
        await self.admin_engine.dispose()

    async def _seed_public_revision_reference(self, revision_id: UUID) -> None:
        """Mirror the isolated-schema revision IDs required by public FK constraints."""
        async with self.admin_engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO public.pagerevisions (id, pageid) "
                    "VALUES (:id, :page) ON CONFLICT DO NOTHING"
                ),
                {"id": revision_id, "page": PAGE_ID},
            )

    def _test_app(self):
        app = FastAPI()
        app.include_router(api_router)

        async def database_override():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_db] = database_override
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        return app

    async def test_api_supports_two_edit_cycles_and_history_remains_immutable(self):
        # A failure after staging the revision and its first word must roll back both.
        def fail_after_first_word(repository, revision, words):
            repository.db.add(revision)
            word = words[0]
            repository.db.add(
                PageRevisionWord(
                    PageRevisionId=revision.Id,
                    WordIndex=word["word_index"],
                    LineIndex=word["line_index"],
                    Text=word["text"],
                    NormalizedText=word["normalized_text"],
                    BoundingBox=list(word["bbox"]),
                    OCRConfidence=word.get("ocr_confidence"),
                )
            )
            raise RuntimeError("simulated staged bundle failure")

        async with self.sessions() as session:
            service = AdminOcrService(session)
            with patch.object(
                AdminOcrRepository,
                "stage_revision_bundle",
                fail_after_first_word,
            ):
                with self.assertRaisesRegex(RuntimeError, "staged bundle failure"):
                    await service.create_edit_draft(ACTOR, PAGE_ID, R1_ID)

        async with self.sessions() as session:
            revision_count = await session.scalar(
                text("SELECT count(*) FROM pagerevisions WHERE pageid = :page"),
                {"page": PAGE_ID},
            )
            word_count = await session.scalar(
                text("SELECT count(*) FROM pagerevisionwords WHERE pagerevisionid != :r1"),
                {"r1": R1_ID},
            )
            self.assertEqual(revision_count, 1)
            self.assertEqual(word_count, 0)

        app = self._test_app()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            draft = await client.post(
                f"/books/admin/pages/{PAGE_ID}/revisions/draft",
                json={"expected_source_revision_id": str(R1_ID)},
            )
            self.assertEqual(draft.status_code, 201, draft.text)
            r2 = draft.json()
            self.assertEqual(r2["revision_no"], 2)
            self.assertEqual(r2["verification_status"], "NEEDS_REVIEW")
            self.assertEqual(r2["draft_text"], "Ngày xưa có bé.")
            self.assertEqual(len(r2["words"]), 4)
            self.assertTrue(
                all(
                    word["review_color_group"] in {"green", "yellow", "red"}
                    for word in r2["words"]
                )
            )
            self.assertEqual(r2["ocr_metadata"]["source_revision_id"], str(R1_ID))
            self.assertEqual(r2["words"][0]["ocr_review_status"], "reference_match")
            self.assertEqual(
                r2["words"][0]["ocr_evidence"]["verification_source"],
                "verified_revision",
            )
            self.assertEqual(r2["words"][0]["ocr_evidence"]["reference_text"], "Ngày")
            self.assertEqual(r2["words"][2]["ocr_confidence"], None)
            self.assertEqual(
                r2["words"][0]["ocr_evidence"]["engine_outputs"],
                {"paddleocr": "Ngày", "vietocr": "Ngày", "tesseract": None},
            )
            self.assertEqual(
                r2["words"][0]["ocr_evidence"]["engine_statuses"],
                {"paddleocr": "success", "vietocr": "success", "tesseract": "not_run"},
            )
            self.assertEqual(r2["words"][0]["ocr_evidence"]["paddle_token_index"], 0)
            self.assertEqual(r2["words"][0]["ocr_evidence"]["vietocr_token_index"], 0)
            self.assertEqual(r2["words"][0]["review_color_group"], "green")

            changed_words = r2["words"]
            changed_words[3]["text"] = "em."
            changed_words[3]["normalized_text"] = "em"
            saved = await client.put(
                f"/books/admin/pages/{PAGE_ID}/revisions/{r2['page_revision_id']}/draft",
                json={"draft_text": "Ngày xưa có em.", "words": changed_words},
            )
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["draft_text"], "Ngày xưa có em.")
            edited_word = saved.json()["words"][3]
            self.assertEqual(edited_word["ocr_review_status"], "needs_review")
            self.assertEqual(edited_word["review_color_group"], "yellow")
            self.assertIsNone(edited_word["ocr_confidence"])
            self.assertEqual(edited_word["ocr_evidence"]["source_text"], "bé.")
            self.assertEqual(
                edited_word["ocr_evidence"]["engine_outputs"],
                {"paddleocr": "bé.", "vietocr": "bé.", "tesseract": None},
            )

            verified_revision_id = UUID(r2["page_revision_id"])
            await self._seed_public_revision_reference(verified_revision_id)

            verified = await client.post(
                f"/books/admin/pages/{PAGE_ID}/verify",
                json={
                    "page_revision_id": r2["page_revision_id"],
                    "corrected_text": "Ngày xưa có em.",
                    "words": saved.json()["words"],
                    "proofread_audit": {
                        "mode": "AI_CHECKED",
                        "checked_text": "Ngày xưa có em.",
                        "suggestions": [],
                    },
                },
            )
            self.assertEqual(verified.status_code, 200, verified.text)
            self.assertEqual(verified.json()["verification_status"], "VERIFIED")
            self.assertEqual(verified.json()["draft_text"], "Ngày xưa có em.")
            self.assertEqual(
                [word["ocr_review_status"] for word in verified.json()["words"]],
                ["verified"] * 4,
            )
            self.assertEqual(
                [word["review_color_group"] for word in verified.json()["words"]],
                ["green"] * 4,
            )
            self.assertEqual(
                [word["ocr_evidence"]["verification_source"] for word in verified.json()["words"]],
                ["admin"] * 4,
            )
            self.assertEqual(
                [word["ocr_evidence"]["reference_text"] for word in verified.json()["words"]],
                ["Ngày", "xưa", "có", "em."],
            )
            async with self.admin_engine.begin() as connection:
                outbox_event = (
                    await connection.execute(
                        text("""
                            SELECT event_type, page_id, revision_id, actor_id, status,
                                   payload::text AS payload_text
                            FROM public.viread_ocr_outbox
                            WHERE event_type = 'VERIFIED_REVISION' AND revision_id = :revision
                        """),
                        {"revision": verified_revision_id},
                    )
                ).mappings().one()
            self.assertEqual(outbox_event["page_id"], PAGE_ID)
            self.assertEqual(outbox_event["revision_id"], verified_revision_id)
            self.assertEqual(outbox_event["actor_id"], ACTOR)
            self.assertEqual(outbox_event["status"], "PENDING")
            payload = json.loads(outbox_event["payload_text"])
            self.assertEqual(payload["source_flow"], "FLOW1_VERIFIED")
            self.assertEqual(payload["schema"], "viread-outbox-v1")

            async with self.sessions() as session:
                reading_repository = ReadingContentRepository(session)
                reading = ReadingContentService(reading_repository)
                reading_page = await reading.repository.verified_page(PAGE_ID, BOOK_ID)
                self.assertIsNotNone(reading_page)
                current_revision = await reading.repository.verified_revision(
                    PAGE_ID, reading_page.CurrentVerifiedRevisionId
                )
                self.assertIsNotNone(current_revision)
                page_content = await reading._build_page_dto(
                    reading_page, current_revision
                )
                self.assertEqual(page_content.text, "Ngày xưa có em.")
                self.assertEqual(
                    [word.text for word in page_content.words],
                    ["Ngày", "xưa", "có", "em."],
                )
                self.assertEqual(page_content.page_revision_id, UUID(r2["page_revision_id"]))

            second_draft = await client.post(
                f"/books/admin/pages/{PAGE_ID}/revisions/draft",
                json={"expected_source_revision_id": r2["page_revision_id"]},
            )
            self.assertEqual(second_draft.status_code, 201, second_draft.text)
            r3 = second_draft.json()
            self.assertEqual(r3["revision_no"], 3)
            self.assertEqual(r3["draft_text"], "Ngày xưa có em.")

            history = await client.get(f"/books/admin/pages/{PAGE_ID}/revisions")
            self.assertEqual(history.status_code, 200, history.text)
            self.assertEqual([row["revision_no"] for row in history.json()], [3, 2, 1])
            self.assertTrue(
                next(
                    row
                    for row in history.json()
                    if row["page_revision_id"] == r2["page_revision_id"]
                )["is_current_verified"]
            )
            r1_detail = await client.get(
                f"/books/admin/pages/{PAGE_ID}/revisions/{R1_ID}"
            )
            r2_detail = await client.get(
                f"/books/admin/pages/{PAGE_ID}/revisions/{r2['page_revision_id']}"
            )
            self.assertEqual(r1_detail.status_code, 200, r1_detail.text)
            self.assertEqual(r2_detail.status_code, 200, r2_detail.text)
            self.assertEqual(r1_detail.json()["draft_text"], "Ngày xưa có bé.")
            self.assertEqual(r2_detail.json()["draft_text"], "Ngày xưa có em.")
            self.assertEqual(
                [word["bbox"] for word in r2_detail.json()["words"]],
                [word["bbox"] for word in r2["words"]],
            )
            self.assertEqual(
                [word["ocr_confidence"] for word in r2_detail.json()["words"]],
                [word["ocr_confidence"] for word in r2["words"]],
            )
            self.assertEqual(
                [word["ocr_review_status"] for word in r2_detail.json()["words"]],
                ["verified"] * 4,
            )
            self.assertEqual(
                r2_detail.json()["words"][3]["ocr_evidence"]["engine_statuses"],
                {"paddleocr": "success", "vietocr": "success", "tesseract": "not_run"},
            )
            self.assertEqual(
                r2_detail.json()["words"][3]["ocr_evidence"]["source_text"],
                "bé.",
            )

        async with self.sessions() as session:
            page = await session.get(BookPage, PAGE_ID)
            r1 = await session.get(PageRevision, R1_ID)
            r2_row = await session.get(PageRevision, UUID(r2["page_revision_id"]))
            r3_row = await session.get(PageRevision, UUID(r3["page_revision_id"]))
            self.assertEqual(page.CurrentVerifiedRevisionId, UUID(r2["page_revision_id"]))
            self.assertEqual(page.ImagePath, "source/page.png")
            self.assertEqual(r1.VerifiedText, "Ngày xưa có bé.")
            self.assertEqual(r2_row.VerifiedText, "Ngày xưa có em.")
            self.assertIsNone(r3_row.VerifiedText)

    async def test_split_merge_word_evidence_survives_postgres_and_revision_api(self):
        async with self.sessions() as session:
            draft = await AdminOcrService(session).create_edit_draft(
                ACTOR, PAGE_ID, R1_ID
            )
            revision_id = draft.page_revision_id
            merge_evidence = {
                "contract": "hybrid_ocr_evidence_v4",
                "engine_outputs": {
                    "paddleocr": None,
                    "vietocr": "Ngày",
                    "tesseract": None,
                },
                "engine_statuses": {
                    "paddleocr": "success",
                    "vietocr": "success",
                    "tesseract": "not_run",
                },
                "engine_errors": {},
                "paddle_token_index": None,
                "vietocr_token_index": 0,
                "source_text": "Ngày",
                "alignment": "merge",
                "engine_agreement_score": None,
                "calibrated_word_accuracy": None,
                "verification_source": None,
                "reference_text": None,
                "reference_alignment": None,
                "selected_engine": "vietocr",
                "selection_reason": "split_merge_candidate",
                "bbox_quality": "valid",
                "crop_quality": "usable",
                "crop_evidence": None,
                "review_reason": "One-to-many candidate; no safe one-to-one match.",
            }
            await session.execute(
                text("""
                    UPDATE pagerevisions
                    SET processingmeta = jsonb_set(
                        jsonb_set(
                            processingmeta,
                            '{word_evidence_v2,0}',
                            CAST(:evidence AS jsonb),
                            true
                        ),
                        '{word_review_statuses,0}',
                        '"needs_review"'::jsonb,
                        true
                    )
                    WHERE id = :revision
                """),
                {
                    "evidence": json.dumps(merge_evidence),
                    "revision": revision_id,
                },
            )
            await session.commit()

        app = self._test_app()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/books/admin/pages/{PAGE_ID}/revisions/{revision_id}"
            )
        self.assertEqual(response.status_code, 200, response.text)
        first_word = response.json()["words"][0]
        self.assertEqual(first_word["ocr_evidence"]["alignment"], "merge")
        self.assertEqual(
            first_word["ocr_evidence"]["engine_outputs"],
            {"paddleocr": None, "vietocr": "Ngày", "tesseract": None},
        )
        self.assertEqual(first_word["ocr_evidence"]["vietocr_token_index"], 0)
        self.assertIsNone(first_word["ocr_evidence"]["paddle_token_index"])
        self.assertEqual(first_word["ocr_review_status"], "needs_review")
        self.assertEqual(first_word["review_color_group"], "yellow")

        async with self.sessions() as session:
            persisted = await session.get(PageRevision, revision_id)
            self.assertEqual(
                persisted.ProcessingMeta["word_evidence_v2"][0]["alignment"],
                "merge",
            )
            self.assertEqual(
                persisted.ProcessingMeta["word_evidence_v2"][0]["engine_outputs"]["vietocr"],
                "Ngày",
            )

    async def test_partial_dual_engine_evidence_survives_postgres_revision_api_read(self):
        partial_evidence = {
            "contract": "hybrid_ocr_evidence_v4",
            "engine_outputs": {"paddleocr": None, "vietocr": "Ngày", "tesseract": None},
            "engine_statuses": {},
            "alignment": "not_computed",
            "paddle_token_index": -1,
            "vietocr_token_index": 0,
            "selected_engine": "vietocr",
            "review_reason": "Legacy partial candidate record.",
        }
        line_evidence = {
            "line_evidence": [{
                "line_index": 0,
                "paddle_output": "Ngay xưa có bé.",
                "vietocr_output": "Ngày xưa có bé.",
                "vietocr_output_used": True,
                "engine_statuses": {
                    "paddleocr": "success",
                    "vietocr": "success",
                    "tesseract": "not_run",
                },
                "alignment_operations": [{
                    "operation": "substitute",
                    "selected_token_index": 0,
                    "paddle_token_index": -1,
                    "vietocr_token_index": 0,
                    "paddle_token": "Ngay",
                    "vietocr_token": "Ngày",
                }],
            }],
        }
        async with self.sessions() as session:
            await session.execute(
                text("""
                    UPDATE pagerevisions
                    SET processingmeta =
                        jsonb_set(
                            processingmeta,
                            '{word_evidence_v2,0}',
                            CAST(:evidence AS jsonb),
                            true
                        ) || CAST(:line AS jsonb)
                    WHERE id = :revision
                """),
                {
                    "evidence": json.dumps(partial_evidence),
                    "line": json.dumps(line_evidence),
                    "revision": R1_ID,
                },
            )
            await session.commit()

        app = self._test_app()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                f"/books/admin/pages/{PAGE_ID}/revisions/{R1_ID}"
            )
        self.assertEqual(response.status_code, 200, response.text)
        first_word = response.json()["words"][0]
        self.assertEqual(
            first_word["ocr_evidence"]["engine_outputs"],
            {"paddleocr": "Ngay", "vietocr": "Ngày", "tesseract": None},
        )
        self.assertEqual(first_word["ocr_evidence"]["alignment"], "substitute")
        self.assertIsNone(first_word["ocr_evidence"]["paddle_token_index"])
        self.assertEqual(first_word["ocr_evidence"]["vietocr_token_index"], 0)
        # This source revision is already admin-verified; verified state has
        # higher priority than historical disagreement in its original OCR candidates.
        self.assertEqual(first_word["review_color_group"], "green")

    async def test_duplicate_concurrent_draft_is_rejected_after_row_lock(self):
        async def create():
            async with self.sessions() as session:
                return await AdminOcrService(session).create_edit_draft(
                    ACTOR, PAGE_ID, R1_ID
                )

        outcomes = await asyncio.gather(
            create(), create(), return_exceptions=True
        )
        succeeded = [item for item in outcomes if not isinstance(item, Exception)]
        failed = [item for item in outcomes if isinstance(item, Exception)]
        self.assertEqual(len(succeeded), 1)
        self.assertEqual(len(failed), 1)
        self.assertEqual(getattr(failed[0], "status_code", None), 409)
        async with self.sessions() as session:
            count = await session.scalar(
                text("SELECT count(*) FROM pagerevisions WHERE pageid = :page"),
                {"page": PAGE_ID},
            )
            self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()
