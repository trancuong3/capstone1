from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    ChildProfile,
    GameAttempt,
    GameRound,
    GameSession,
    PageRevision,
    PageRevisionWord,
    Profile,
)
from app.repositories.book_repository import CatalogRepository


@dataclass(frozen=True, slots=True)
class _BookProjection:
    Id: UUID
    Name: str | None
    Title: str
    Author: str | None
    MinGrade: int
    MaxGrade: int
    LifecycleStatus: str


@dataclass(frozen=True, slots=True)
class _PageProjection:
    Id: UUID
    BookId: UUID
    PageNumber: int


@dataclass(frozen=True, slots=True)
class _RevisionProjection:
    Id: UUID
    PageId: UUID
    VerificationStatus: str
    VerifiedText: str | None


@dataclass(frozen=True, slots=True)
class _WordProjection:
    Id: UUID
    PageRevisionId: UUID
    LineIndex: int
    WordIndex: int
    Text: str


@dataclass(frozen=True, slots=True)
class _ChildProjection:
    Id: UUID
    Grade: int


class SentenceShooterRepository:
    """Database access for sentence-shooter sessions and verified book content."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def profile_role(self, profile_id: UUID) -> str | None:
        from app.database.role_cache import get_cached_profile_role
        return await get_cached_profile_role(self.db, profile_id)

    async def child_owned_by(
        self,
        child_id: UUID,
        parent_id: UUID,
    ) -> _ChildProjection | None:
        result = await self.db.execute(
            select(ChildProfile.Id, ChildProfile.Grade).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        row = result.one_or_none()
        if row is None:
            return None
        # Return scalars needed by the game, not an ORM entity that a later
        # rollback could expire and make trigger implicit async I/O.
        return _ChildProjection(Id=row.Id, Grade=row.Grade)

    async def book_for_session(self, book_id: UUID) -> _BookProjection | None:
        """Read only the book fields needed to classify an empty content result."""
        result = await self.db.execute(
            select(
                Book.Id,
                Book.Name,
                Book.Title,
                Book.Author,
                Book.MinGrade,
                Book.MaxGrade,
                Book.LifecycleStatus,
            ).where(Book.Id == book_id, CatalogRepository.eligible_book())
        )
        row = result.one_or_none()
        if row is None:
            return None
        return _BookProjection(
            Id=row.Id,
            Name=row.Name,
            Title=row.Title,
            Author=row.Author,
            MinGrade=row.MinGrade,
            MaxGrade=row.MaxGrade,
            LifecycleStatus=row.LifecycleStatus,
        )

    async def verified_word_rows(
        self,
        grade: int,
        book_id: UUID | None = None,
    ) -> list[tuple[_BookProjection, _PageProjection, _RevisionProjection, _WordProjection]]:
        """Load only game fields, avoiding ORM entities and duplicated page text.

        Page metadata and word geometry are fetched separately. The old joined
        entity query repeated VerifiedText, image metadata, OCR boxes and other
        unused columns for every word, then globally sorted that expanded rowset.
        """
        page_query = (
            select(
                Book.Id,
                Book.Name,
                Book.Title,
                Book.Author,
                Book.MinGrade,
                Book.MaxGrade,
                Book.LifecycleStatus,
                BookPage.Id,
                BookPage.BookId,
                BookPage.PageNumber,
                PageRevision.Id,
                PageRevision.PageId,
                PageRevision.VerificationStatus,
                PageRevision.VerifiedText,
            )
            .join(BookPage, BookPage.BookId == Book.Id)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                Book.LifecycleStatus == "ACTIVE",
                Book.MinGrade <= grade,
                Book.MaxGrade >= grade,
                BookPage.LifecycleStatus == "ACTIVE",
                PageRevision.PageId == BookPage.Id,
                PageRevision.VerificationStatus == "VERIFIED",
                CatalogRepository.eligible_book(),
            )
            .order_by(Book.Id, BookPage.PageNumber, BookPage.Id)
        )
        if book_id is not None:
            page_query = page_query.where(Book.Id == book_id)

        page_result = await self.db.execute(page_query)
        page_rows = page_result.all()
        if not page_rows:
            await self.db.rollback()
            return []

        pages: dict[UUID, tuple[_BookProjection, _PageProjection, _RevisionProjection]] = {}
        revision_ids: list[UUID] = []
        for row in page_rows:
            book_id_value, name, title, author, min_grade, max_grade, lifecycle, page_id, page_book_id, page_number, revision_id, revision_page_id, verification, verified_text = row
            revision_ids.append(revision_id)
            pages[revision_id] = (
                _BookProjection(book_id_value, name, title, author, min_grade, max_grade, lifecycle),
                _PageProjection(page_id, page_book_id, page_number),
                _RevisionProjection(revision_id, revision_page_id, verification, verified_text),
            )

        word_rows = []
        # Stay below PostgreSQL's bind-parameter limit for large catalogs.
        # This is still a fixed number of batched queries, not one query per page.
        for start in range(0, len(revision_ids), 8_000):
            word_query = (
                select(
                    PageRevisionWord.Id,
                    PageRevisionWord.PageRevisionId,
                    PageRevisionWord.LineIndex,
                    PageRevisionWord.WordIndex,
                    PageRevisionWord.Text,
                )
                .where(
                    PageRevisionWord.PageRevisionId.in_(
                        revision_ids[start : start + 8_000]
                    )
                )
                .order_by(
                    PageRevisionWord.PageRevisionId,
                    PageRevisionWord.LineIndex,
                    PageRevisionWord.WordIndex,
                    PageRevisionWord.Id,
                )
            )
            word_result = await self.db.execute(word_query)
            word_rows.extend(word_result.all())

        # The rows are buffered; Python sorting and projection can now run
        # without holding a PostgreSQL connection or concurrency permit.
        await self.db.rollback()
        output = []
        for row in sorted(
            word_rows,
            key=lambda item: (item[1], item[2], item[3], item[0]),
        ):
            word_id, revision_id, line_index, word_index, text = row
            word = _WordProjection(word_id, revision_id, line_index, word_index, text)
            output.append((*pages[revision_id], word))

        return output

    async def book(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

    async def session_for_parent(
        self,
        session_id: UUID,
        parent_id: UUID,
        *,
        lock: bool = False,
    ) -> GameSession | None:
        query = (
            select(GameSession)
            .join(Book, Book.Id == GameSession.BookId)
            .join(ChildProfile, ChildProfile.Id == GameSession.ChildProfileId)
            .where(
                GameSession.Id == session_id,
                ChildProfile.ParentId == parent_id,
                CatalogRepository.eligible_book(),
            )
        )
        if lock:
            query = query.with_for_update(of=GameSession)
        return await self.db.scalar(query)

    async def game_round(
        self,
        session_id: UUID,
        round_id: UUID,
        *,
        lock: bool = False,
    ) -> GameRound | None:
        query = select(GameRound).where(
            GameRound.GameSessionId == session_id,
            GameRound.Id == round_id,
        )
        if lock:
            query = query.with_for_update()
        return await self.db.scalar(query)

    async def rounds(self, session_id: UUID) -> list[GameRound]:
        result = await self.db.execute(
            select(GameRound)
            .where(GameRound.GameSessionId == session_id)
            .order_by(GameRound.RoundNumber, GameRound.Id)
        )
        return list(result.scalars().all())

    async def next_round_for_number(
        self,
        session_id: UUID,
        round_number: int,
    ) -> GameRound | None:
        return await self.db.scalar(
            select(GameRound).where(
                GameRound.GameSessionId == session_id,
                GameRound.RoundNumber == round_number,
                GameRound.Status == "IN_PROGRESS",
            )
        )

    async def load_shot_bundle(
        self,
        actor_id: UUID,
        session_id: UUID,
        round_id: UUID,
        request_id: UUID,
    ) -> tuple[GameSession, GameRound, dict | None] | None:
        attempt_subquery = (
            select(GameAttempt.ResultSnapshot)
            .where(
                GameAttempt.GameSessionId == session_id,
                GameAttempt.RequestId == request_id,
            )
            .limit(1)
            .scalar_subquery()
        )
        row = (
            await self.db.execute(
                select(
                    GameSession,
                    GameRound,
                    attempt_subquery.label("duplicate_snapshot"),
                )
                .join(Book, Book.Id == GameSession.BookId)
                .join(ChildProfile, ChildProfile.Id == GameSession.ChildProfileId)
                .join(Profile, Profile.Id == ChildProfile.ParentId)
                .join(GameRound, GameRound.GameSessionId == GameSession.Id)
                .where(
                    Profile.Id == actor_id,
                    Profile.Role == "parent",
                    Profile.Active == 1,
                    GameSession.Id == session_id,
                    GameRound.Id == round_id,
                    CatalogRepository.eligible_book(),
                )
                .with_for_update(of=(GameSession, GameRound))
            )
        ).first()
        if row is None:
            return None
        return row[0], row[1], row[2]

    async def load_result_bundle(
        self,
        actor_id: UUID,
        session_id: UUID,
    ) -> tuple[GameSession, Book] | None:
        row = (
            await self.db.execute(
                select(GameSession, Book)
                .join(ChildProfile, ChildProfile.Id == GameSession.ChildProfileId)
                .join(Profile, Profile.Id == ChildProfile.ParentId)
                .join(Book, Book.Id == GameSession.BookId)
                .where(
                    Profile.Id == actor_id,
                    Profile.Role == "parent",
                    Profile.Active == 1,
                    GameSession.Id == session_id,
                    CatalogRepository.eligible_book(),
                )
            )
        ).first()
        return (row[0], row[1]) if row is not None else None

    async def attempt(
        self,
        session_id: UUID,
        request_id: UUID,
    ) -> GameAttempt | None:
        return await self.db.scalar(
            select(GameAttempt).where(
                GameAttempt.GameSessionId == session_id,
                GameAttempt.RequestId == request_id,
            )
        )

    def add(self, row: object) -> None:
        self.db.add(row)

    def add_all(self, rows: list[object]) -> None:
        self.db.add_all(rows)

    async def flush(self) -> None:
        await self.db.flush()

    async def commit(self) -> None:
        await self.db.commit()

    async def rollback(self) -> None:
        await self.db.rollback()
