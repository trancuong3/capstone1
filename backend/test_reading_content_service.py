import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
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
                VerifiedText="Chú",
            )),
            create_session=AsyncMock(side_effect=lambda session: session),
            save_session=AsyncMock(side_effect=lambda session: session),
            update_session_state=MagicMock(
                side_effect=lambda session, *, state, ended_at: (
                    setattr(session, "State", state),
                    setattr(session, "EndedAt", ended_at),
                )
            ),
            session=AsyncMock(),
            revision_words=AsyncMock(
                return_value=[
                    SimpleNamespace(
                        Text="Chú",
                        BoundingBox=[0.1, 0.2, 0.12, 0.04],
                    )
                ]
            ),
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

    async def test_create_session_fails_before_persistence_when_verified_revision_has_no_word_boxes(self):
        service, repo = self.make_service()
        repo.revision_words.return_value = []
        payload = ReadingSessionCreate(
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            State="CREATED",
            SelectedPageId=PAGE_ID,
            SelectedPageRevisionId=REVISION_ID,
        )

        with self.assertRaises(HTTPException) as raised:
            await service.create_session(PARENT_ID, payload)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], "CONTENT_NOT_READY")
        repo.create_session.assert_not_awaited()

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

    async def test_finish_session_checks_owner_and_persists_session_state(self):
        service, repo = self.make_service()
        session = SimpleNamespace(
            Id=UUID("77777777-7777-4777-8777-777777777777"),
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            State="IN_PROGRESS",
            StartedAt=datetime(2026, 10, 15, 1, 0, tzinfo=timezone.utc),
            EndedAt=None,
        )
        repo.session.return_value = session

        result = await service.finish_session(
            session.Id,
            PARENT_ID,
        )

        self.assertEqual(result.state, "FINISHED")
        self.assertIsNotNone(result.ended_at)
        repo.update_session_state.assert_called_once()
        repo.save_session.assert_awaited_once_with(session)

    async def test_finish_session_is_idempotent_after_completion(self):
        service, repo = self.make_service()
        ended_at = datetime(2026, 10, 15, 2, 0, tzinfo=timezone.utc)
        session = SimpleNamespace(
            Id=UUID("77777777-7777-4777-8777-777777777777"),
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            State="COMPLETED",
            StartedAt=datetime(2026, 10, 15, 1, 0, tzinfo=timezone.utc),
            EndedAt=ended_at,
        )
        repo.session.return_value = session

        result = await service.finish_session(session.Id, PARENT_ID)

        self.assertEqual(result.state, "FINISHED")
        self.assertEqual(result.ended_at, ended_at)
        repo.update_session_state.assert_not_called()
        repo.save_session.assert_not_awaited()

    async def test_selected_page_must_belong_to_owned_reading_session_book(self):
        service, repo = self.make_service()
        repo.session.return_value = SimpleNamespace(
            Id=UUID("77777777-7777-4777-8777-777777777777"),
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            SelectedPageId=PAGE_ID,
            SelectedPageRevisionId=REVISION_ID,
        )
        repo.verified_page.return_value = None

        with self.assertRaises(HTTPException) as raised:
            await service.get_page(
                UUID("88888888-8888-4888-8888-888888888888"),
                UUID("77777777-7777-4777-8777-777777777777"),
                PARENT_ID,
            )

        self.assertEqual(raised.exception.status_code, 404)
        repo.verified_page.assert_awaited_once_with(
            UUID("88888888-8888-4888-8888-888888888888"),
            BOOK_ID,
        )

    async def test_selected_page_request_checks_session_ownership_first(self):
        service, repo = self.make_service()
        repo.session.return_value = SimpleNamespace(
            Id=UUID("77777777-7777-4777-8777-777777777777"),
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            SelectedPageId=PAGE_ID,
            SelectedPageRevisionId=REVISION_ID,
        )
        repo.child_belongs_to_parent.return_value = False

        with self.assertRaises(HTTPException) as raised:
            await service.get_page(PAGE_ID, UUID("77777777-7777-4777-8777-777777777777"), PARENT_ID)

        self.assertEqual(raised.exception.status_code, 404)
        repo.verified_page.assert_not_awaited()

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
