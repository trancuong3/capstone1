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

    async def asyncTearDown(self):
        await self.engine.dispose()
        async with self.admin_engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        await self.admin_engine.dispose()

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
            self.assertEqual(r2["ocr_metadata"]["source_revision_id"], str(R1_ID))
            self.assertEqual(r2["words"][2]["ocr_confidence"], None)

            changed_words = r2["words"]
            changed_words[3]["text"] = "em."
            changed_words[3]["normalized_text"] = "em"
            saved = await client.put(
                f"/books/admin/pages/{PAGE_ID}/revisions/{r2['page_revision_id']}/draft",
                json={"draft_text": "Ngày xưa có em.", "words": changed_words},
            )
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["draft_text"], "Ngày xưa có em.")

            verified = await client.post(
                f"/books/admin/pages/{PAGE_ID}/verify",
                json={
                    "page_revision_id": r2["page_revision_id"],
                    "corrected_text": "Ngày xưa có em.",
                    "words": saved.json()["words"],
                },
            )
            self.assertEqual(verified.status_code, 200, verified.text)
            self.assertEqual(verified.json()["verification_status"], "VERIFIED")
            self.assertEqual(verified.json()["draft_text"], "Ngày xưa có em.")
            self.assertEqual(
                [word["ocr_review_status"] for word in verified.json()["words"]],
                ["verified"] * 4,
            )

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
