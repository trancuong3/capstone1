from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import desc, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    ChildProfile,
    PageRevision,
    PictureDescriptionAttempt,
    PictureDescriptionSession,
    Profile,
)
from app.policies.book_access import is_book_private
from app.repositories.book_repository import CatalogRepository
from app.services.child_difficult_word_feed import (
    ChildDifficultWordFeed,
    DifficultWordTarget,
)


@dataclass(frozen=True, slots=True)
class ChildProjection:
    Id: UUID
    ParentId: UUID
    Grade: int
    Settings: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class BookPageCandidateProjection:
    BookId: UUID
    BookTitle: str
    PageId: UUID
    PageNumber: int
    ImagePath: str
    IsPrivateBook: bool = False
    VerifiedText: str = ""
    IllustrationPath: str | None = None
    IllustrationAssetId: UUID | None = None
    PageKind: str | None = None
    StyleBibleVocabulary: tuple[str, ...] = ()
    StyleBibleSummary: str | None = None


@dataclass(frozen=True, slots=True)
class SessionProjection:
    Id: UUID
    ChildProfileId: UUID
    ParentId: UUID
    BookId: UUID | None
    BookPageId: UUID | None
    SourceType: str
    SampleKey: str | None
    ImagePath: str
    ImageMimeType: str
    ChildGrade: int
    SceneTitle: str
    PromptPayload: dict[str, Any]
    Status: str
    BestStars: int
    BestScore: int
    AttemptsCount: int
    AiModelUsed: str | None
    CreatedAt: datetime
    UpdatedAt: datetime


@dataclass(frozen=True, slots=True)
class AttemptProjection:
    Id: UUID
    SessionId: UUID
    AttemptNumber: int
    InputMode: str
    TranscriptText: str
    ScoreOutOf10: int
    Stars: int
    FeedbackPayload: dict[str, Any]
    AiModelUsed: str | None
    CreatedAt: datetime


class PictureDescriptionRepository:
    """Database access for picture description sessions, attempts, and candidate book pages."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def profile_role(self, profile_id: UUID) -> str | None:
        from app.database.role_cache import get_cached_profile_role
        return await get_cached_profile_role(self.db, profile_id)

    async def child_owned_by(
        self,
        child_id: UUID,
        parent_id: UUID,
    ) -> ChildProjection | None:
        result = await self.db.execute(
            select(
                ChildProfile.Id,
                ChildProfile.ParentId,
                ChildProfile.Grade,
                ChildProfile.Settings,
            ).where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )
        row = result.one_or_none()
        if row is None:
            return None
        raw_settings = getattr(row, "Settings", None)
        return ChildProjection(
            Id=row.Id,
            ParentId=row.ParentId,
            Grade=row.Grade,
            Settings=dict(raw_settings) if isinstance(raw_settings, dict) else {},
        )

    async def list_difficult_word_targets(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        limit: int = 8,
    ) -> list[DifficultWordTarget]:
        return await ChildDifficultWordFeed(self.db).list_targets(
            child_id,
            parent_id,
            limit=limit,
        )

    async def _enrich_candidates_with_studio_v2(
        self,
        candidates: list[BookPageCandidateProjection],
    ) -> list[BookPageCandidateProjection]:
        if not candidates or not callable(getattr(self.db, "begin_nested", None)):
            return candidates
        page_ids = [c.PageId for c in candidates]
        book_ids = list({c.BookId for c in candidates})
        ill_by_page: dict[UUID, tuple[UUID, str]] = {}
        kind_by_page: dict[UUID, str] = {}
        bible_by_book: dict[UUID, tuple[tuple[str, ...], str | None]] = {}
        try:
            from app.models.smart_book_studio import (
                BookPresentationAsset,
                BookStyleBible,
                PageOcrExtraction,
            )

            async with self.db.begin_nested():
                assets = (
                    await self.db.scalars(
                        select(BookPresentationAsset)
                        .where(
                            BookPresentationAsset.BookPageId.in_(page_ids),
                            BookPresentationAsset.AssetRole == "PAGE_ILLUSTRATION",
                            BookPresentationAsset.IsActive.is_(True),
                            BookPresentationAsset.ModerationStatus == "APPROVED",
                            BookPresentationAsset.TextFreeVerified.is_(True),
                        )
                        .order_by(
                            desc(BookPresentationAsset.AssetVersion),
                            desc(BookPresentationAsset.UpdatedAt),
                        )
                    )
                ).all()
                for asset in assets:
                    if asset.BookPageId and asset.BookPageId not in ill_by_page and asset.StoragePath:
                        ill_by_page[asset.BookPageId] = (asset.Id, str(asset.StoragePath))

                extractions = (
                    await self.db.scalars(
                        select(PageOcrExtraction)
                        .where(PageOcrExtraction.BookPageId.in_(page_ids))
                        .order_by(
                            desc(PageOcrExtraction.UpdatedAt),
                            desc(PageOcrExtraction.Id),
                        )
                    )
                ).all()
                for ext in extractions:
                    if ext.BookPageId not in kind_by_page and ext.PageKind:
                        kind_by_page[ext.BookPageId] = str(ext.PageKind)

                bibles = (
                    await self.db.scalars(
                        select(BookStyleBible).where(BookStyleBible.BookId.in_(book_ids))
                    )
                ).all()
                for b_row in bibles:
                    b_json = b_row.BibleJson if isinstance(b_row.BibleJson, dict) else {}
                    vocab: list[str] = []
                    for ch in b_json.get("characters") or []:
                        if isinstance(ch, dict) and str(ch.get("name") or "").strip():
                            vocab.append(str(ch["name"]).strip()[:40])
                    for st in b_json.get("settings") or []:
                        if str(st or "").strip():
                            vocab.append(str(st).strip()[:40])
                    mood = str(b_json.get("mood") or "").strip()
                    genre = str(b_json.get("genre") or "").strip()
                    summary = ", ".join(p for p in (genre, mood) if p) or None
                    bible_by_book[b_row.BookId] = (tuple(vocab[:6]), summary)
        except Exception:
            return candidates

        enriched: list[BookPageCandidateProjection] = []
        for c in candidates:
            ill = ill_by_page.get(c.PageId)
            bible_vocab, bible_summary = bible_by_book.get(c.BookId, ((), None))
            enriched.append(
                BookPageCandidateProjection(
                    BookId=c.BookId,
                    BookTitle=c.BookTitle,
                    PageId=c.PageId,
                    PageNumber=c.PageNumber,
                    ImagePath=c.ImagePath,
                    IsPrivateBook=c.IsPrivateBook,
                    VerifiedText=c.VerifiedText,
                    IllustrationPath=ill[1] if ill else None,
                    IllustrationAssetId=ill[0] if ill else None,
                    PageKind=kind_by_page.get(c.PageId),
                    StyleBibleVocabulary=bible_vocab,
                    StyleBibleSummary=bible_summary,
                )
            )
        return enriched

    async def list_book_pages_for_grade(
        self,
        grade: int,
        *,
        limit: int = 12,
        parent_id: UUID | None = None,
        preferred_book_id: UUID | None = None,
        preferred_page_id: UUID | None = None,
    ) -> list[BookPageCandidateProjection]:
        # Fetch a wider pool and interleave round-robin across books so a single
        # 20-page book never crowds out all other books for the child's grade.
        pool_limit = max(limit * 4, 48)
        visibility_clause = (
            CatalogRepository.readable_book(parent_id)
            if parent_id is not None
            else CatalogRepository.eligible_book()
        )
        query = (
            select(
                Book.Id,
                Book.Title,
                BookPage.Id,
                BookPage.PageNumber,
                BookPage.ImagePath,
                Book.VisibilityScope,
                Book.OwnerParentId,
                PageRevision.VerifiedText,
            )
            .join(BookPage, BookPage.BookId == Book.Id)
            .outerjoin(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                Book.LifecycleStatus == "ACTIVE",
                Book.MinGrade <= grade,
                Book.MaxGrade >= grade,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.ImagePath.is_not(None),
                BookPage.ImagePath != "",
                visibility_clause,
            )
            .order_by(Book.Title.asc(), BookPage.PageNumber.asc(), BookPage.Id.asc())
            .limit(pool_limit)
        )
        result = await self.db.execute(query)
        rows = list(result.all())

        # Ensure an explicitly linked book/page is included even if outside top pool_limit
        if (preferred_page_id is not None or preferred_book_id is not None) and len(rows) >= pool_limit:
            extra_q = (
                select(
                    Book.Id,
                    Book.Title,
                    BookPage.Id,
                    BookPage.PageNumber,
                    BookPage.ImagePath,
                    Book.VisibilityScope,
                    Book.OwnerParentId,
                    PageRevision.VerifiedText,
                )
                .join(BookPage, BookPage.BookId == Book.Id)
                .outerjoin(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                .where(
                    Book.LifecycleStatus == "ACTIVE",
                    Book.MinGrade <= grade,
                    Book.MaxGrade >= grade,
                    BookPage.LifecycleStatus == "ACTIVE",
                    BookPage.ImagePath.is_not(None),
                    BookPage.ImagePath != "",
                    visibility_clause,
                )
            )
            if preferred_page_id is not None:
                extra_q = extra_q.where(BookPage.Id == preferred_page_id)
            elif preferred_book_id is not None:
                extra_q = extra_q.where(Book.Id == preferred_book_id)
            extra_rows = (await self.db.execute(extra_q.limit(6))).all()
            seen_pids = {r[2] for r in rows}
            for er in extra_rows:
                if er[2] not in seen_pids:
                    rows.insert(0, er)
                    seen_pids.add(er[2])

        raw_candidates: list[BookPageCandidateProjection] = []
        for row in rows:
            is_priv = str(row[5] or "") == "PARENT_PRIVATE" or row[6] is not None
            raw_candidates.append(
                BookPageCandidateProjection(
                    BookId=row[0],
                    BookTitle=row[1],
                    PageId=row[2],
                    PageNumber=row[3],
                    ImagePath=row[4],
                    IsPrivateBook=is_priv,
                    VerifiedText=str(row[7] or ""),
                )
            )
        enriched_all = await self._enrich_candidates_with_studio_v2(raw_candidates)
        await self.db.rollback()

        pinned: list[BookPageCandidateProjection] = []
        rest: list[BookPageCandidateProjection] = []
        for cand in enriched_all:
            if (preferred_page_id is not None and cand.PageId == preferred_page_id) or (
                preferred_book_id is not None and cand.BookId == preferred_book_id
            ):
                pinned.append(cand)
            else:
                rest.append(cand)
        pinned.sort(
            key=lambda c: (
                0 if preferred_page_id is not None and c.PageId == preferred_page_id else 1,
                0 if c.IllustrationPath else 1,
                c.PageNumber,
            )
        )

        by_book: dict[UUID, list[BookPageCandidateProjection]] = {}
        book_order: list[UUID] = []
        for candidate in rest:
            if candidate.BookId not in by_book:
                by_book[candidate.BookId] = []
                book_order.append(candidate.BookId)
            by_book[candidate.BookId].append(candidate)

        diversified: list[BookPageCandidateProjection] = list(pinned[:limit])
        round_idx = 0
        while len(diversified) < limit and book_order:
            progressed = False
            for book_id in book_order:
                bucket = by_book[book_id]
                if round_idx < len(bucket):
                    diversified.append(bucket[round_idx])
                    progressed = True
                    if len(diversified) >= limit:
                        break
            if not progressed:
                break
            round_idx += 1
        return diversified

    async def get_book_page_for_grade(
        self,
        page_id: UUID | None,
        grade: int,
        *,
        parent_id: UUID | None = None,
        fallback_book_id: UUID | None = None,
    ) -> BookPageCandidateProjection | None:
        if page_id is None and fallback_book_id is None:
            return None
        visibility_clause = (
            CatalogRepository.readable_book(parent_id)
            if parent_id is not None
            else CatalogRepository.eligible_book()
        )
        query = (
            select(
                Book.Id,
                Book.Title,
                BookPage.Id,
                BookPage.PageNumber,
                BookPage.ImagePath,
                Book.VisibilityScope,
                Book.OwnerParentId,
                PageRevision.VerifiedText,
            )
            .join(BookPage, BookPage.BookId == Book.Id)
            .outerjoin(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                Book.LifecycleStatus == "ACTIVE",
                Book.MinGrade <= grade,
                Book.MaxGrade >= grade,
                BookPage.LifecycleStatus == "ACTIVE",
                BookPage.ImagePath.is_not(None),
                BookPage.ImagePath != "",
                visibility_clause,
            )
        )
        if page_id is not None:
            query = query.where(BookPage.Id == page_id)
        else:
            query = query.where(Book.Id == fallback_book_id).order_by(
                BookPage.PageNumber.asc(), BookPage.Id.asc()
            )
        result = await self.db.execute(query.limit(6))
        rows = result.all()
        if not rows:
            return None
        raw = [
            BookPageCandidateProjection(
                BookId=r[0],
                BookTitle=r[1],
                PageId=r[2],
                PageNumber=r[3],
                ImagePath=r[4],
                IsPrivateBook=str(r[5] or "") == "PARENT_PRIVATE" or r[6] is not None,
                VerifiedText=str(r[7] or ""),
            )
            for r in rows
        ]
        enriched = await self._enrich_candidates_with_studio_v2(raw)
        if page_id is not None:
            return enriched[0]
        # Prefer first page that has a verified text-free PAGE_ILLUSTRATION
        for item in enriched:
            if item.IllustrationPath:
                return item
        return enriched[0]

    @staticmethod
    def _to_session_projection(row: Any) -> SessionProjection:
        return SessionProjection(
            Id=row.Id,
            ChildProfileId=row.ChildProfileId,
            ParentId=row.ParentId,
            BookId=row.BookId,
            BookPageId=row.BookPageId,
            SourceType=row.SourceType,
            SampleKey=row.SampleKey,
            ImagePath=row.ImagePath,
            ImageMimeType=row.ImageMimeType,
            ChildGrade=row.ChildGrade,
            SceneTitle=row.SceneTitle,
            PromptPayload=dict(row.PromptPayload or {}),
            Status=row.Status,
            BestStars=row.BestStars,
            BestScore=row.BestScore,
            AttemptsCount=row.AttemptsCount,
            AiModelUsed=row.AiModelUsed,
            CreatedAt=row.CreatedAt,
            UpdatedAt=row.UpdatedAt,
        )

    @staticmethod
    def _to_attempt_projection(row: Any) -> AttemptProjection:
        return AttemptProjection(
            Id=row.Id,
            SessionId=row.SessionId,
            AttemptNumber=row.AttemptNumber,
            InputMode=row.InputMode,
            TranscriptText=row.TranscriptText,
            ScoreOutOf10=row.ScoreOutOf10,
            Stars=row.Stars,
            FeedbackPayload=dict(row.FeedbackPayload or {}),
            AiModelUsed=row.AiModelUsed,
            CreatedAt=row.CreatedAt,
        )

    async def get_owned_session_projection(
        self,
        session_id: UUID,
        parent_id: UUID,
    ) -> SessionProjection | None:
        query = (
            select(PictureDescriptionSession)
            .join(
                ChildProfile,
                ChildProfile.Id == PictureDescriptionSession.ChildProfileId,
            )
            .where(
                PictureDescriptionSession.Id == session_id,
                PictureDescriptionSession.ParentId == parent_id,
                ChildProfile.ParentId == parent_id,
                or_(
                    PictureDescriptionSession.BookId.is_(None),
                    exists(
                        select(Book.Id).where(
                            Book.Id == PictureDescriptionSession.BookId,
                            CatalogRepository.readable_book(parent_id),
                        )
                    ),
                ),
            )
        )
        session = await self.db.scalar(query)
        if session is None:
            return None
        return self._to_session_projection(session)

    async def list_attempts(self, session_id: UUID) -> list[AttemptProjection]:
        query = (
            select(PictureDescriptionAttempt)
            .where(PictureDescriptionAttempt.SessionId == session_id)
            .order_by(desc(PictureDescriptionAttempt.AttemptNumber))
        )
        result = await self.db.scalars(query)
        return [self._to_attempt_projection(row) for row in result.all()]

    async def list_child_sessions(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        limit: int = 12,
    ) -> list[SessionProjection]:
        query = (
            select(PictureDescriptionSession)
            .join(
                ChildProfile,
                ChildProfile.Id == PictureDescriptionSession.ChildProfileId,
            )
            .where(
                PictureDescriptionSession.ChildProfileId == child_id,
                PictureDescriptionSession.ParentId == parent_id,
                ChildProfile.ParentId == parent_id,
                or_(
                    PictureDescriptionSession.BookId.is_(None),
                    exists(
                        select(Book.Id).where(
                            Book.Id == PictureDescriptionSession.BookId,
                            CatalogRepository.readable_book(parent_id),
                        )
                    ),
                ),
            )
            .order_by(desc(PictureDescriptionSession.UpdatedAt))
            .limit(limit)
        )
        result = await self.db.scalars(query)
        rows = [self._to_session_projection(row) for row in result.all()]
        await self.db.rollback()
        return rows

    async def create_session(
        self,
        session: PictureDescriptionSession,
    ) -> SessionProjection:
        self.db.add(session)
        await self.db.flush()
        await self.db.refresh(session)
        projection = self._to_session_projection(session)
        await self.db.commit()
        return projection

    async def save_attempt_and_update_session(
        self,
        *,
        session_id: UUID,
        parent_id: UUID,
        attempt: PictureDescriptionAttempt,
        new_best_stars: int,
        new_best_score: int,
        new_attempts_count: int,
        new_status: str,
        updated_at: datetime,
    ) -> tuple[SessionProjection, AttemptProjection]:
        session_obj = await self.db.scalar(
            select(PictureDescriptionSession)
            .join(
                ChildProfile,
                ChildProfile.Id == PictureDescriptionSession.ChildProfileId,
            )
            .where(
                PictureDescriptionSession.Id == session_id,
                PictureDescriptionSession.ParentId == parent_id,
                ChildProfile.ParentId == parent_id,
                or_(
                    PictureDescriptionSession.BookId.is_(None),
                    exists(
                        select(Book.Id).where(
                            Book.Id == PictureDescriptionSession.BookId,
                            CatalogRepository.readable_book(parent_id),
                        )
                    ),
                ),
            )
            .with_for_update(of=PictureDescriptionSession)
        )
        if session_obj is None:
            raise LookupError("Session not found")

        attempt.AttemptNumber = int(session_obj.AttemptsCount) + 1
        session_obj.AttemptsCount = attempt.AttemptNumber
        session_obj.BestStars = max(int(session_obj.BestStars), new_best_stars)
        session_obj.BestScore = max(int(session_obj.BestScore), new_best_score)
        if session_obj.Status == "COMPLETED" or new_status == "COMPLETED":
            session_obj.Status = "COMPLETED"
        else:
            session_obj.Status = new_status
        session_obj.UpdatedAt = updated_at

        self.db.add(attempt)
        await self.db.flush()
        await self.db.refresh(session_obj)
        await self.db.refresh(attempt)
        session_projection = self._to_session_projection(session_obj)
        attempt_projection = self._to_attempt_projection(attempt)
        await self.db.commit()
        return session_projection, attempt_projection
