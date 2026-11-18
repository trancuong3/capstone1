import os
import asyncio
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import MissingGreenlet
from sqlalchemy.orm import make_transient_to_detached

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import sentence_shooter as sentence_shooter_routes
from app.models import Book, ChildProfile, GameAttempt, GameRound, GameSession
from app.repositories.sentence_shooter_repository import SentenceShooterRepository
from app.schemas.sentence_shooter import SentenceShooterSessionCreate
from app.services.games.scoring import stars_for_round
from app.services.games.sentence_extraction import (
    extract_verified_sentences,
    normalize_token,
)
from app.services.games.sentence_shooter_service import SentenceShooterService
from app.services.games.sentence_shuffling import shuffle_token_ids


PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
CHILD_ID = UUID("22222222-2222-4222-8222-222222222222")
OTHER_CHILD_ID = UUID("99999999-9999-4999-8999-999999999999")
BOOK_ID = UUID("33333333-3333-4333-8333-333333333333")
PAGE_ID = UUID("44444444-4444-4444-8444-444444444444")
REVISION_ID = UUID("55555555-5555-4555-8555-555555555555")
VERIFIED_TEXT = "Bé đang đọc sách. Bé thích xem truyện."


def source_rows():
    book = SimpleNamespace(
        Id=BOOK_ID,
        Name="Cuốn sách nhỏ",
        Title="Cuốn sách nhỏ",
        Author="Tác giả",
        MinGrade=1,
        MaxGrade=5,
        LifecycleStatus="ACTIVE",
    )
    page = SimpleNamespace(Id=PAGE_ID, BookId=BOOK_ID, PageNumber=1)
    revision = SimpleNamespace(
        Id=REVISION_ID,
        PageId=PAGE_ID,
        VerificationStatus="VERIFIED",
        VerifiedText=VERIFIED_TEXT,
    )
    words = [
        SimpleNamespace(
            Id=uuid4(),
            WordIndex=index,
            LineIndex=0,
            Text=token,
            NormalizedText=normalize_token(token),
        )
        for index, token in enumerate(VERIFIED_TEXT.split())
    ]
    return book, page, revision, words


class FakeSentenceShooterRepository:
    def __init__(self):
        self.book_record, self.page, self.revision, words = source_rows()
        self.rows = [
            (self.book_record, self.page, self.revision, word) for word in words
        ]
        self.child = SimpleNamespace(Id=CHILD_ID, ParentId=PARENT_ID, Grade=2)
        self.sessions: list[GameSession] = []
        self.rounds_by_session: list[GameRound] = []
        self.attempts: list[GameAttempt] = []

    async def profile_role(self, profile_id):
        return "parent" if profile_id == PARENT_ID else None

    async def child_owned_by(self, child_id, parent_id):
        if child_id == self.child.Id and parent_id == self.child.ParentId:
            return self.child
        return None

    async def verified_word_rows(self, grade, book_id=None):
        if book_id is not None and book_id != BOOK_ID:
            return []
        return self.rows if 1 <= grade <= 5 else []

    async def book(self, book_id):
        return self.book_record if book_id == BOOK_ID else None

    async def book_for_session(self, book_id):
        return self.book_record if book_id == BOOK_ID else None

    async def session_for_parent(self, session_id, parent_id, *, lock=False):
        session = next(
            (row for row in self.sessions if row.Id == session_id),
            None,
        )
        if session is None or session.ChildProfileId != self.child.Id:
            return None
        return session if parent_id == self.child.ParentId else None

    async def game_round(self, session_id, round_id, *, lock=False):
        return next(
            (
                row
                for row in self.rounds_by_session
                if row.GameSessionId == session_id and row.Id == round_id
            ),
            None,
        )

    async def rounds(self, session_id):
        return sorted(
            [row for row in self.rounds_by_session if row.GameSessionId == session_id],
            key=lambda row: row.RoundNumber,
        )

    async def attempt(self, session_id, request_id):
        return next(
            (
                row
                for row in self.attempts
                if row.GameSessionId == session_id and row.RequestId == request_id
            ),
            None,
        )

    def add(self, row):
        if isinstance(row, GameSession):
            self.sessions.append(row)
        elif isinstance(row, GameRound):
            self.rounds_by_session.append(row)
        elif isinstance(row, GameAttempt):
            self.attempts.append(row)

    def add_all(self, rows):
        for row in rows:
            self.add(row)

    async def flush(self):
        return None

    async def commit(self):
        return None

    async def rollback(self):
        return None


class CommitExpiringSentenceShooterRepository(FakeSentenceShooterRepository):
    """Simulate SQLAlchemy expiration to guard response construction after commit."""

    def __init__(self):
        super().__init__()
        self.expire_on_next_commit = False

    async def commit(self):
        if not self.expire_on_next_commit:
            return None
        self.expire_on_next_commit = False
        for row in [*self.sessions, *self.rounds_by_session]:
            make_transient_to_detached(row)
            state = inspect(row)
            for attribute in state.mapper.column_attrs:
                state.dict.pop(attribute.key, None)
                state.expired_attributes.add(attribute.key)


class SentenceExtractionTests(unittest.TestCase):
    def make_words(self, text: str):
        return [
            SimpleNamespace(
                Id=uuid4(),
                WordIndex=index,
                LineIndex=0,
                Text=token,
                NormalizedText=normalize_token(token),
            )
            for index, token in enumerate(text.split())
        ]

    def test_extracts_sentences_and_keeps_punctuation_attached(self):
        text = "Bé đang đọc sách. Bé thích xem truyện!"
        words = self.make_words(text)

        sentences = extract_verified_sentences(text, words)

        self.assertEqual([item.text for item in sentences], [
            "Bé đang đọc sách.",
            "Bé thích xem truyện!",
        ])
        self.assertEqual(sentences[0].tokens[-1].text, "sách.")
        self.assertNotEqual(sentences[0].tokens[0].token_id, sentences[1].tokens[0].token_id)

    def test_unicode_normalization_preserves_tone_marks(self):
        composed = "má"
        decomposed = "ma\u0301"
        self.assertEqual(normalize_token(composed), normalize_token(decomposed))
        self.assertNotEqual(normalize_token("ma"), normalize_token("má"))

    def test_inconsistent_or_missing_verified_word_data_is_rejected(self):
        text = "Bé đang đọc sách."
        words = self.make_words(text)
        words[2].Text = "viết"

        self.assertEqual(extract_verified_sentences(text, words), [])
        self.assertEqual(extract_verified_sentences(text, []), [])

    def test_short_sentences_are_not_returned(self):
        text = "Bé đi."
        self.assertEqual(
            extract_verified_sentences(text, self.make_words(text)),
            [],
        )

    def test_newline_is_a_fallback_boundary_without_sentence_punctuation(self):
        text = "Bé đang đọc sách\nBé thích xem truyện"
        sentences = extract_verified_sentences(text, self.make_words(text))
        self.assertEqual(len(sentences), 2)

    def test_shuffle_preserves_every_unique_token_and_changes_order(self):
        class NoOpRandom:
            def shuffle(self, values):
                return None

            def randrange(self, start, stop=None):
                return start

        token_ids = [uuid4(), uuid4(), uuid4(), uuid4()]
        shuffled = shuffle_token_ids(token_ids, rng=NoOpRandom())

        self.assertCountEqual(shuffled, token_ids)
        self.assertNotEqual(shuffled, token_ids)

    def test_scoring_never_removes_all_stars(self):
        self.assertEqual(stars_for_round(0, 0), 3)
        self.assertEqual(stars_for_round(1, 0), 2)
        self.assertEqual(stars_for_round(1, 1), 1)
        self.assertEqual(stars_for_round(20, 20), 1)


class SentenceShooterServiceTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self):
        repository = FakeSentenceShooterRepository()
        return SentenceShooterService(repository), repository

    async def start(self, service, total_rounds=2):
        return await service.create_session(
            PARENT_ID,
            SentenceShooterSessionCreate(
                child_id=CHILD_ID,
                book_id=BOOK_ID,
                difficulty="easy",
                total_rounds=total_rounds,
            ),
        )

    async def test_book_list_only_includes_books_with_enough_verified_sentences(self):
        service, _ = self.make_service()

        books = await service.list_books(PARENT_ID, CHILD_ID, "easy", total_rounds=2)
        unavailable = await service.list_books(
            PARENT_ID,
            CHILD_ID,
            "easy",
            total_rounds=3,
        )

        self.assertEqual(len(books), 1)
        self.assertEqual(books[0].available_rounds, 2)
        self.assertEqual(unavailable, [])

    async def test_start_returns_shuffled_tokens_without_answer_order(self):
        service, repository = self.make_service()

        response = await self.start(service)
        saved_round = repository.rounds_by_session[0]

        self.assertEqual(response.round.token_count, 4)
        self.assertCountEqual(
            [str(token.id) for token in response.round.tokens],
            saved_round.ExpectedTokenIds,
        )
        self.assertNotIn("expected_token_ids", response.round.model_dump())
        self.assertNotIn("sentence", response.model_dump())

    async def test_child_attributes_are_snapshotted_before_verified_read_rollback(self):
        service, repository = self.make_service()

        class ExpiringChild:
            ParentId = PARENT_ID

            def __init__(self):
                self.expired = False

            @property
            def Id(self):
                if self.expired:
                    raise MissingGreenlet("expired child id attempted implicit async I/O")
                return CHILD_ID

            @property
            def Grade(self):
                if self.expired:
                    raise MissingGreenlet("expired child grade attempted implicit async I/O")
                return 2

        child = ExpiringChild()
        repository.child = child

        async def rows_after_rollback(_grade, book_id=None):
            child.expired = True
            return repository.rows if book_id == BOOK_ID else []

        repository.verified_word_rows = rows_after_rollback
        response = await self.start(service)

        self.assertEqual(response.session_id, repository.sessions[0].Id)
        self.assertEqual(response.book.id, BOOK_ID)

    async def test_create_session_response_does_not_read_expired_rows_after_commit(self):
        repository = CommitExpiringSentenceShooterRepository()
        repository.expire_on_next_commit = True
        service = SentenceShooterService(repository)

        response = await self.start(service)

        self.assertIsInstance(response.session_id, UUID)
        self.assertEqual(len(repository.sessions), 1)
        self.assertEqual(response.total_rounds, 2)
        self.assertEqual(response.round.token_count, 4)

    async def test_hint_response_does_not_read_expired_rows_after_commit(self):
        repository = CommitExpiringSentenceShooterRepository()
        service = SentenceShooterService(repository)
        session = await self.start(service)
        expected_token_id = UUID(repository.rounds_by_session[0].ExpectedTokenIds[0])
        repository.expire_on_next_commit = True

        response = await service.hint(
            PARENT_ID,
            session.session_id,
            session.round.round_id,
        )

        self.assertEqual(response.target_token_id, expected_token_id)
        self.assertEqual(response.hint_count, 1)

    async def test_abandon_response_does_not_read_expired_rows_after_commit(self):
        repository = CommitExpiringSentenceShooterRepository()
        service = SentenceShooterService(repository)
        session = await self.start(service, total_rounds=1)
        repository.expire_on_next_commit = True

        response = await service.abandon(PARENT_ID, session.session_id)

        self.assertEqual(response.session_id, session.session_id)
        self.assertEqual(response.status, "ABANDONED")

    async def test_create_session_rejects_missing_child_without_database_exception(self):
        service, _ = self.make_service()
        payload = SentenceShooterSessionCreate(
            child_id=OTHER_CHILD_ID,
            book_id=BOOK_ID,
            difficulty="easy",
            total_rounds=2,
        )

        with self.assertRaises(HTTPException) as raised:
            await service.create_session(PARENT_ID, payload)

        self.assertEqual(raised.exception.status_code, 404)

    async def test_create_session_rejects_grade_inconsistent_with_verified_rows(self):
        service, repository = self.make_service()
        repository.book_record.MinGrade = 3
        repository.verified_word_rows = lambda _grade, _book_id=None: asyncio.sleep(0, result=[])

        with self.assertRaises(HTTPException) as raised:
            await self.start(service)

        self.assertEqual(raised.exception.status_code, 404)

    async def test_create_session_rejects_unknown_book(self):
        service, repository = self.make_service()
        repository.verified_word_rows = lambda _grade, _book_id=None: asyncio.sleep(0, result=[])
        payload = SentenceShooterSessionCreate(
            child_id=CHILD_ID,
            book_id=OTHER_CHILD_ID,
            difficulty="easy",
            total_rounds=2,
        )

        with self.assertRaises(HTTPException) as raised:
            await service.create_session(PARENT_ID, payload)

        self.assertEqual(raised.exception.status_code, 404)

    async def test_create_session_returns_conflict_for_valid_book_without_content(self):
        service, repository = self.make_service()
        repository.verified_word_rows = lambda _grade, _book_id=None: asyncio.sleep(0, result=[])

        with self.assertRaises(HTTPException) as raised:
            await self.start(service)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail, "INSUFFICIENT_CONTENT")

    async def test_wrong_shot_is_not_consumed_and_duplicate_request_is_idempotent(self):
        service, repository = self.make_service()
        session = await self.start(service)
        game_round = repository.rounds_by_session[0]
        expected_first = game_round.ExpectedTokenIds[0]
        wrong_token_id = next(
            UUID(token_id)
            for token_id in game_round.ShuffledTokenIds
            if token_id != expected_first
        )
        request_id = uuid4()

        first = await service.shoot(
            PARENT_ID,
            session.session_id,
            session.round.round_id,
            wrong_token_id,
            request_id,
        )
        duplicate = await service.shoot(
            PARENT_ID,
            session.session_id,
            session.round.round_id,
            wrong_token_id,
            request_id,
        )

        self.assertFalse(first.is_correct)
        self.assertEqual(first.next_expected_position, 0)
        self.assertEqual(first.mistakes_total, 1)
        self.assertEqual(duplicate, first)
        self.assertEqual(len(repository.attempts), 1)

    async def test_correct_shot_cannot_be_used_twice_and_session_finishes(self):
        service, repository = self.make_service()
        repository.rows = repository.rows[:4]
        repository.revision.VerifiedText = "Bé đang đọc sách."
        session = await self.start(service, total_rounds=1)
        game_round = repository.rounds_by_session[0]
        first_token_id = UUID(game_round.ExpectedTokenIds[0])

        await service.shoot(
            PARENT_ID,
            session.session_id,
            session.round.round_id,
            first_token_id,
            uuid4(),
        )
        with self.assertRaises(HTTPException) as repeated:
            await service.shoot(
                PARENT_ID,
                session.session_id,
                session.round.round_id,
                first_token_id,
                uuid4(),
            )
        self.assertEqual(repeated.exception.status_code, 409)

        for token_id in game_round.ExpectedTokenIds[1:]:
            result = await service.shoot(
                PARENT_ID,
                session.session_id,
                session.round.round_id,
                UUID(token_id),
                uuid4(),
            )
        self.assertTrue(result.round_completed)
        self.assertTrue(result.session_completed)
        self.assertEqual(result.completed_sentence, "Bé đang đọc sách.")

        with self.assertRaises(HTTPException) as completed:
            await service.shoot(
                PARENT_ID,
                session.session_id,
                session.round.round_id,
                UUID(game_round.ExpectedTokenIds[0]),
                uuid4(),
            )
        self.assertEqual(completed.exception.status_code, 409)

    async def test_hint_next_round_and_result_are_saved_server_side(self):
        service, repository = self.make_service()
        session = await self.start(service)
        first_round = repository.rounds_by_session[0]
        hint = await service.hint(PARENT_ID, session.session_id, first_round.Id)
        self.assertEqual(hint.target_token_id, UUID(first_round.ExpectedTokenIds[0]))
        self.assertEqual(repository.sessions[0].HintCount, 1)

        for token_id in first_round.ExpectedTokenIds:
            await service.shoot(
                PARENT_ID,
                session.session_id,
                first_round.Id,
                UUID(token_id),
                uuid4(),
            )
        next_round = await service.next_round(
            PARENT_ID,
            session.session_id,
            first_round.Id,
        )
        self.assertEqual(next_round.round.round_number, 2)

        second_round = repository.rounds_by_session[1]
        for token_id in second_round.ExpectedTokenIds:
            await service.shoot(
                PARENT_ID,
                session.session_id,
                second_round.Id,
                UUID(token_id),
                uuid4(),
            )
        repository.sessions[0].StartedAt = datetime(
            2026, 1, 1, tzinfo=timezone.utc
        )
        repository.sessions[0].CompletedAt = datetime(
            2026, 1, 1, 0, 0, 10, tzinfo=timezone.utc
        )
        result = await service.result(PARENT_ID, session.session_id)
        self.assertEqual(result.status, "COMPLETED")
        self.assertEqual(result.completed_rounds, 2)
        self.assertEqual(result.correct_count, 8)
        self.assertEqual(result.hint_count, 1)
        self.assertGreaterEqual(result.total_stars, 2)
        self.assertEqual(result.started_at.tzinfo, timezone.utc)
        self.assertEqual(result.duration_seconds, 10)

    async def test_abandon_stores_end_time_and_is_idempotent(self):
        service, repository = self.make_service()
        session = await self.start(service, total_rounds=1)
        game_session = repository.sessions[0]
        game_session.StartedAt = datetime(2026, 1, 1, tzinfo=timezone.utc)

        abandoned = await service.abandon(PARENT_ID, session.session_id)
        first_end_time = game_session.CompletedAt
        repeated = await service.abandon(PARENT_ID, session.session_id)
        result = await service.result(PARENT_ID, session.session_id)

        self.assertEqual(abandoned.status, "ABANDONED")
        self.assertEqual(repeated.status, "ABANDONED")
        self.assertIsNotNone(first_end_time)
        self.assertEqual(game_session.CompletedAt, first_end_time)
        self.assertEqual(
            result.duration_seconds,
            int((first_end_time - game_session.StartedAt).total_seconds()),
        )

    async def test_parent_cannot_start_for_another_parents_child(self):
        service, _ = self.make_service()

        with self.assertRaises(HTTPException) as error:
            await service.list_books(PARENT_ID, OTHER_CHILD_ID, "easy")
        self.assertEqual(error.exception.status_code, 404)


def make_api_client(actor_id: UUID = PARENT_ID) -> TestClient:
    app = FastAPI()
    app.include_router(
        sentence_shooter_routes.router,
        prefix="/games/sentence-shooter",
    )

    async def fake_db():
        return object()

    app.dependency_overrides[get_db] = fake_db
    app.dependency_overrides[get_current_parent_id] = lambda: actor_id
    return TestClient(app)


class SentenceShooterApiTests(unittest.TestCase):
    def test_create_session_api_does_not_expose_expected_token_order(self):
        service = SentenceShooterService(FakeSentenceShooterRepository())
        with patch.object(
            sentence_shooter_routes,
            "build_service",
            return_value=service,
        ):
            with make_api_client() as client:
                response = client.post(
                    "/games/sentence-shooter/sessions",
                    json={
                        "child_id": str(CHILD_ID),
                        "book_id": str(BOOK_ID),
                        "difficulty": "easy",
                        "total_rounds": 2,
                    },
                )

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["round"]["token_count"], 4)
        self.assertNotIn("expected_token_ids", body["round"])
        self.assertNotIn("sentence", body)

    def test_session_api_requires_the_existing_supabase_auth_dependency(self):
        app = FastAPI()
        app.include_router(
            sentence_shooter_routes.router,
            prefix="/games/sentence-shooter",
        )

        async def fake_db():
            return object()

        app.dependency_overrides[get_db] = fake_db
        with TestClient(app) as client:
            response = client.get(
                "/games/sentence-shooter/books",
                params={"child_id": str(CHILD_ID)},
            )

        self.assertEqual(response.status_code, 401)

    def test_repeated_and_concurrent_book_requests_remain_successful(self):
        class FakeBookListService:
            async def list_books(self, *_args, **_kwargs):
                await asyncio.sleep(0.005)
                return []

        service = FakeBookListService()

        def request_books(_index):
            with make_api_client() as client:
                return client.get(
                    "/games/sentence-shooter/books",
                    params={
                        "child_id": str(CHILD_ID),
                        "difficulty": "easy",
                        "total_rounds": "3",
                    },
                )

        with patch.object(
            sentence_shooter_routes,
            "build_service",
            return_value=service,
        ):
            with ThreadPoolExecutor(max_workers=8) as executor:
                responses = list(executor.map(request_books, range(16)))

        self.assertEqual(len(responses), 16)
        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertTrue(all(response.json() == [] for response in responses))

    def test_concurrent_session_creation_preserves_api_contract(self):
        repository = FakeSentenceShooterRepository()
        service = SentenceShooterService(repository)

        def create_session(_index):
            with make_api_client() as client:
                return client.post(
                    "/games/sentence-shooter/sessions",
                    json={
                        "child_id": str(CHILD_ID),
                        "book_id": str(BOOK_ID),
                        "difficulty": "easy",
                        "total_rounds": 2,
                    },
                )

        with patch.object(
            sentence_shooter_routes,
            "build_service",
            return_value=service,
        ):
            with ThreadPoolExecutor(max_workers=8) as executor:
                responses = list(executor.map(create_session, range(16)))

        self.assertEqual(len(responses), 16)
        self.assertTrue(all(response.status_code == 201 for response in responses))
        self.assertEqual(
            len({response.json()["session_id"] for response in responses}),
            16,
        )
        self.assertEqual(len(repository.sessions), 16)


class SentenceShooterRepositoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_owned_child_returns_scalar_projection_not_expirable_orm_entity(self):
        class Result:
            def one_or_none(self):
                return SimpleNamespace(Id=CHILD_ID, Grade=2)

        class FakeDatabase:
            def __init__(self):
                self.statement = None
                self.rollback_calls = 0

            async def execute(self, statement):
                self.statement = statement
                return Result()

            async def rollback(self):
                self.rollback_calls += 1

        db = FakeDatabase()
        child = await SentenceShooterRepository(db).child_owned_by(
            CHILD_ID,
            PARENT_ID,
        )
        await db.rollback()

        self.assertEqual(child.Id, CHILD_ID)
        self.assertEqual(child.Grade, 2)
        self.assertNotIsInstance(child, ChildProfile)
        self.assertEqual(db.rollback_calls, 1)
        sql = str(db.statement.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("select childprofiles.id, childprofiles.grade", sql)
        self.assertIn("childprofiles.parentid", sql)

    async def test_book_for_session_returns_scalar_projection(self):
        class Result:
            def one_or_none(self):
                return SimpleNamespace(
                    Id=BOOK_ID,
                    Name="Story",
                    Title="Story",
                    Author="Author",
                    MinGrade=1,
                    MaxGrade=5,
                    LifecycleStatus="ACTIVE",
                )

        class FakeDatabase:
            async def execute(self, statement):
                self.statement = statement
                return Result()

        db = FakeDatabase()
        book = await SentenceShooterRepository(db).book_for_session(BOOK_ID)

        self.assertEqual(book.Id, BOOK_ID)
        self.assertEqual(book.MinGrade, 1)
        self.assertNotIsInstance(book, Book)
        sql = str(db.statement.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("select books.id, books.name", sql)
        self.assertIn("books.lifecyclestatus", sql)

    async def test_verified_word_query_selects_only_game_columns(self):
        from uuid import uuid4

        class Result:
            def __init__(self, rows):
                self._rows = rows

            def all(self):
                return self._rows

        book_id, page_id, revision_id, word_id = (uuid4() for _ in range(4))
        page_row = (
            book_id,
            "Story",
            "Story",
            "Author",
            1,
            5,
            "ACTIVE",
            page_id,
            book_id,
            1,
            revision_id,
            page_id,
            "VERIFIED",
            "BÃ© Ä‘ang Ä‘á»c sÃ¡ch.",
        )
        word_row = (word_id, revision_id, 0, 0, "BÃ©")

        class FakeDatabase:
            def __init__(self):
                self.statements = []
                self.rollback_calls = 0

            async def execute(self, statement):
                self.statements.append(statement)
                return Result([page_row] if len(self.statements) == 1 else [word_row])

            async def rollback(self):
                self.rollback_calls += 1

        db = FakeDatabase()
        rows = await SentenceShooterRepository(db).verified_word_rows(2)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0].Title, "Story")
        self.assertEqual(rows[0][1].PageNumber, 1)
        self.assertEqual(rows[0][2].VerificationStatus, "VERIFIED")
        self.assertEqual(rows[0][3].Text, "BÃ©")
        self.assertEqual(db.rollback_calls, 1)
        self.assertEqual(len(db.statements), 2)

        sql = "\n".join(str(statement) for statement in db.statements).lower()
        self.assertIn("currentverifiedrevisionid", sql)
        self.assertIn("verificationstatus", sql)
        self.assertIn("lifecyclestatus", sql)
        for unused_column in ("boundingbox", "ocrconfidence", "imagepath", "drafttext", "processingmeta"):
            self.assertNotIn(unused_column, sql)


class SentenceShooterLatencyBundleTests(unittest.IsolatedAsyncioTestCase):
    async def test_round_completion_bundles_next_round_and_idempotent_replay(self):
        repo = FakeSentenceShooterRepository()
        service = SentenceShooterService(repo)
        session = await service.create_session(
            PARENT_ID,
            SentenceShooterSessionCreate(
                child_id=CHILD_ID,
                book_id=BOOK_ID,
                difficulty="easy",
                total_rounds=2,
            ),
        )
        first_round = repo.rounds_by_session[0]
        last_request = uuid4()
        shot = None
        for idx, tok in enumerate(first_round.ExpectedTokenIds):
            req_id = last_request if idx == len(first_round.ExpectedTokenIds) - 1 else uuid4()
            shot = await service.shoot(PARENT_ID, session.session_id, first_round.Id, UUID(tok), req_id)

        assert shot is not None
        self.assertTrue(shot.round_completed)
        self.assertFalse(shot.session_completed)
        self.assertIsNotNone(shot.next_round)
        self.assertEqual(shot.next_round.round_number, 2)

        replay = await service.shoot(
            PARENT_ID,
            session.session_id,
            first_round.Id,
            UUID(first_round.ExpectedTokenIds[-1]),
            last_request,
        )
        self.assertIsNotNone(replay.next_round)
        self.assertEqual(replay.next_round.round_id, shot.next_round.round_id)

    async def test_load_shot_bundle_compiles_single_inner_join_lock_query(self):
        from sqlalchemy.dialects import postgresql

        class Result:
            def first(self):
                return None

        class FakeDatabase:
            def __init__(self):
                self.statement = None

            async def execute(self, statement):
                self.statement = statement
                return Result()

        db = FakeDatabase()
        res = await SentenceShooterRepository(db).load_shot_bundle(
            PARENT_ID, uuid4(), uuid4(), uuid4()
        )
        self.assertIsNone(res)
        sql = str(db.statement.compile(dialect=postgresql.dialect())).lower()
        self.assertIn("for update of gamesessions, gamerounds", sql)
        self.assertIn("duplicate_snapshot", sql)
        self.assertNotIn("left outer join", sql)
