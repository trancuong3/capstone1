"""Isolated tutor contracts, authorization, ORM scoping and context tests.

No network, real database, provider calls or child-data writes are performed.
"""

import os
import unicodedata
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from app.repositories.tutor_repository import (
    TutorPageRecord,
    TutorRepository,
    TutorSessionRecord,
)
from app.schemas.tutor import TutorExplainWordRequest, TutorExplainWordResponse
from app.services.tutor_service import MAX_CONTEXT_CHARACTERS, TutorService


PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
CHILD_ID = UUID("22222222-2222-4222-8222-222222222222")
BOOK_ID = UUID("33333333-3333-4333-8333-333333333333")
PAGE_ID = UUID("44444444-4444-4444-8444-444444444444")
REVISION_ID = UUID("55555555-5555-4555-8555-555555555555")
WORD_ID = UUID("66666666-6666-4666-8666-666666666666")
SESSION_ID = UUID("77777777-7777-4777-8777-777777777777")


def make_words(text: str, selected_index: int = 2) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            Id=WORD_ID if index == selected_index else uuid4(),
            PageRevisionId=REVISION_ID,
            WordIndex=index,
            Text=token,
        )
        for index, token in enumerate(text.split())
    ]


class TutorSchemaTests(unittest.TestCase):
    def test_request_accepts_uuid_strings(self):
        payload = TutorExplainWordRequest(
            page_revision_id=str(REVISION_ID), word_id=str(WORD_ID)
        )
        self.assertEqual(payload.page_revision_id, REVISION_ID)
        self.assertEqual(payload.word_id, WORD_ID)

    def test_request_rejects_invalid_missing_and_client_supplied_context(self):
        valid = {"page_revision_id": REVISION_ID, "word_id": WORD_ID}
        invalid_payloads = [
            {},
            {"word_id": WORD_ID},
            {"page_revision_id": REVISION_ID},
            {**valid, "word_id": "not-a-uuid"},
            {**valid, "page_revision_id": None},
        ]
        for extra in ("word", "grade", "prompt", "text", "context_text", "parent_id"):
            invalid_payloads.append({**valid, extra: "client supplied"})
        for data in invalid_payloads:
            with self.subTest(data=data), self.assertRaises(ValidationError):
                TutorExplainWordRequest.model_validate(data)

    def test_response_trims_text_and_exposes_only_public_fields(self):
        response = TutorExplainWordResponse(
            page_revision_id=REVISION_ID,
            word_id=WORD_ID,
            word=" nghiêng ",
            explanation=" Lệch sang một bên. ",
            reading_hint=" Bé đọc lại câu nhé. ",
        )
        self.assertEqual(response.word, "nghiêng")
        self.assertEqual(response.explanation, "Lệch sang một bên.")
        self.assertEqual(response.reading_hint, "Bé đọc lại câu nhé.")
        self.assertEqual(
            set(response.model_dump()),
            {"page_revision_id", "word_id", "word", "explanation", "reading_hint"},
        )

    def test_response_rejects_blank_oversized_and_private_fields(self):
        valid = dict(
            page_revision_id=REVISION_ID,
            word_id=WORD_ID,
            word="nghiêng",
            explanation="Lệch sang một bên.",
            reading_hint="Bé đọc lại câu nhé.",
        )
        for field, limit in (("word", 500), ("explanation", 600), ("reading_hint", 180)):
            for value in ("  \n ", "x" * (limit + 1), 42):
                with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                    TutorExplainWordResponse.model_validate({**valid, field: value})
        with self.assertRaises(ValidationError):
            TutorExplainWordResponse.model_validate({**valid, "provider_response": "private"})


class TutorServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.text = "Bé Tú nghiêng đầu nhìn chú mèo."
        self.profile = SimpleNamespace(Id=PARENT_ID, Role="parent", Active=1)
        self.child = SimpleNamespace(Id=CHILD_ID, ParentId=PARENT_ID, Grade=1)
        self.session = SimpleNamespace(
            Id=SESSION_ID,
            ChildId=CHILD_ID,
            BookId=BOOK_ID,
            SelectedPageId=PAGE_ID,
            SelectedPageRevisionId=REVISION_ID,
            State="IN_PROGRESS",
            EndedAt=None,
        )
        self.book = SimpleNamespace(Id=BOOK_ID, LifecycleStatus="ACTIVE")
        self.page = SimpleNamespace(
            Id=PAGE_ID,
            BookId=BOOK_ID,
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=REVISION_ID,
        )
        self.revision = SimpleNamespace(
            Id=REVISION_ID,
            PageId=PAGE_ID,
            VerificationStatus="VERIFIED",
            VerifiedText=self.text,
        )
        self.repo = SimpleNamespace(
            profile=AsyncMock(return_value=self.profile),
            owned_session=AsyncMock(return_value=TutorSessionRecord(self.session, self.child)),
            page_revision=AsyncMock(return_value=TutorPageRecord(self.book, self.page, self.revision)),
            revision_words=AsyncMock(return_value=make_words(self.text)),
        )
        self.service = TutorService(self.repo)
        self.payload = TutorExplainWordRequest(page_revision_id=REVISION_ID, word_id=WORD_ID)

    async def context(self):
        return await self.service.get_word_context(PARENT_ID, SESSION_ID, self.payload)

    async def assert_http_error(self, status: int):
        with self.assertRaises(HTTPException) as raised:
            await self.context()
        self.assertEqual(raised.exception.status_code, status)
        return raised.exception

    async def test_context_uses_persisted_grade_text_and_selected_word(self):
        result = await self.context()
        self.assertEqual(result.page_revision_id, REVISION_ID)
        self.assertEqual(result.word_id, WORD_ID)
        self.assertEqual(result.word, "nghiêng")
        self.assertEqual(result.context_text, self.text)
        self.assertEqual(result.grade, 1)
        self.repo.owned_session.assert_awaited_once_with(SESSION_ID, PARENT_ID)
        self.repo.page_revision.assert_awaited_once_with(BOOK_ID, PAGE_ID, REVISION_ID)
        self.repo.revision_words.assert_awaited_once_with(REVISION_ID)
        self.assertEqual(
            result.context_text[result.word_start:result.word_end], "nghiêng"
        )
        self.assertEqual(
            set(vars(result)),
            {
                "page_revision_id", "word_id", "word", "context_text",
                "grade", "word_start", "word_end",
            },
        )

    async def test_missing_profile_is_forbidden_before_session_lookup(self):
        self.repo.profile.return_value = None
        await self.assert_http_error(403)
        self.repo.owned_session.assert_not_awaited()

    async def test_non_parent_roles_and_inactive_profiles_are_forbidden(self):
        for role, active in (("admin", 1), ("child", 1), ("parent", 0), ("parent", None)):
            with self.subTest(role=role, active=active):
                self.profile.Role, self.profile.Active = role, active
                await self.assert_http_error(403)
        self.repo.owned_session.assert_not_awaited()

    async def test_missing_or_foreign_session_has_safe_not_found_response(self):
        self.repo.owned_session.return_value = None
        error = await self.assert_http_error(404)
        self.assertEqual(error.detail, "Reading session not found")
        self.repo.page_revision.assert_not_awaited()

    async def test_child_must_belong_to_actor_and_session(self):
        for field in ("ParentId", "Id"):
            with self.subTest(field=field):
                original = getattr(self.child, field)
                setattr(self.child, field, uuid4())
                error = await self.assert_http_error(404)
                self.assertEqual(error.detail, "Reading session not found")
                setattr(self.child, field, original)
        self.repo.page_revision.assert_not_awaited()

    async def test_supported_active_and_paused_states_allow_tutor(self):
        for state in ("IN_PROGRESS", "PAGE_READY", "LISTENING", "PAUSED"):
            with self.subTest(state=state):
                self.session.State = state
                self.assertEqual((await self.context()).word, "nghiêng")

    async def test_terminal_or_unknown_states_are_rejected_before_content_lookup(self):
        for state in ("COMPLETED", "FINISHED", "ABORTED", "CREATED", "RECONNECTING", "QUESTIONING", "unknown"):
            with self.subTest(state=state):
                self.session.State = state
                await self.assert_http_error(409)
        self.repo.page_revision.assert_not_awaited()

    async def test_ended_session_is_rejected_even_if_state_is_active(self):
        self.session.EndedAt = datetime.now(timezone.utc)
        await self.assert_http_error(409)
        self.repo.page_revision.assert_not_awaited()

    async def test_missing_page_or_revision_does_not_fall_back(self):
        for field in ("SelectedPageId", "SelectedPageRevisionId"):
            with self.subTest(field=field):
                original = getattr(self.session, field)
                setattr(self.session, field, None)
                await self.assert_http_error(409)
                setattr(self.session, field, original)
        self.repo.page_revision.assert_not_awaited()

    async def test_request_must_match_session_revision(self):
        self.payload.page_revision_id = uuid4()
        await self.assert_http_error(409)
        self.repo.page_revision.assert_not_awaited()

    async def test_invalid_grade_is_not_silently_replaced(self):
        for grade in (None, 0, 6, "1", True):
            with self.subTest(grade=grade):
                self.child.Grade = grade
                await self.assert_http_error(409)
        self.repo.page_revision.assert_not_awaited()

    async def test_missing_or_mismatched_page_book_revision_is_unavailable(self):
        self.repo.page_revision.return_value = None
        await self.assert_http_error(409)
        self.repo.revision_words.assert_not_awaited()

    async def test_retired_book_or_page_and_unverified_revision_are_rejected(self):
        for item, field, value in (
            (self.book, "LifecycleStatus", "RETIRED"),
            (self.page, "LifecycleStatus", "RETIRED"),
            (self.revision, "VerificationStatus", "NEEDS_REVIEW"),
            (self.revision, "VerificationStatus", "PROCESSING"),
        ):
            with self.subTest(field=field, value=value):
                original = getattr(item, field)
                setattr(item, field, value)
                await self.assert_http_error(409)
                setattr(item, field, original)
        self.repo.revision_words.assert_not_awaited()

    async def test_session_keeps_its_verified_revision_when_newer_one_exists(self):
        self.page.CurrentVerifiedRevisionId = uuid4()
        result = await self.context()
        self.assertEqual(result.page_revision_id, REVISION_ID)
        self.repo.page_revision.assert_awaited_once_with(BOOK_ID, PAGE_ID, REVISION_ID)

    async def test_blank_verified_text_does_not_use_draft_text(self):
        self.revision.DraftText = "Unverified text"
        for text in (None, "", "  \n "):
            with self.subTest(text=text):
                self.revision.VerifiedText = text
                await self.assert_http_error(409)
        self.repo.revision_words.assert_not_awaited()

    async def test_missing_word_in_selected_revision_is_rejected(self):
        self.payload.word_id = uuid4()
        await self.assert_http_error(409)

    async def test_empty_word_list_is_rejected(self):
        self.repo.revision_words.return_value = []
        await self.assert_http_error(409)

    async def test_misaligned_text_and_word_positions_are_rejected(self):
        original = make_words(self.text)
        for words in (
            original[:-1],
            [SimpleNamespace(**{**vars(word), "WordIndex": index + 1}) for index, word in enumerate(original)],
            [SimpleNamespace(**{**vars(word), "Text": "khác" if word.Id == WORD_ID else word.Text}) for word in original],
        ):
            with self.subTest(words=words):
                self.repo.revision_words.return_value = words
                await self.assert_http_error(409)

    async def test_invalid_word_text_is_rejected(self):
        for text in (None, "", " ", "x" * 501):
            with self.subTest(text=text):
                words = make_words(self.text)
                words[2].Text = text
                self.repo.revision_words.return_value = words
                await self.assert_http_error(409)

    async def test_unicode_accents_case_punctuation_and_line_breaks_are_preserved(self):
        text = "Bé Tú\n“nghiêng”, đầu."
        self.revision.VerifiedText = unicodedata.normalize("NFD", text)
        words = make_words("bé tú NGHIÊNG đầu")
        self.repo.revision_words.return_value = words
        result = await self.context()
        self.assertEqual(result.context_text, text)
        self.assertEqual(result.word, "NGHIÊNG")

    async def test_context_ignores_standalone_edge_punctuation_like_ocr(self):
        self.revision.VerifiedText = "Bé Tú … nghiêng đầu."
        self.repo.revision_words.return_value = make_words("Bé Tú nghiêng đầu.")
        self.assertEqual((await self.context()).word, "nghiêng")

    async def test_short_context_identifies_selected_repeated_word_by_offsets(self):
        text = "Bé chọn đường đi rồi mua đường làm bánh."
        self.revision.VerifiedText = text
        self.repo.revision_words.return_value = make_words(text, selected_index=6)
        result = await self.context()
        self.assertEqual(result.word, "đường")
        self.assertEqual(result.context_text, text)
        self.assertEqual(result.word_start, text.rindex("đường"))
        self.assertEqual(result.context_text[result.word_start:result.word_end], "đường")

    async def test_long_context_centers_on_selected_occurrence_not_first_match(self):
        text = "nghiêng " + "trước " * 900 + "nghiêng MỐC " + "sau " * 900
        self.revision.VerifiedText = text
        self.repo.revision_words.return_value = make_words(text, selected_index=901)
        result = await self.context()
        self.assertLessEqual(len(result.context_text), MAX_CONTEXT_CHARACTERS)
        self.assertIn("nghiêng MỐC", result.context_text)
        self.assertFalse(result.context_text.startswith("nghiêng"))
        self.assertEqual(result.context_text[result.word_start:result.word_end], "nghiêng")

    async def test_context_window_keeps_whole_tokens_at_both_page_edges(self):
        text = " ".join(f"từ{index}" for index in range(1_200))
        page_tokens = set(text.split())
        self.revision.VerifiedText = text
        for selected_index in (0, 1_199):
            with self.subTest(selected_index=selected_index):
                self.repo.revision_words.return_value = make_words(text, selected_index)
                result = await self.context()
                self.assertLessEqual(len(result.context_text), MAX_CONTEXT_CHARACTERS)
                self.assertIn(f"từ{selected_index}", result.context_text.split())
                self.assertTrue(set(result.context_text.split()).issubset(page_tokens))


class TutorRepositoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = MagicMock()
        # AsyncSession.execute is awaited, but its buffered Result methods are
        # synchronous (unlike AsyncSession.stream / AsyncResult).
        self.db.execute = AsyncMock(return_value=MagicMock())
        self.db.scalar = AsyncMock()
        self.repository = TutorRepository(self.db)

    def query(self):
        statement = self.db.execute.call_args.args[0]
        return statement.compile(dialect=postgresql.dialect())

    def tearDown(self):
        self.db.add.assert_not_called()
        self.db.commit.assert_not_called()
        self.db.flush.assert_not_called()
        self.db.delete.assert_not_called()

    async def test_profile_lookup_is_scoped_to_actor(self):
        self.db.scalar.return_value = "profile"
        self.assertEqual(await self.repository.profile(PARENT_ID), "profile")
        statement = self.db.scalar.call_args.args[0].compile(dialect=postgresql.dialect())
        self.assertIn(PARENT_ID, statement.params.values())
        self.assertIn("profiles.id =", str(statement))

    async def test_owned_session_query_binds_both_parent_and_session(self):
        session, child = object(), object()
        self.db.execute.return_value.one_or_none.return_value = (session, child)
        record = await self.repository.owned_session(SESSION_ID, PARENT_ID)
        self.assertIs(record.session, session)
        self.assertIs(record.child, child)
        compiled = self.query()
        self.assertEqual(set(compiled.params.values()), {SESSION_ID, PARENT_ID})
        self.assertIn("childprofiles.id = readingsessions.childid", str(compiled))
        self.assertIn("childprofiles.parentid =", str(compiled))
        self.assertIn("readingsessions.id =", str(compiled))

    async def test_missing_owned_session_returns_none(self):
        self.db.execute.return_value.one_or_none.return_value = None
        self.assertIsNone(await self.repository.owned_session(SESSION_ID, PARENT_ID))

    async def test_page_revision_query_binds_book_page_and_exact_revision(self):
        book, page, revision = object(), object(), object()
        self.db.execute.return_value.one_or_none.return_value = (book, page, revision)
        record = await self.repository.page_revision(BOOK_ID, PAGE_ID, REVISION_ID)
        self.assertIs(record.book, book)
        self.assertIs(record.page, page)
        self.assertIs(record.revision, revision)
        compiled = self.query()
        self.assertEqual(set(compiled.params.values()), {BOOK_ID, PAGE_ID, REVISION_ID})
        self.assertIn("bookpages.bookid = books.id", str(compiled))
        self.assertIn("pagerevisions.pageid = bookpages.id", str(compiled))

    async def test_missing_page_revision_returns_none(self):
        self.db.execute.return_value.one_or_none.return_value = None
        self.assertIsNone(await self.repository.page_revision(BOOK_ID, PAGE_ID, REVISION_ID))

    async def test_revision_words_are_scoped_and_ordered_by_word_index(self):
        words = [object(), object()]
        self.db.execute.return_value.scalars.return_value.all.return_value = words
        self.assertEqual(await self.repository.revision_words(REVISION_ID), words)
        compiled = self.query()
        self.assertEqual(list(compiled.params.values()), [REVISION_ID])
        self.assertIn("pagerevisionwords.pagerevisionid =", str(compiled))
        self.assertIn("ORDER BY pagerevisionwords.wordindex", str(compiled))


if __name__ == "__main__":
    unittest.main()
