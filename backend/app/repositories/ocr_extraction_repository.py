"""Database repository for PageOcrExtraction with nested-savepoint graceful fallback."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.book import Book, BookPage, PageRevision, PageRevisionWord
from app.models.profile import Profile
from app.models.smart_book_studio import PageOcrExtraction
from app.schemas.ocr_extraction import (
    CrossPageContextInput,
    DocumentBoundaryResult,
    ExtractedBlock,
    ExtractedWord,
    ExtractionStats,
    FilterMode,
    OcrWordInput,
    PageOcrExtractionResponse,
)

logger = logging.getLogger(__name__)


def _is_missing_table_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    orig = str(getattr(exc, "orig", "")).lower()
    combined = f"{msg} {orig}"
    return any(
        marker in combined
        for marker in (
            "undefinedtable",
            "does not exist",
            "no such table",
            "page_ocr_extractions",
        )
    )


def _coerce_bbox_list(raw_bbox: Any) -> list[float] | None:
    if isinstance(raw_bbox, (list, tuple)) and len(raw_bbox) == 4:
        try:
            vals = [float(v) for v in raw_bbox]
            if vals[2] > 0 and vals[3] > 0:
                return vals
        except (TypeError, ValueError):
            return None
    if isinstance(raw_bbox, dict):
        try:
            x = float(raw_bbox.get("x", raw_bbox.get("left", 0.0)))
            y = float(raw_bbox.get("y", raw_bbox.get("top", 0.0)))
            w = float(raw_bbox.get("w", raw_bbox.get("width", 0.0)))
            h = float(raw_bbox.get("h", raw_bbox.get("height", 0.0)))
            if w > 0 and h > 0:
                return [x, y, w, h]
        except (TypeError, ValueError):
            return None
    return None


class OcrExtractionRepository:
    """Persistence and read access for Intelligent OCR Content Extraction."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_active_actor_role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id, Profile.Active == 1)
        )

    async def get_book(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(
            select(Book).where(Book.Id == book_id, Book.IsDeleted.is_(False))
        )

    async def get_page_with_book(self, page_id: UUID) -> tuple[BookPage, Book] | None:
        row = (
            await self.db.execute(
                select(BookPage, Book)
                .join(Book, Book.Id == BookPage.BookId)
                .where(BookPage.Id == page_id, Book.IsDeleted.is_(False))
            )
        ).first()
        if row is None:
            return None
        return row[0], row[1]

    async def resolve_revision_for_page(
        self,
        page: BookPage,
        requested_revision_id: UUID | None = None,
    ) -> PageRevision | None:
        if requested_revision_id is not None:
            return await self.db.scalar(
                select(PageRevision).where(
                    PageRevision.Id == requested_revision_id,
                    PageRevision.PageId == page.Id,
                )
            )
        if page.CurrentVerifiedRevisionId is not None:
            rev = await self.db.scalar(
                select(PageRevision).where(
                    PageRevision.Id == page.CurrentVerifiedRevisionId,
                    PageRevision.PageId == page.Id,
                )
            )
            if rev is not None:
                return rev
        return await self.db.scalar(
            select(PageRevision)
            .where(PageRevision.PageId == page.Id)
            .order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc())
            .limit(1)
        )

    async def load_revision_words(self, revision_id: UUID) -> list[OcrWordInput]:
        rows = (
            await self.db.scalars(
                select(PageRevisionWord)
                .where(PageRevisionWord.PageRevisionId == revision_id)
                .order_by(PageRevisionWord.LineIndex.asc(), PageRevisionWord.WordIndex.asc())
            )
        ).all()
        words: list[OcrWordInput] = []
        for idx, row in enumerate(rows):
            bbox = _coerce_bbox_list(row.BoundingBox)
            if bbox is None or not (row.Text or "").strip():
                continue
            try:
                words.append(
                    OcrWordInput(
                        word_id=str(row.Id),
                        source_word_index=int(row.WordIndex) if row.WordIndex is not None else idx,
                        line_index=max(0, int(row.LineIndex or 0)),
                        text=row.Text,
                        bbox=bbox,
                        confidence=float(row.OCRConfidence)
                        if row.OCRConfidence is not None
                        else None,
                    )
                )
            except ValueError:
                continue
        return words

    async def load_sibling_cross_pages(
        self,
        book_id: UUID,
        exclude_page_id: UUID,
        *,
        limit: int = 60,
    ) -> list[CrossPageContextInput]:
        sibling_pages = (
            await self.db.scalars(
                select(BookPage)
                .where(BookPage.BookId == book_id, BookPage.Id != exclude_page_id)
                .order_by(BookPage.PageNumber.asc())
                .limit(limit)
            )
        ).all()

        results: list[CrossPageContextInput] = []
        for sp in sibling_pages:
            rev = await self.resolve_revision_for_page(sp)
            if rev is None:
                continue
            words = await self.load_revision_words(rev.Id)
            if words:
                results.append(
                    CrossPageContextInput(
                        page_number=max(1, int(sp.PageNumber)),
                        words=words,
                    )
                )
        return results

    async def get_latest_extraction(
        self, page_id: UUID
    ) -> tuple[PageOcrExtraction | None, bool]:
        """Return (row_or_none, storage_degraded). Uses nested savepoint for unmigrated DB safety."""
        try:
            async with self.db.begin_nested():
                row = await self.db.scalar(
                    select(PageOcrExtraction)
                    .where(PageOcrExtraction.BookPageId == page_id)
                    .order_by(PageOcrExtraction.UpdatedAt.desc(), PageOcrExtraction.Id.desc())
                    .limit(1)
                )
            return row, False
        except SQLAlchemyError as exc:
            if _is_missing_table_error(exc):
                logger.warning("page_ocr_extractions table unavailable; degrading gracefully")
                return None, True
            raise

    async def save_extraction(
        self,
        *,
        book_id: UUID,
        page_id: UUID,
        page_revision_id: UUID | None,
        owner_id: UUID | None,
        extraction: PageOcrExtractionResponse,
        source_words: list[OcrWordInput],
        undo_stack: list[list[dict[str, Any]]] | None = None,
        existing_row: PageOcrExtraction | None = None,
    ) -> tuple[PageOcrExtraction | None, bool]:
        """Persist extraction via nested savepoint. Returns (saved_row, storage_degraded)."""
        # DB check constraint permits 'shadow' | 'active'; preserve 'off' in stats metadata
        db_filter_mode = "active" if extraction.filter_mode == "active" else "shadow"
        stats_payload: dict[str, Any] = {
            "metrics": extraction.stats.model_dump(mode="json"),
            "effective_filter_mode": extraction.filter_mode,
            "canonical_words": [w.model_dump(mode="json") for w in extraction.canonical_words],
            "source_words": [w.model_dump(mode="json") for w in source_words],
            "undo_stack": undo_stack or [],
        }
        geometry_payload = (
            extraction.geometry_transform.model_dump(mode="json")
            if extraction.geometry_transform is not None
            else {}
        )
        blocks_payload = [b.model_dump(mode="json") for b in extraction.blocks]
        now = datetime.now(timezone.utc)

        try:
            async with self.db.begin_nested():
                if existing_row is not None:
                    row = existing_row
                    row.PageRevisionId = page_revision_id
                    row.OwnerId = owner_id
                    row.SourceHash = extraction.source_hash
                    row.AlgorithmVersion = extraction.algorithm_version
                    row.FilterMode = db_filter_mode
                    row.PageKind = extraction.page_kind
                    row.GeometryTransformJson = geometry_payload
                    row.BlocksJson = blocks_payload
                    row.CanonicalText = extraction.canonical_text
                    row.StatsJson = stats_payload
                    row.RequiresReview = extraction.requires_review
                    row.UpdatedAt = now
                else:
                    row = PageOcrExtraction(
                        BookId=book_id,
                        BookPageId=page_id,
                        PageRevisionId=page_revision_id,
                        OwnerId=owner_id,
                        SourceHash=extraction.source_hash,
                        AlgorithmVersion=extraction.algorithm_version,
                        FilterMode=db_filter_mode,
                        PageKind=extraction.page_kind,
                        GeometryTransformJson=geometry_payload,
                        BlocksJson=blocks_payload,
                        CanonicalText=extraction.canonical_text,
                        StatsJson=stats_payload,
                        RequiresReview=extraction.requires_review,
                        CreatedAt=now,
                        UpdatedAt=now,
                    )
                    self.db.add(row)
                await self.db.flush()
            return row, False
        except SQLAlchemyError as exc:
            if _is_missing_table_error(exc):
                logger.warning("page_ocr_extractions write skipped on unmigrated DB")
                return None, True
            raise

    @staticmethod
    def row_to_response(
        row: PageOcrExtraction,
    ) -> tuple[PageOcrExtractionResponse, list[OcrWordInput], list[list[dict[str, Any]]]]:
        """Hydrate API response, original source_words, and undo_stack from a persisted ORM row."""
        stats_blob = row.StatsJson if isinstance(row.StatsJson, dict) else {}
        metrics_dict = stats_blob.get("metrics") if isinstance(stats_blob.get("metrics"), dict) else {}
        stats = ExtractionStats.model_validate(metrics_dict)

        raw_mode = stats_blob.get("effective_filter_mode", row.FilterMode)
        effective_mode: FilterMode = (
            raw_mode if raw_mode in ("off", "shadow", "active") else "active"  # type: ignore[assignment]
        )

        geometry: DocumentBoundaryResult | None = None
        if isinstance(row.GeometryTransformJson, dict) and row.GeometryTransformJson:
            try:
                geometry = DocumentBoundaryResult.model_validate(row.GeometryTransformJson)
            except Exception:
                geometry = None

        blocks = [
            ExtractedBlock.model_validate(item)
            for item in (row.BlocksJson if isinstance(row.BlocksJson, list) else [])
        ]
        canonical_words = [
            ExtractedWord.model_validate(item)
            for item in (
                stats_blob.get("canonical_words")
                if isinstance(stats_blob.get("canonical_words"), list)
                else []
            )
        ]
        source_words = [
            OcrWordInput.model_validate(item)
            for item in (
                stats_blob.get("source_words")
                if isinstance(stats_blob.get("source_words"), list)
                else []
            )
        ]
        undo_stack = (
            stats_blob.get("undo_stack")
            if isinstance(stats_blob.get("undo_stack"), list)
            else []
        )

        response = PageOcrExtractionResponse(
            extraction_id=row.Id,
            book_id=row.BookId,
            book_page_id=row.BookPageId,
            page_revision_id=row.PageRevisionId,
            source_hash=row.SourceHash,
            algorithm_version=row.AlgorithmVersion,
            filter_mode=effective_mode,
            page_kind=row.PageKind,  # type: ignore[arg-type]
            geometry_transform=geometry,
            blocks=blocks,
            canonical_text=row.CanonicalText or "",
            canonical_words=canonical_words,
            stats=stats,
            requires_review=bool(row.RequiresReview),
            undo_available=len(undo_stack) > 0,
            undo_depth=len(undo_stack),
            persisted=True,
            storage_degraded=False,
            created_at=row.CreatedAt,
            updated_at=row.UpdatedAt,
        )
        return response, source_words, undo_stack
