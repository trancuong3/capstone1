import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException

from app.schemas.reading import ReadingSessionCreate
from app.services.reading_content_service import ReadingContentService


PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
CHILD_ID = UUID("22222222-2222-4222-8222-222222222222")
BOOK_ID = UUID("33333333-3333-4333-8333-333333333333")
PAGE_ID = UUID("44444444-4444-4444-8444-444444444444")
REVISION_ID = UUID("55555555-5555-4555-8555-555555555555")


class ReadingContentServiceTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self):
        repo = SimpleNamespace(
            profile_role=AsyncMock(return_value="parent"),
            child_belongs_to_parent=AsyncMock(return_value=True),
            verified_page=AsyncMock(return_value=SimpleNamespace(
                Id=PAGE_ID,
                BookId=BOOK_ID,
                CurrentVerifiedRevisionId=REVISION_ID,
                LifecycleStatus="ACTIVE",
            )),
            first_verified_page=AsyncMock(),
            verified_revision=AsyncMock(return_value=SimpleNamespace(
                Id=REVISION_ID,
                PageId=PAGE_ID,
                VerificationStatus="VERIFIED",
            )),
            create_session=AsyncMock(side_effect=lambda session: session),
            session=AsyncMock(),
            revision_words=AsyncMock(return_value=[]),
        )
        return ReadingContentService(repo), repo

    async def test_create_session_references_existing_verified_page_only(self):
        service, repo = self.make_service()
        payload = ReadingSessionCreate(
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            State="CREATED",
            SelectedPageId=PAGE_ID,
            SelectedPageRevisionId=REVISION_ID,
        )

        result = await service.create_session(PARENT_ID, payload)

        self.assertEqual(result.ChildId, CHILD_ID)
        self.assertEqual(result.BookId, BOOK_ID)
        self.assertEqual(result.SelectedPageId, PAGE_ID)
        self.assertEqual(result.SelectedPageRevisionId, REVISION_ID)
        self.assertEqual(result.State, "IN_PROGRESS")
        repo.create_session.assert_awaited_once()
        repo.first_verified_page.assert_not_awaited()

    async def test_create_session_fails_before_persistence_when_book_has_no_verified_page(self):
        service, repo = self.make_service()
        repo.verified_page.return_value = None
        payload = ReadingSessionCreate(
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            State="CREATED",
            SelectedPageId=PAGE_ID,
        )

        with self.assertRaises(HTTPException) as raised:
            await service.create_session(PARENT_ID, payload)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "CONTENT_NOT_READY")
        repo.create_session.assert_not_awaited()

    async def test_create_session_rejects_child_owned_by_another_parent(self):
        service, repo = self.make_service()
        repo.child_belongs_to_parent.return_value = False
        payload = ReadingSessionCreate(ChildId=CHILD_ID, BookId=BOOK_ID)

        with self.assertRaises(HTTPException) as raised:
            await service.create_session(PARENT_ID, payload)

        self.assertEqual(raised.exception.status_code, 404)
        repo.create_session.assert_not_awaited()
        repo.verified_page.assert_not_awaited()

    async def test_create_session_rejects_non_parent_role(self):
        service, repo = self.make_service()
        repo.profile_role.return_value = "admin"
        payload = ReadingSessionCreate(ChildId=CHILD_ID, BookId=BOOK_ID)

        with self.assertRaises(HTTPException) as raised:
            await service.create_session(PARENT_ID, payload)

        self.assertEqual(raised.exception.status_code, 403)
        repo.child_belongs_to_parent.assert_not_awaited()
        repo.create_session.assert_not_awaited()

    async def test_page_dto_does_not_invent_bounding_boxes(self):
        service, repo = self.make_service()
        page = SimpleNamespace(
            Id=PAGE_ID,
            CurrentVerifiedRevisionId=REVISION_ID,
            PageNumber=1,
            Width=600,
            Height=800,
            ImagePath="books/test/page.png",
        )
        revision = SimpleNamespace(Id=REVISION_ID, VerifiedText="Chú mèo")
        repo.revision_words.return_value = [
            SimpleNamespace(
                Id=UUID("66666666-6666-4666-8666-666666666666"),
                WordIndex=0,
                Text="Chú",
                BoundingBox=[0.1, 0.2, 0.12, 0.04],
                OCRConfidence=0.93,
            )
        ]

        from unittest.mock import patch
        with patch(
            "app.services.reading_content_service.create_signed_image_url",
            return_value="https://example.com/signed-page.png",
        ):
            dto = await service._build_page_dto(page, revision)

        self.assertEqual(dto.width, 600)
        self.assertEqual(dto.height, 800)
        self.assertEqual(dto.confidence, 0.93)
        self.assertEqual(dto.words[0].bbox, (0.1, 0.2, 0.12, 0.04))

        repo.revision_words.return_value = []
        with self.assertRaises(HTTPException) as raised:
            await service._build_page_dto(page, revision)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "CONTENT_NOT_READY")


if __name__ == "__main__":
    unittest.main()
